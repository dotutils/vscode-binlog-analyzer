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
    /** For project nodes: full path of the project file */
    projectFile?: string;
    /** For project nodes: project id from MCP */
    projectId?: string;
}

export class BinlogTreeDataProvider implements vscode.TreeDataProvider<BinlogTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BinlogTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private binlogPaths: string[] = [];
    private mcpClient: McpClient | null = null;
    private isLoading = false;

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

    setLoading(loading: boolean) {
        this.isLoading = loading;
        this._onDidChangeTreeData.fire(undefined);
    }

    setMcpClient(client: McpClient | null) {
        this.mcpClient = client;
        this.clearCache();
        this._onDidChangeTreeData.fire(undefined);
        if (client) {
            this.prefetch();
        }
    }

    refresh() {
        this.clearCache();
        this._onDidChangeTreeData.fire(undefined);
        if (this.mcpClient) {
            this.prefetch();
        }
    }

    /** Pre-fetch all data so tree expansion is instant */
    private async prefetch() {
        if (!this.mcpClient) { return; }
        const client = this.mcpClient;

        await vscode.window.withProgress(
            { location: { viewId: 'binlogExplorer' }, },
            async () => {
                const calls = [
                    { tool: 'list_projects', args: {}, cache: 'projects' as const },
                    { tool: 'get_diagnostics', args: {}, cache: 'diagnostics' as const },
                    { tool: 'get_expensive_targets', args: { top_number: 10 }, cache: 'targets' as const },
                    { tool: 'get_expensive_tasks', args: { top_number: 10 }, cache: 'tasks' as const },
                ];

                await Promise.allSettled(calls.map(async (c) => {
                    try {
                        const result = await client.callTool(c.tool, c.args);
                        const data = this.tryParseJson(result.text);
                        if (c.cache === 'projects') {
                            this.projectsCache = this.parseProjectData(data, result.text);
                        } else if (c.cache === 'diagnostics') {
                            this.parseDiagnosticsData(data);
                        } else if (c.cache === 'targets') {
                            this.targetsCache = this.parsePerfItems(result.text, 'flame');
                        } else if (c.cache === 'tasks') {
                            this.tasksCache = this.parsePerfItems(result.text, 'tools');
                        }
                    } catch {
                        // Non-fatal
                    }
                }));

                this._onDidChangeTreeData.fire(undefined);
            }
        );
    }

    private parseProjectData(data: unknown, text: string): TreeNodeData[] {
        const items: TreeNodeData[] = [];
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            for (const [id, proj] of Object.entries(data as Record<string, any>)) {
                const file = proj.projectFile || proj.ProjectFile || '';
                const targets = proj.entryTargets || {};
                const totalMs = Object.values(targets).reduce(
                    (sum: number, t: any) => sum + (t.durationMs || 0), 0
                );
                const targetNames = Object.values(targets)
                    .map((t: any) => t.targetName)
                    .join(', ');
                const filePath = String(file);
                const dirPath = this.extractDirectory(filePath);
                const timeStr = totalMs > 0 ? `${(totalMs / 1000).toFixed(1)}s` : '';
                const desc = dirPath
                    ? (timeStr ? `${dirPath}  ${timeStr}` : dirPath)
                    : (timeStr || undefined);
                items.push({
                    kind: 'project',
                    label: this.extractFileName(filePath),
                    description: desc,
                    tooltip: `${file}\nTargets: ${targetNames || 'none'}\nBuild time: ${timeStr || '0.0s'}\n\nClick to view project details`,
                    icon: 'package',
                    projectFile: String(file),
                    projectId: id,
                    command: {
                        command: 'binlog.openProjectDetails',
                        title: 'View Project Details',
                        arguments: [id, String(file), targets],
                    },
                });
            }
        }
        const seen = new Set<string>();
        return items.filter(i => {
            if (seen.has(i.label)) { return false; }
            seen.add(i.label);
            return true;
        });
    }

    private parseDiagnosticsData(data: unknown) {
        const errors: TreeNodeData[] = [];
        const warnings: TreeNodeData[] = [];
        if (data && typeof data === 'object') {
            const obj = data as Record<string, any>;
            const diagnostics = obj.diagnostics || [];
            if (Array.isArray(diagnostics)) {
                for (const d of diagnostics) {
                    const sev = d.severity || d.Severity || d.level || '';
                    const code = d.code || d.Code || '';
                    const msg = d.message || d.Message || d.text || '';
                    const file = d.file || d.File || d.projectFile || '';
                    const line = d.lineNumber || d.LineNumber || d.line || '';
                    const label = code ? `${code}: ${msg}` : String(msg);
                    const loc = file ? `${this.extractFileName(String(file))}${line ? ':' + line : ''}` : '';
                    const item: TreeNodeData = {
                        kind: 'diagnostic',
                        label: label.length > 120 ? label.substring(0, 117) + '...' : label,
                        description: loc,
                        tooltip: `${label}\n${file}${line ? ':' + line : ''}`,
                        icon: this.isError(sev) ? 'error' : 'warning',
                    };
                    if (this.isError(sev)) {
                        errors.push(item);
                    } else {
                        warnings.push(item);
                    }
                }
            }
        }
        this.errorsCache = errors;
        this.warningsCache = warnings;
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
        if (this.binlogPaths.length === 0 && !this.isLoading) {
            return [];
        }

        const items: BinlogTreeItem[] = [];

        if (this.isLoading && this.binlogPaths.length === 0) {
            // Show loading placeholder before binlog paths arrive
            const loading = new BinlogTreeItem(
                'Loading binlog...',
                vscode.TreeItemCollapsibleState.None
            );
            loading.nodeKind = 'loading';
            loading.iconPath = new vscode.ThemeIcon('sync~spin');
            items.push(loading);
            return items;
        }

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
            const projCount = this.projectsCache ? `(${this.projectsCache.length})` : '';
            const wsFolder = vscode.workspace.workspaceFolders?.[0]?.name;
            projectsNode.description = wsFolder
                ? `${projCount}  ⟵ ${wsFolder}`
                : projCount;
            if (wsFolder) {
                projectsNode.tooltip = `Workspace: ${vscode.workspace.workspaceFolders![0].uri.fsPath}`;
            }
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
        } else if (this.isLoading) {
            // MCP client not ready yet — show loading indicator
            const loading = new BinlogTreeItem(
                'Analyzing binlog...',
                vscode.TreeItemCollapsibleState.None
            );
            loading.nodeKind = 'loading';
            loading.iconPath = new vscode.ThemeIcon('sync~spin');
            items.push(loading);
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
            item.tooltip = `${p}\n\nClick to view build summary in editor`;
            item.iconPath = new vscode.ThemeIcon(i === 0 ? 'file-binary' : 'link');
            item.contextValue = 'binlogFile';
            item.command = {
                command: 'binlog.openInEditor',
                title: 'Open Summary',
                arguments: ['/summary', fileName],
            };
            return item;
        });
    }

    private async fetchProjects(): Promise<BinlogTreeItem[]> {
        if (this.projectsCache) {
            return this.projectsCache.map(d => this.dataToItem(d));
        }
        // Fallback if not prefetched
        return this.callMcpTool('list_projects', {}, 'root-projects', (text) => {
            const data = this.tryParseJson(text);
            this.projectsCache = this.parseProjectData(data, text);
            return this.projectsCache;
        });
    }

    private async fetchDiagnostics(severity: 'Error' | 'Warning'): Promise<BinlogTreeItem[]> {
        const cache = severity === 'Error' ? this.errorsCache : this.warningsCache;
        if (cache) {
            if (cache.length === 0) {
                return [this.makeInfoItem('None found', 'info')];
            }
            return cache.map(d => this.dataToItem(d));
        }
        // Fallback if not prefetched
        return this.callMcpTool('get_diagnostics', {}, severity === 'Error' ? 'root-errors' : 'root-warnings', (text) => {
            const data = this.tryParseJson(text);
            this.parseDiagnosticsData(data);
            const items = severity === 'Error' ? this.errorsCache! : this.warningsCache!;
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
        return this.callMcpTool('get_expensive_targets', { top_number: 10 }, 'perf-targets', (text) => {
            const items = this.parsePerfItems(text, 'flame');
            this.targetsCache = items;
            return items;
        });
    }

    private async fetchExpensiveTasks(): Promise<BinlogTreeItem[]> {
        if (this.tasksCache) {
            return this.tasksCache.map(d => this.dataToItem(d));
        }
        return this.callMcpTool('get_expensive_tasks', { top_number: 10 }, 'perf-tasks', (text) => {
            const items = this.parsePerfItems(text, 'tools');
            this.tasksCache = items;
            return items;
        });
    }

    private parsePerfItems(text: string, icon: string): TreeNodeData[] {
        const data = this.tryParseJson(text);
        const items: TreeNodeData[] = [];
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            // Format: { "TargetName": { executionCount, inclusiveDurationMs, ... }, ... }
            for (const [name, info] of Object.entries(data as Record<string, any>)) {
                const durationMs = info.inclusiveDurationMs || info.durationMs || info.exclusiveDurationMs || 0;
                const durStr = durationMs >= 1000
                    ? `${(durationMs / 1000).toFixed(1)}s`
                    : `${durationMs}ms`;
                const count = info.executionCount || 1;
                items.push({
                    kind: 'perf-item',
                    label: name,
                    description: `${durStr}${count > 1 ? ` (×${count})` : ''}`,
                    tooltip: `${name}\nDuration: ${durStr}\nExecutions: ${count}`,
                    icon,
                });
            }
        } else if (Array.isArray(data)) {
            for (const entry of data) {
                const name = entry.name || entry.Name || entry.target || entry.task || '';
                const dur = entry.duration || entry.Duration || entry.elapsed || '';
                items.push({
                    kind: 'perf-item',
                    label: String(name),
                    description: dur ? String(dur) : undefined,
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

        // Set workspace folder — suggest roots from binlog project paths
        const wsFolder = new BinlogTreeItem('Set workspace folder...', vscode.TreeItemCollapsibleState.None);
        wsFolder.nodeKind = 'action';
        wsFolder.command = { command: 'binlog.setWorkspaceFolder', title: 'Set Folder' };
        wsFolder.iconPath = new vscode.ThemeIcon('root-folder');
        actions.push(wsFolder);

        // Show "Fix all issues" only when there are errors or warnings
        if ((this.errorsCache && this.errorsCache.length > 0) ||
            (this.warningsCache && this.warningsCache.length > 0)) {
            const errorCount = this.errorsCache?.length || 0;
            const warnCount = this.warningsCache?.length || 0;
            const fix = new BinlogTreeItem('Fix all issues', vscode.TreeItemCollapsibleState.None);
            fix.nodeKind = 'action';
            fix.command = { command: 'binlog.fixAllIssues', title: 'Fix' };
            fix.iconPath = new vscode.ThemeIcon('sparkle');
            fix.description = `${errorCount} errors, ${warnCount} warnings`;
            actions.push(fix);
        }

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

    private extractDirectory(path: string): string {
        const parts = path.replace(/\\/g, '/').split('/');
        if (parts.length <= 1) { return ''; }
        parts.pop(); // remove filename
        // Show last 2-3 path segments to keep it readable
        const segments = parts.filter(Boolean);
        if (segments.length <= 3) { return segments.join('/'); }
        return '…/' + segments.slice(-3).join('/');
    }

    /** Get candidate workspace root folders from binlog project paths */
    getProjectRootCandidates(): string[] {
        if (!this.projectsCache) { return []; }
        const roots = new Map<string, number>();
        for (const proj of this.projectsCache) {
            const fullPath = proj.projectFile || '';
            if (!fullPath || fullPath.length < 4) { continue; }
            // Walk up to find likely repo roots (directories containing .sln, .git, src/)
            const normalized = fullPath.replace(/\\/g, '/');
            const parts = normalized.split('/');
            // Try several depths: 2, 3, 4 segments from root (e.g., C:/Users/x/msbuild)
            for (let depth = 2; depth <= Math.min(5, parts.length - 1); depth++) {
                const candidate = parts.slice(0, depth + 1).join('/');
                roots.set(candidate, (roots.get(candidate) || 0) + 1);
            }
        }
        // Sort by frequency (most projects share this root) and return unique
        return [...roots.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([path]) => path)
            .filter(p => p.length > 3)
            .slice(0, 10);
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
