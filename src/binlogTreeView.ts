import * as vscode from 'vscode';
import { McpClient } from './mcpClient';

/** Node types for the tree */
type NodeKind =
    | 'root-files'    // "Loaded Binlogs" section
    | 'binlog-file'   // individual binlog file
    | 'root-projects' // "Projects" section
    | 'project'       // individual project
    | 'root-errors'   // "Errors" section
    | 'diagnostic'    // individual error/warning
    | 'root-warnings' // "Warnings" section
    | 'root-perf'     // "Performance" section
    | 'perf-targets'  // "Slowest Targets" sub-section
    | 'perf-tasks'    // "Slowest Tasks" sub-section
    | 'perf-item'     // individual target/task
    | 'root-actions'  // "Actions" section
    | 'action'        // individual action
    | 'loading'       // loading placeholder
    | 'error'         // error placeholder
    | 'info';         // informational text

interface TreeNodeData {
    kind: NodeKind;
    label: string;
    description?: string;
    tooltip?: string;
    icon?: string;
    command?: vscode.Command;
    children?: TreeNodeData[];
}

export class BinlogTreeDataProvider implements vscode.TreeDataProvider<BinlogTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BinlogTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private binlogPaths: string[] = [];
    private mcpClient: McpClient | null = null;

    // Cached data from MCP calls
    private projectsCache: TreeNodeData[] | null = null;
    private errorsCache: TreeNodeData[] | null = null;
    private warningsCache: TreeNodeData[] | null = null;
    private targetsCache: TreeNodeData[] | null = null;
    private tasksCache: TreeNodeData[] | null = null;
    private loadingSet = new Set<NodeKind>();

    setBinlogPaths(paths: string[]) {
        this.binlogPaths = paths;
        this.clearCache();
        this._onDidChangeTreeData.fire(undefined);
    }

    setMcpClient(client: McpClient | null) {
        this.mcpClient = client;
        this.clearCache();
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh() {
        this.clearCache();
        this._onDidChangeTreeData.fire(undefined);
    }

    private clearCache() {
        this.projectsCache = null;
        this.errorsCache = null;
        this.warningsCache = null;
        this.targetsCache = null;
        this.tasksCache = null;
    }

    getTreeItem(element: BinlogTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        if (!element) {
            return this.getRootChildren();
        }
        return this.getNodeChildren(element);
    }

    private getRootChildren(): BinlogTreeItem[] {
        if (this.binlogPaths.length === 0) {
            return [];
        }

        const items: BinlogTreeItem[] = [];

        // Loaded binlogs section
        const filesNode = new BinlogTreeItem(
            `Loaded Binlogs (${this.binlogPaths.length})`,
            vscode.TreeItemCollapsibleState.Collapsed
        );
        filesNode.nodeKind = 'root-files';
        filesNode.iconPath = new vscode.ThemeIcon('file-binary');
        items.push(filesNode);

        if (this.mcpClient) {
            // Content sections — these lazy-load from MCP
            const projectsNode = new BinlogTreeItem(
                'Projects',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            projectsNode.nodeKind = 'root-projects';
            projectsNode.iconPath = new vscode.ThemeIcon('project');
            projectsNode.description = this.projectsCache
                ? `(${this.projectsCache.length})`
                : '';
            items.push(projectsNode);

            const errorsNode = new BinlogTreeItem(
                'Errors',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            errorsNode.nodeKind = 'root-errors';
            errorsNode.iconPath = new vscode.ThemeIcon('error');
            errorsNode.description = this.errorsCache
                ? `(${this.errorsCache.length})`
                : '';
            items.push(errorsNode);

            const warningsNode = new BinlogTreeItem(
                'Warnings',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            warningsNode.nodeKind = 'root-warnings';
            warningsNode.iconPath = new vscode.ThemeIcon('warning');
            warningsNode.description = this.warningsCache
                ? `(${this.warningsCache.length})`
                : '';
            items.push(warningsNode);

            const perfNode = new BinlogTreeItem(
                'Performance',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            perfNode.nodeKind = 'root-perf';
            perfNode.iconPath = new vscode.ThemeIcon('dashboard');
            items.push(perfNode);
        }

        // Actions section (always shown)
        const actionsNode = new BinlogTreeItem(
            'Actions',
            vscode.TreeItemCollapsibleState.Expanded
        );
        actionsNode.nodeKind = 'root-actions';
        actionsNode.iconPath = new vscode.ThemeIcon('rocket');
        items.push(actionsNode);

        return items;
    }

    private async getNodeChildren(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        switch (element.nodeKind) {
            case 'root-files':
                return this.getFileChildren();
            case 'root-projects':
                return this.fetchProjects();
            case 'root-errors':
                return this.fetchDiagnostics('Error');
            case 'root-warnings':
                return this.fetchDiagnostics('Warning');
            case 'root-perf':
                return this.getPerfChildren();
            case 'perf-targets':
                return this.fetchExpensiveTargets();
            case 'perf-tasks':
                return this.fetchExpensiveTasks();
            case 'root-actions':
                return this.getActionChildren();
            default:
                return [];
        }
    }

    private getFileChildren(): BinlogTreeItem[] {
        return this.binlogPaths.map((p, i) => {
            const fileName = p.split(/[/\\]/).pop() || p;
            const item = new BinlogTreeItem(fileName, vscode.TreeItemCollapsibleState.None);
            item.nodeKind = 'binlog-file';
            item.description = i === 0 ? 'primary' : 'attached';
            item.tooltip = p;
            item.iconPath = new vscode.ThemeIcon(i === 0 ? 'file-binary' : 'link');
            item.contextValue = 'binlogFile';
            return item;
        });
    }

    private async fetchProjects(): Promise<BinlogTreeItem[]> {
        if (this.projectsCache) {
            return this.projectsCache.map(d => this.dataToItem(d));
        }
        return this.callMcpTool('list_projects', {}, 'root-projects', (text) => {
            const data = this.tryParseJson(text);
            const items: TreeNodeData[] = [];
            if (Array.isArray(data)) {
                for (const proj of data) {
                    const name = proj.name || proj.projectFile || proj.Name || proj.ProjectFile || String(proj);
                    const duration = proj.duration || proj.Duration || proj.buildTime || '';
                    items.push({
                        kind: 'project',
                        label: this.extractFileName(String(name)),
                        description: duration ? `${duration}` : undefined,
                        tooltip: String(name),
                        icon: 'package',
                    });
                }
            } else if (typeof text === 'string' && text.trim()) {
                // Try line-by-line parsing for plain text responses
                for (const line of text.split('\n').filter(l => l.trim())) {
                    items.push({
                        kind: 'project',
                        label: this.extractFileName(line.trim()),
                        tooltip: line.trim(),
                        icon: 'package',
                    });
                }
            }
            this.projectsCache = items;
            return items;
        });
    }

    private async fetchDiagnostics(severity: 'Error' | 'Warning'): Promise<BinlogTreeItem[]> {
        const cache = severity === 'Error' ? this.errorsCache : this.warningsCache;
        if (cache) {
            return cache.map(d => this.dataToItem(d));
        }
        return this.callMcpTool('get_diagnostics', {}, severity === 'Error' ? 'root-errors' : 'root-warnings', (text) => {
            const data = this.tryParseJson(text);
            const items: TreeNodeData[] = [];
            if (Array.isArray(data)) {
                for (const d of data) {
                    const sev = d.severity || d.Severity || d.level || '';
                    if (severity === 'Error' && !this.isError(sev)) { continue; }
                    if (severity === 'Warning' && !this.isWarning(sev)) { continue; }
                    const code = d.code || d.Code || '';
                    const msg = d.message || d.Message || d.text || '';
                    const file = d.file || d.File || d.projectFile || '';
                    const line = d.lineNumber || d.LineNumber || d.line || '';
                    const label = code ? `${code}: ${msg}` : String(msg);
                    const loc = file ? `${this.extractFileName(String(file))}${line ? ':' + line : ''}` : '';
                    items.push({
                        kind: 'diagnostic',
                        label: label.length > 120 ? label.substring(0, 117) + '...' : label,
                        description: loc,
                        tooltip: `${label}\n${file}${line ? ':' + line : ''}`,
                        icon: severity === 'Error' ? 'error' : 'warning',
                    });
                }
            } else if (typeof text === 'string' && text.trim()) {
                for (const line of text.split('\n').filter(l => l.trim())) {
                    const isTarget = severity === 'Error'
                        ? /error/i.test(line)
                        : /warn/i.test(line);
                    if (isTarget || severity === 'Error') {
                        items.push({
                            kind: 'diagnostic',
                            label: line.trim().substring(0, 120),
                            icon: severity === 'Error' ? 'error' : 'warning',
                        });
                    }
                }
            }
            if (severity === 'Error') {
                this.errorsCache = items;
            } else {
                this.warningsCache = items;
            }
            return items;
        });
    }

    private getPerfChildren(): BinlogTreeItem[] {
        const targets = new BinlogTreeItem(
            'Slowest Targets',
            vscode.TreeItemCollapsibleState.Collapsed
        );
        targets.nodeKind = 'perf-targets';
        targets.iconPath = new vscode.ThemeIcon('flame');

        const tasks = new BinlogTreeItem(
            'Slowest Tasks',
            vscode.TreeItemCollapsibleState.Collapsed
        );
        tasks.nodeKind = 'perf-tasks';
        tasks.iconPath = new vscode.ThemeIcon('tools');

        return [targets, tasks];
    }

    private async fetchExpensiveTargets(): Promise<BinlogTreeItem[]> {
        if (this.targetsCache) {
            return this.targetsCache.map(d => this.dataToItem(d));
        }
        return this.callMcpTool('get_expensive_targets', { count: 10 }, 'perf-targets', (text) => {
            const items = this.parsePerfItems(text, 'flame');
            this.targetsCache = items;
            return items;
        });
    }

    private async fetchExpensiveTasks(): Promise<BinlogTreeItem[]> {
        if (this.tasksCache) {
            return this.tasksCache.map(d => this.dataToItem(d));
        }
        return this.callMcpTool('get_expensive_tasks', { count: 10 }, 'perf-tasks', (text) => {
            const items = this.parsePerfItems(text, 'tools');
            this.tasksCache = items;
            return items;
        });
    }

    private parsePerfItems(text: string, icon: string): TreeNodeData[] {
        const data = this.tryParseJson(text);
        const items: TreeNodeData[] = [];
        if (Array.isArray(data)) {
            for (const entry of data) {
                const name = entry.name || entry.Name || entry.target || entry.task || entry.Target || entry.Task || '';
                const dur = entry.duration || entry.Duration || entry.elapsed || entry.time || '';
                items.push({
                    kind: 'perf-item',
                    label: String(name),
                    description: dur ? String(dur) : undefined,
                    icon,
                });
            }
        } else if (typeof text === 'string' && text.trim()) {
            for (const line of text.split('\n').filter(l => l.trim())) {
                items.push({
                    kind: 'perf-item',
                    label: line.trim().substring(0, 100),
                    icon,
                });
            }
        }
        return items;
    }

    private getActionChildren(): BinlogTreeItem[] {
        const actions: BinlogTreeItem[] = [];

        const chat = new BinlogTreeItem('Ask @binlog in Copilot Chat', vscode.TreeItemCollapsibleState.None);
        chat.nodeKind = 'action';
        chat.command = { command: 'workbench.action.chat.open', title: 'Chat', arguments: ['@binlog '] };
        chat.iconPath = new vscode.ThemeIcon('comment-discussion');
        actions.push(chat);

        const add = new BinlogTreeItem('Add more binlogs...', vscode.TreeItemCollapsibleState.None);
        add.nodeKind = 'action';
        add.command = { command: 'binlog.addFile', title: 'Add' };
        add.iconPath = new vscode.ThemeIcon('add');
        actions.push(add);

        const refresh = new BinlogTreeItem('Refresh tree', vscode.TreeItemCollapsibleState.None);
        refresh.nodeKind = 'action';
        refresh.command = { command: 'binlog.refreshTree', title: 'Refresh' };
        refresh.iconPath = new vscode.ThemeIcon('refresh');
        actions.push(refresh);

        const folder = new BinlogTreeItem('Open project folder...', vscode.TreeItemCollapsibleState.None);
        folder.nodeKind = 'action';
        folder.command = { command: 'binlog.openProjectFolder', title: 'Folder' };
        folder.iconPath = new vscode.ThemeIcon('folder-opened');
        folder.description = 'cross-machine';
        actions.push(folder);

        return actions;
    }

    // --- MCP tool helper ---

    private async callMcpTool(
        toolName: string,
        args: Record<string, unknown>,
        parentKind: NodeKind,
        parser: (text: string) => TreeNodeData[]
    ): Promise<BinlogTreeItem[]> {
        if (!this.mcpClient) {
            return [this.makeInfoItem('MCP server not connected', 'info')];
        }

        if (this.loadingSet.has(parentKind)) {
            return [this.makeInfoItem('Loading...', 'loading')];
        }

        this.loadingSet.add(parentKind);
        try {
            const result = await this.mcpClient.callTool(toolName, args);
            this.loadingSet.delete(parentKind);
            const data = parser(result.text);
            // Update parent description with count
            this._onDidChangeTreeData.fire(undefined);
            if (data.length === 0) {
                return [this.makeInfoItem('None found', 'info')];
            }
            return data.map(d => this.dataToItem(d));
        } catch (err) {
            this.loadingSet.delete(parentKind);
            const msg = err instanceof Error ? err.message : String(err);
            return [this.makeInfoItem(`Error: ${msg.substring(0, 80)}`, 'error')];
        }
    }

    // --- Helpers ---

    private dataToItem(data: TreeNodeData): BinlogTreeItem {
        const item = new BinlogTreeItem(
            data.label,
            data.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        item.nodeKind = data.kind;
        if (data.description) { item.description = data.description; }
        if (data.tooltip) { item.tooltip = data.tooltip; }
        if (data.icon) { item.iconPath = new vscode.ThemeIcon(data.icon); }
        if (data.command) { item.command = data.command; }
        return item;
    }

    private makeInfoItem(text: string, kind: NodeKind): BinlogTreeItem {
        const item = new BinlogTreeItem(text, vscode.TreeItemCollapsibleState.None);
        item.nodeKind = kind;
        item.iconPath = new vscode.ThemeIcon(
            kind === 'error' ? 'error' : kind === 'loading' ? 'sync~spin' : 'info'
        );
        return item;
    }

    private tryParseJson(text: string): unknown {
        try {
            return JSON.parse(text);
        } catch {
            // Try to find JSON array/object in text
            const arrMatch = text.match(/\[[\s\S]*\]/);
            if (arrMatch) {
                try { return JSON.parse(arrMatch[0]); } catch { }
            }
            const objMatch = text.match(/\{[\s\S]*\}/);
            if (objMatch) {
                try { return JSON.parse(objMatch[0]); } catch { }
            }
            return null;
        }
    }

    private extractFileName(path: string): string {
        return path.split(/[/\\]/).pop() || path;
    }

    private isError(severity: string): boolean {
        return /error/i.test(String(severity));
    }

    private isWarning(severity: string): boolean {
        return /warn/i.test(String(severity));
    }
}

export class BinlogTreeItem extends vscode.TreeItem {
    nodeKind: NodeKind = 'info';
    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
        super(label, collapsibleState);
    }
}
