import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { McpClient } from './mcpClient';
import * as telemetry from './telemetry';

/** Node types for the tree */
type NodeKind =
    | 'root-files'    // "Loaded Binlogs" section
    | 'binlog-file'   // individual binlog file
    | 'root-projects' // "Projects" section
    | 'project'       // individual project
    | 'project-targets' // targets under a project (lazy)
    | 'target'        // individual target
    | 'target-tasks'  // tasks under a target (lazy)
    | 'task'          // individual task
    | 'message'       // individual message/detail
    | 'root-errors'   // "Errors" section
    | 'diagnostic'    // individual error/warning
    | 'root-warnings' // "Warnings" section
    | 'root-perf'     // "Performance" section
    | 'perf-targets'  // "Slowest Targets" sub-section
    | 'perf-tasks'    // "Slowest Tasks" sub-section
    | 'perf-analyzers' // "Executed Analyzers" sub-section
    | 'perf-item'     // individual target/task
    | 'root-properties' // "Properties" section
    | 'property-item'   // individual property
    | 'root-items'      // "Items" section
    | 'item-type'       // item type group (e.g. PackageReference)
    | 'item-entry'      // individual item entry
    | 'root-actions'  // "Actions" section
    | 'action'        // individual action
    | 'root-about'    // "About" section
    | 'about-item'    // individual about info item
    | 'about-mcp'     // "MCP Server" sub-section under About
    | 'mcp-item'      // individual MCP server info item
    | 'root-evaluations'  // "Evaluations" section header
    | 'evaluation'        // individual evaluation entry
    | 'eval-properties'   // "Properties" sub-node under an evaluation
    | 'eval-global-props' // "Global Properties" sub-node under an evaluation
    | 'eval-property'     // individual property value
    | 'root-search'   // "Search Results" section
    | 'search-result' // individual search result
    | 'action-item'   // standalone action (e.g. Load Binlog when no binlog loaded)
    | 'loading'       // loading placeholder
    | 'error'         // error placeholder
    | 'info';         // informational text

export interface AboutInfo {
    extensionVersion: string;
    mcpVersion: string | null;
    mcpToolPath: string | null;
    mcpLatestVersion: string | null;
    mcpUpdateAvailable: boolean;
    /** Paths to mcp.json files that define the server */
    mcpConfigPaths?: string[];
}

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
    /** For target nodes: target name */
    targetName?: string;
    /** For item type nodes: the item type name */
    itemType?: string;
    /** For evaluation nodes: evaluation id from MCP */
    evaluationId?: number;
}

export class BinlogTreeDataProvider implements vscode.TreeDataProvider<BinlogTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BinlogTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private binlogPaths: string[] = [];
    private mcpClient: McpClient | null = null;
    private searchResults: TreeNodeData[] | null = null;
    private searchQuery: string = '';
    private searchResultsHasMore: boolean = false;
    private _isLoading = false;
    private _isRestoring = false;

    // Cached data from MCP calls
    private projectsCache: TreeNodeData[] | null = null;
    private errorsCache: TreeNodeData[] | null = null;
    private warningsCache: TreeNodeData[] | null = null;
    private targetsCache: TreeNodeData[] | null = null;
    private tasksCache: TreeNodeData[] | null = null;
    private analyzersCache: TreeNodeData[] | null = null;
    private evaluationsCache: TreeNodeData[] | null = null;

    private loadingSet = new Set<NodeKind>();

    // About info
    private aboutInfo: AboutInfo = { extensionVersion: '', mcpVersion: null, mcpToolPath: null, mcpLatestVersion: null, mcpUpdateAvailable: false };

    setAboutInfo(info: AboutInfo) {
        this.aboutInfo = info;
        this._onDidChangeTreeData.fire(undefined);
    }

    setBinlogPaths(paths: string[]) {
        this.binlogPaths = paths;
        // When paths becomes empty, any pending "loading"/"restoring" state is
        // stale by definition — clear it so the tree renders the empty
        // (about-only) view instead of getting stuck on "Loading binlog...".
        if (paths.length === 0) {
            this._isLoading = false;
            this._isRestoring = false;
        }
        this.clearCache();
        this._onDidChangeTreeData.fire(undefined);
    }

    setLoading(loading: boolean) {
        this._isLoading = loading;
        this._onDidChangeTreeData.fire(undefined);
    }

    isLoading(): boolean {
        return this._isLoading;
    }

    setRestoring(restoring: boolean) {
        this._isRestoring = restoring;
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

    /** Fire tree change event without clearing caches (e.g. to update labels) */
    fireChanged() {
        this._onDidChangeTreeData.fire(undefined);
    }

    private _onDiagnosticsRaw = new vscode.EventEmitter<unknown>();
    /** Fires with raw MCP diagnostics data after prefetch — avoids duplicate MCP calls */
    readonly onDiagnosticsRaw = this._onDiagnosticsRaw.event;

    /** Pre-fetch all data so tree expansion is instant (runs silently in background) */
    private async prefetch() {
        if (!this.mcpClient) { return; }
        const client = this.mcpClient;

        const calls = [
            { tool: 'binlog_projects', args: {}, cache: 'projects' as const },
            { tool: 'binlog_errors', args: {}, cache: 'errors' as const },
            { tool: 'binlog_warnings', args: {}, cache: 'warnings' as const },
            { tool: 'binlog_expensive_targets', args: { top_number: 10 }, cache: 'targets' as const },
            { tool: 'binlog_expensive_tasks', args: { top_number: 10 }, cache: 'tasks' as const },
            { tool: 'binlog_expensive_analyzers', args: { limit: 10 }, cache: 'analyzers' as const },
        ];

        await Promise.allSettled(calls.map(async (c) => {
            try {
                const result = await client.callTool(c.tool, c.args);
                const data = this.tryParseJson(result.text);

                if (c.cache === 'projects') {
                    this.projectsCache = this.parseProjectData(data, result.text);
                } else if (c.cache === 'errors') {
                    this.parseDiagnosticsItems(data, 'error');
                } else if (c.cache === 'warnings') {
                    this.parseDiagnosticsItems(data, 'warning');
                } else if (c.cache === 'targets') {
                    this.targetsCache = this.parsePerfItems(result.text, 'flame');
                } else if (c.cache === 'tasks') {
                    this.tasksCache = this.parsePerfItems(result.text, 'tools');
                } else if (c.cache === 'analyzers') {
                    const parsed = this.parsePerfItems(result.text, 'microscope');
                    if (parsed.length > 0) {
                        this.analyzersCache = parsed;
                    }
                }
            } catch (err) {
                console.warn(`prefetch ${c.tool} FAILED: ${err}`);
            }
        }));

        // Fire diagnostics event after both errors and warnings are loaded
        this._onDiagnosticsRaw.fire({
            diagnostics: [
                ...(this.errorsCache || []).map(d => ({ ...d, severity: 'Error' })),
                ...(this.warningsCache || []).map(d => ({ ...d, severity: 'Warning' })),
            ]
        });

        this._onDidChangeTreeData.fire(undefined);
    }

    private parseProjectData(data: unknown, text: string): TreeNodeData[] {
        const items: TreeNodeData[] = [];

        if (Array.isArray(data)) {
            // BinlogInsights format: [{ fullPath, isLegacy }, ...]
            for (let i = 0; i < data.length; i++) {
                const proj = data[i];
                const file = proj.fullPath || proj.projectFile || '';
                const filePath = String(file);
                const dirPath = this.extractDirectory(filePath);
                items.push({
                    kind: 'project',
                    label: this.extractFileName(filePath),
                    description: dirPath || undefined,
                    tooltip: `${file}\n\nExpand to see targets, or click to view project details`,
                    icon: 'package',
                    projectFile: filePath,
                    projectId: String(i),
                    children: [], // marks as expandable
                    command: {
                        command: 'binlog.openProjectDetails',
                        title: 'View Project Details',
                        arguments: [String(i), filePath, {}],
                    },
                });
            }
        } else if (data && typeof data === 'object') {
            // baronfel format: { "id": { projectFile, entryTargets }, ... }
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
                    tooltip: `${file}\nTargets: ${targetNames || 'none'}\nBuild time: ${timeStr || '0.0s'}\n\nExpand to see targets`,
                    icon: 'package',
                    projectFile: String(file),
                    projectId: id,
                    children: [], // marks as expandable
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

    /** Parse diagnostics from BinlogInsights binlog_errors / binlog_warnings */
    private parseDiagnosticsItems(data: unknown, severity: 'error' | 'warning') {
        const items: TreeNodeData[] = [];
        const diagnostics = Array.isArray(data) ? data
            : (data && typeof data === 'object') ? (data as any).diagnostics || (data as any).errors || (data as any).warnings || []
            : [];

        if (Array.isArray(diagnostics)) {
            for (const d of diagnostics) {
                const code = d.code || d.Code || '';
                const msg = d.message || d.Message || d.text || '';
                const file = d.file || d.File || d.projectFile || '';
                const line = d.lineNumber || d.LineNumber || d.line || '';
                const col = d.columnNumber || d.ColumnNumber || d.column || 0;
                const label = code ? `${code}: ${msg}` : String(msg);
                const loc = file ? `${this.extractFileName(String(file))}${line ? ':' + line : ''}` : '';
                let command: vscode.Command | undefined;
                if (file) {
                    const lineNum = typeof line === 'number' ? line : parseInt(String(line), 10) || 0;
                    const colNum = typeof col === 'number' ? col : parseInt(String(col), 10) || 0;
                    command = this.makeOpenCommand(String(file), lineNum, colNum);
                }
                items.push({
                    kind: 'diagnostic',
                    label,
                    description: loc,
                    tooltip: `${label}\n${file}${line ? ':' + line : ''}`,
                    icon: severity === 'error' ? 'error' : 'warning',
                    projectFile: file,
                    command,
                });
            }
        }

        if (severity === 'error') {
            this.errorsCache = items;
        } else {
            this.warningsCache = items;
        }
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
                    const col = d.columnNumber || d.ColumnNumber || d.column || 0;
                    const label = code ? `${code}: ${msg}` : String(msg);
                    const loc = file ? `${this.extractFileName(String(file))}${line ? ':' + line : ''}` : '';
                    let command: vscode.Command | undefined;
                    if (file) {
                        const lineNum = typeof line === 'number' ? line : parseInt(String(line), 10) || 0;
                        const colNum = typeof col === 'number' ? col : parseInt(String(col), 10) || 0;
                        command = this.makeOpenCommand(String(file), lineNum, colNum);
                    }
                    const item: TreeNodeData = {
                        kind: 'diagnostic',
                        label,
                        description: loc,
                        tooltip: `${label}\n${file}${line ? ':' + line : ''}`,
                        icon: this.isError(sev) ? 'error' : 'warning',
                        command,
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
        this.analyzersCache = null;
        this.evaluationsCache = null;
        this.searchResults = null;
        this.searchQuery = '';
        this.searchResultsHasMore = false;
    }

    /** Set search results to display in tree */
    public setSearchResults(query: string, results: any[], hasMore: boolean = false): void {
        this.searchQuery = query;
        this.searchResultsHasMore = hasMore;
        this.searchResults = results.map((item: any) => {
            const msg = item.message || item.Message || '';
            const proj = item.projectFile || item.ProjectFile || '';
            const projName = this.extractFileName(proj);
            const target = item.targetName || item.TargetName || '';
            const task = item.taskName || item.TaskName || '';
            const nodeType = item.nodeType || item.NodeType || '';
            const ctx = [projName, target, task].filter(Boolean).join(' → ');

            // Try to extract a source file path and line number from the message
            // Pattern: "Source: C:\path with spaces\file.targets (25,5)"
            const sourceMatch = msg.match(/Source:\s*(.+)\s+\((\d+),\s*(\d+)\)/i)
                || msg.match(/((?:[A-Za-z]:\\|\/)\S.*?\.(?:targets|props|csproj|vbproj|fsproj|cs|vb|fs|xml))\s*\((\d+),\s*(\d+)\)/i);
            const filePath = item.file || item.File || (sourceMatch ? sourceMatch[1].trim() : '');
            const lineNum = item.lineNumber || item.LineNumber || (sourceMatch ? parseInt(sourceMatch[2], 10) : 0);
            const colNum = item.columnNumber || item.ColumnNumber || (sourceMatch ? parseInt(sourceMatch[3], 10) : 0);

            let command: vscode.Command | undefined;
            if (filePath) {
                command = this.makeOpenCommand(filePath, lineNum, colNum);
            }

            return {
                kind: 'search-result' as NodeKind,
                label: msg,
                description: ctx,
                tooltip: `[${nodeType}] ${ctx}\n\n${msg}` + (filePath ? `\n\n📂 Click to open: ${filePath}${lineNum > 0 ? `:${lineNum}` : ''}` : ''),
                icon: nodeType === 'Error' ? 'error' : nodeType === 'Warning' ? 'warning' : 'note',
                projectFile: proj,
                command,
            };
        });
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Clear search results */
    public clearSearchResults(): void {
        this.searchResults = null;
        this.searchQuery = '';
        this.searchResultsHasMore = false;
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Get the current search query */
    public getSearchQuery(): string {
        return this.searchQuery;
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
        if (this.binlogPaths.length === 0 && !this._isLoading && !this._isRestoring) {
            return this.getAboutOnlyRoot();
        }

        const items: BinlogTreeItem[] = [];

        if (this._isRestoring && this.binlogPaths.length === 0) {
            const restoring = new BinlogTreeItem(
                'Restoring previous session…',
                vscode.TreeItemCollapsibleState.None
            );
            restoring.nodeKind = 'loading';
            restoring.iconPath = new vscode.ThemeIcon('sync~spin');
            items.push(restoring);
            return items;
        }

        if (this._isLoading && this.binlogPaths.length === 0) {
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

        // Search results section (shown at top when results exist)
        if (this.searchResults !== null) {
            const searchNode = new BinlogTreeItem(
                `Search Results`,
                vscode.TreeItemCollapsibleState.Expanded
            );
            searchNode.nodeKind = 'root-search';
            searchNode.iconPath = new vscode.ThemeIcon('search');
            searchNode.description = `"${this.searchQuery}" (${this.searchResults.length} results)`;
            items.unshift(searchNode);
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
                'Projects (Build)',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            projectsNode.nodeKind = 'root-projects';
            projectsNode.iconPath = new vscode.ThemeIcon('project');
            const projCount = this.projectsCache ? `(${this.projectsCache.length})` : '';

            // Show source context: workspace folder if it matches binlog, otherwise binlog's parent dir
            const path = require('path');
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            const binlogDir = this.binlogPaths.length > 0 ? path.dirname(this.binlogPaths[0]) : '';
            let sourceLabel = '';
            let sourceTooltip = '';

            if (wsFolder) {
                const wsPath = wsFolder.uri.fsPath.toLowerCase();
                const binlogDirLower = binlogDir.toLowerCase();
                if (binlogDirLower.startsWith(wsPath) || wsPath.startsWith(binlogDirLower)) {
                    sourceLabel = wsFolder.name;
                    sourceTooltip = `Workspace: ${wsFolder.uri.fsPath}`;
                } else {
                    sourceLabel = path.basename(binlogDir);
                    sourceTooltip = `Binlog source: ${binlogDir}`;
                }
            } else if (binlogDir) {
                sourceLabel = path.basename(binlogDir);
                sourceTooltip = `Binlog source: ${binlogDir}`;
            }

            projectsNode.description = sourceLabel
                ? `${projCount}  ⟵ ${sourceLabel}`
                : projCount;
            if (sourceTooltip) {
                projectsNode.tooltip = sourceTooltip;
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
            errorsNode.contextValue = 'errorsRoot';
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
            warningsNode.contextValue = 'warningsRoot';
            items.push(warningsNode);

            const evalNode = new BinlogTreeItem(
                'Evaluations',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            evalNode.nodeKind = 'root-evaluations';
            evalNode.iconPath = new vscode.ThemeIcon('library');
            if (this.evaluationsCache) {
                evalNode.description = `(${this.evaluationsCache.length})`;
            }
            items.push(evalNode);

            const perfNode = new BinlogTreeItem(
                'Performance',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            perfNode.nodeKind = 'root-perf';
            perfNode.iconPath = new vscode.ThemeIcon('dashboard');
            items.push(perfNode);
        } else if (this._isLoading) {
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

        // About section (always shown)
        const aboutNode = new BinlogTreeItem(
            'About',
            vscode.TreeItemCollapsibleState.Collapsed
        );
        aboutNode.nodeKind = 'root-about';
        aboutNode.iconPath = new vscode.ThemeIcon('info');
        aboutNode.contextValue = 'aboutRoot';
        const extVer = this.aboutInfo.extensionVersion ? `v${this.aboutInfo.extensionVersion}` : '';
        const mcpVer = this.aboutInfo.mcpVersion ? `MCP v${this.aboutInfo.mcpVersion}` : '';
        aboutNode.description = [extVer, mcpVer].filter(Boolean).join(' · ') || undefined;
        items.push(aboutNode);

        return items;
    }

    /** When no binlog is loaded, return empty to show viewsWelcome buttons. */
    /** When no binlog is loaded, show welcome actions + About. */
    private getAboutOnlyRoot(): BinlogTreeItem[] {
        const items: BinlogTreeItem[] = [];

        const loadItem = new BinlogTreeItem('Load Binlog File', vscode.TreeItemCollapsibleState.None);
        loadItem.nodeKind = 'action-item';
        loadItem.iconPath = new vscode.ThemeIcon('folder-opened');
        loadItem.command = { command: 'binlog.loadFile', title: 'Load Binlog File' };
        items.push(loadItem);

        const buildItem = new BinlogTreeItem('Build & Collect Binlog', vscode.TreeItemCollapsibleState.None);
        buildItem.nodeKind = 'action-item';
        buildItem.iconPath = new vscode.ThemeIcon('tools');
        buildItem.command = { command: 'binlog.buildAndCollect', title: 'Build & Collect Binlog' };
        items.push(buildItem);

        const ciItem = new BinlogTreeItem('Download from CI/CD...', vscode.TreeItemCollapsibleState.None);
        ciItem.nodeKind = 'action-item';
        ciItem.iconPath = new vscode.ThemeIcon('cloud-download');
        ciItem.command = { command: 'binlog.downloadFromCi', title: 'Download from CI/CD' };
        items.push(ciItem);

        const aboutNode = new BinlogTreeItem('About', vscode.TreeItemCollapsibleState.Collapsed);
        aboutNode.nodeKind = 'root-about';
        aboutNode.iconPath = new vscode.ThemeIcon('info');
        aboutNode.contextValue = 'aboutRoot';
        const extVer = this.aboutInfo.extensionVersion ? `v${this.aboutInfo.extensionVersion}` : '';
        const mcpVer = this.aboutInfo.mcpVersion ? `MCP v${this.aboutInfo.mcpVersion}` : '';
        aboutNode.description = [extVer, mcpVer].filter(Boolean).join(' · ') || undefined;
        items.push(aboutNode);

        return items;
    }

    private async getNodeChildren(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        switch (element.nodeKind) {
            case 'root-files':
                return this.getFileChildren();
            case 'root-projects':
                return this.fetchProjects();
            case 'project':
                telemetry.trackTreeExpand('project');
                return this.fetchProjectTargets(element);
            case 'target':
                telemetry.trackTreeExpand('target');
                return this.fetchTargetTasks(element);
            case 'task':
                telemetry.trackTreeExpand('task');
                return this.fetchTaskDetails(element);
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
            case 'perf-analyzers':
                return this.fetchExpensiveAnalyzers();

            case 'root-evaluations':
                return this.fetchEvaluations();
            case 'evaluation':
                telemetry.trackTreeExpand('evaluation');
                return this.getEvaluationChildren(element);
            case 'eval-properties':
                telemetry.trackTreeExpand('eval-properties');
                return this.fetchEvalProperties(element);
            case 'eval-global-props':
                telemetry.trackTreeExpand('eval-global-props');
                return this.fetchEvalGlobalProps(element);
            case 'root-search': {
                if (!this.searchResults || this.searchResults.length === 0) {
                    return [this.makeInfoItem('No results', 'info')];
                }
                const clearItem = new BinlogTreeItem('Clear search results', vscode.TreeItemCollapsibleState.None);
                clearItem.nodeKind = 'action';
                clearItem.command = { command: 'binlog.clearSearch', title: 'Clear' };
                clearItem.iconPath = new vscode.ThemeIcon('close');
                const resultItems = this.searchResults.map(d => this.dataToItem(d));
                // If we hit the limit, offer to load all
                if (this.searchResultsHasMore) {
                    const loadMore = new BinlogTreeItem('Load all results...', vscode.TreeItemCollapsibleState.None);
                    loadMore.nodeKind = 'action';
                    loadMore.command = { command: 'binlog.searchLoadAll', title: 'Load All' };
                    loadMore.iconPath = new vscode.ThemeIcon('ellipsis');
                    return [clearItem, ...resultItems, loadMore];
                }
                return [clearItem, ...resultItems];
            }
            case 'root-actions':
                return this.getActionChildren();
            case 'root-about':
                return this.getAboutChildren();
            case 'about-mcp':
                return this.getMcpChildren();
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
            item.fullText = p;
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
        telemetry.trackTreeExpand('root-projects');
        // Fallback if not prefetched
        return this.callMcpTool('binlog_projects', {}, 'root-projects', (text) => {
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
        const tool = severity === 'Error' ? 'binlog_errors' : 'binlog_warnings';
        return this.callMcpTool(tool, {}, severity === 'Error' ? 'root-errors' : 'root-warnings', (text) => {
            const data = this.tryParseJson(text);
            this.parseDiagnosticsItems(data, severity === 'Error' ? 'error' : 'warning');
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

        const analyzers = new BinlogTreeItem(
            'Executed Analyzers',
            vscode.TreeItemCollapsibleState.Collapsed
        );
        analyzers.nodeKind = 'perf-analyzers' as NodeKind;
        analyzers.iconPath = new vscode.ThemeIcon('microscope');

        return [targets, tasks, analyzers];
    }

    private async fetchExpensiveTargets(): Promise<BinlogTreeItem[]> {
        if (this.targetsCache) {
            return this.targetsCache.map(d => this.dataToItem(d));
        }
        telemetry.trackTreeExpand('perf-targets');
        return this.callMcpTool('binlog_expensive_targets', { top_number: 10 }, 'perf-targets', (text) => {
            const items = this.parsePerfItems(text, 'flame');
            this.targetsCache = items;
            return items;
        });
    }

    private async fetchExpensiveTasks(): Promise<BinlogTreeItem[]> {
        if (this.tasksCache) {
            return this.tasksCache.map(d => this.dataToItem(d));
        }
        telemetry.trackTreeExpand('perf-tasks');
        return this.callMcpTool('binlog_expensive_tasks', { top_number: 10 }, 'perf-tasks', (text) => {
            const items = this.parsePerfItems(text, 'tools');
            this.tasksCache = items;
            return items;
        });
    }

    private async fetchExpensiveAnalyzers(): Promise<BinlogTreeItem[]> {
        if (this.analyzersCache) {
            if (this.analyzersCache.length === 0) {
                return [this.makeInfoItem('No analyzer data found', 'info')];
            }
            return this.analyzersCache.map(d => this.dataToItem(d));
        }
        telemetry.trackTreeExpand('perf-analyzers');

        if (!this.mcpClient) {
            return [this.makeInfoItem('MCP server not connected', 'info')];
        }

        // Try the dedicated MCP tool first
        try {
            const result = await this.mcpCall('binlog_expensive_analyzers', { limit: 20 });
            const items = this.parsePerfItems(result.text, 'microscope');
            if (items.length > 0) {
                this.analyzersCache = items;
                return items.map(d => this.dataToItem(d));
            }
        } catch { /* fall through */ }

        // Fallback: extract analyzer timing from Csc task messages via binlog_search.
        // BinlogInsights v0.2.0's binlog_expensive_analyzers returns [] because it
        // requires BuildAnalyzer.AnalyzeBuild(). But the raw analyzer timing lines
        // exist as Csc messages like:
        //   "0.176   71      Microsoft.NetCore.CSharp.Analyzers.Performance.CSharpConstantExpectedAnalyzer (CA1856, CA1857)"
        // And assembly-level items like:
        //   "363 ms   Microsoft.CodeAnalysis.CSharp.NetAnalyzers ... = 341 ms"
        try {
            // First check if the binlog has analyzer data at all
            const checkResult = await this.mcpCall('binlog_search', {
                query: 'Total analyzer execution',
                limit: 5,
            });
            const checkData = this.tryParseJson(checkResult.text);
            const checkEntries = Array.isArray(checkData) ? checkData : [];

            if (checkEntries.length === 0) {
                this.analyzersCache = [];
                return [this.makeInfoItem('No analyzer data found', 'info')];
            }

            // Extract analyzer data from the "analyzer execution time" context.
            // Strategy: search for assembly-level summaries that appear as items
            // in format "363 ms   Microsoft.CodeAnalysis.CSharp.NetAnalyzers, Version=... = 341 ms"
            // and individual analyzer lines "0.176   71      AnalyzerName (CA1234)"
            const analyzerMap = new Map<string, { durationMs: number; count: number }>();

            // Search for the assembly-level summary items (nodeType: "Item")
            // These contain "ms " prefix which is distinctive
            const searchTerms = [
                'Total analyzer execution',  // gives us project context
                'NetAnalyzers',              // Microsoft.CodeAnalysis.*.NetAnalyzers
                'CodeStyle',                 // Microsoft.CodeAnalysis.*.CodeStyle
                'ReferenceTrimmer',          // ReferenceTrimmer.Analyzer
                'AspNetCore',               // Microsoft.AspNetCore.*.Analyzers
                'Generator',                // source generators
                'Interop',                  // Microsoft.Interop.* generators
                'RegularExpressions',       // System.Text.RegularExpressions.Generator
                'StyleCop',                 // StyleCop.Analyzers
                'Roslynator',               // Roslynator analyzers
                'CA1', 'CA2', 'IDE0', 'SA1', // diagnostic IDs for individual analyzers
            ];
            for (const term of searchTerms) {
                try {
                    const result = await this.mcpCall('binlog_search', {
                        query: term,
                        limit: 200,
                    });
                    const data = this.tryParseJson(result.text);
                    const entries = Array.isArray(data) ? data : [];
                    for (const entry of entries) {
                        const msg = entry.message || entry.Message || '';
                        // Match individual analyzer timing: "0.176   71      FullAnalyzerName (CA1234)"
                        const timingMatch = msg.match(/^(\d+\.\d+)\s+\d+\s{2,}(.+)/);
                        if (timingMatch) {
                            const seconds = parseFloat(timingMatch[1]);
                            const name = timingMatch[2].trim();
                            if (seconds > 0.001 && name.length > 5 && !name.startsWith('Total')) {
                                const durationMs = Math.round(seconds * 1000);
                                const existing = analyzerMap.get(name);
                                if (existing) {
                                    existing.durationMs += durationMs;
                                    existing.count++;
                                } else {
                                    analyzerMap.set(name, { durationMs, count: 1 });
                                }
                            }
                            continue;
                        }
                        // Match assembly-level summary: "363 ms   AssemblyFullName, Version=... : AnalyzerName = 341 ms"
                        const asmMatch = msg.match(/^(\d+)\s*ms\s{2,}(.+)/);
                        if (asmMatch && entry.nodeType === 'Item') {
                            const durationMs = parseInt(asmMatch[1]);
                            let name = asmMatch[2].trim();
                            // Trim version info: "Name, Version=... : SubName = Nms" → just "Name"
                            const colonIdx = name.indexOf(':');
                            if (colonIdx > 0) { name = name.substring(0, colonIdx).trim(); }
                            const commaIdx = name.indexOf(',');
                            if (commaIdx > 0) { name = name.substring(0, commaIdx).trim(); }
                            if (durationMs > 0 && name.length > 3) {
                                const existing = analyzerMap.get(name);
                                if (existing) {
                                    existing.durationMs += durationMs;
                                    existing.count++;
                                } else {
                                    analyzerMap.set(name, { durationMs, count: 1 });
                                }
                            }
                        }
                    }
                } catch { /* non-fatal */ }
            }

            if (analyzerMap.size > 0) {
                const items: TreeNodeData[] = [...analyzerMap.entries()]
                    .sort((a, b) => b[1].durationMs - a[1].durationMs)
                    .slice(0, 20)
                    .map(([name, info]) => {
                        const durStr = info.durationMs >= 1000
                            ? `${(info.durationMs / 1000).toFixed(1)}s`
                            : `${info.durationMs}ms`;
                        return {
                            kind: 'perf-item' as NodeKind,
                            label: name,
                            description: `${durStr}${info.count > 1 ? ` (×${info.count})` : ''}`,
                            tooltip: `Analyzer: ${name}\nTotal: ${durStr}\nRuns: ${info.count}\n\nClick to analyze in Copilot Chat`,
                            icon: 'microscope',
                            command: {
                                command: 'binlog.analyzeInChat',
                                title: 'Analyze in Chat',
                                arguments: [name, durStr, info.count, 'perf-item'],
                            },
                        };
                    });
                this.analyzersCache = items;
                this._onDidChangeTreeData.fire(undefined);
                return items.map(d => this.dataToItem(d));
            }
        } catch { /* non-fatal */ }

        this.analyzersCache = [];
        return [this.makeInfoItem('No analyzer data found', 'info')];
    }

    private parsePerfItems(text: string, icon: string): TreeNodeData[] {
        const data = this.tryParseJson(text);
        const items: TreeNodeData[] = [];
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            for (const [name, info] of Object.entries(data as Record<string, any>)) {
                const durationMs = info.inclusiveDurationMs || info.totalDurationMs || info.durationMs || info.exclusiveDurationMs || info.duration
                    || info.TotalDurationMs || info.InclusiveDurationMs || info.ExclusiveDurationMs || info.Duration || 0;
                const durStr = durationMs >= 1000
                    ? `${(durationMs / 1000).toFixed(1)}s`
                    : `${durationMs}ms`;
                const count = info.executionCount || info.ExecutionCount || 1;
                items.push({
                    kind: 'perf-item',
                    label: name,
                    description: `${durStr}${count > 1 ? ` (×${count})` : ''}`,
                    tooltip: `${name}\nDuration: ${durStr}\nExecutions: ${count}\n\nClick to analyze in Copilot Chat`,
                    icon,
                    command: {
                        command: 'binlog.analyzeInChat',
                        title: 'Analyze in Chat',
                        arguments: [name, durStr, count, 'perf-item'],
                    },
                });
            }
        } else if (Array.isArray(data)) {
            for (const entry of data) {
                const name = entry.targetName || entry.taskName || entry.analyzerName || entry.name
                    || entry.TargetName || entry.TaskName || entry.AnalyzerName || entry.Name || '';
                const durationMs = entry.totalInclusiveMs || entry.totalExclusiveMs || entry.totalDurationMs || entry.inclusiveDurationMs || entry.durationMs || entry.duration
                    || entry.TotalInclusiveMs || entry.TotalExclusiveMs || entry.TotalDurationMs || entry.InclusiveDurationMs || entry.DurationMs || entry.Duration || 0;
                const count = entry.executionCount || entry.ExecutionCount || 1;
                const durStr = durationMs >= 1000
                    ? `${(durationMs / 1000).toFixed(1)}s`
                    : `${durationMs}ms`;
                items.push({
                    kind: 'perf-item',
                    label: String(name),
                    description: `${durStr}${count > 1 ? ` (×${count})` : ''}`,
                    tooltip: `${name}\nDuration: ${durStr}\nExecutions: ${count}\n\nClick to analyze in Copilot Chat`,
                    icon,
                    command: {
                        command: 'binlog.analyzeInChat',
                        title: 'Analyze in Chat',
                        arguments: [String(name), durStr, count, 'perf-item'],
                    },
                });
            }
        }
        return items;
    }

    /** Fetch targets for a specific project (lazy on expand) */
    private async fetchProjectTargets(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        if (!this.mcpClient) {
            return [this.makeInfoItem('MCP server not connected', 'info')];
        }
        const projectFile = element.projectFile;
        if (!projectFile) {
            return [this.makeInfoItem('No project file', 'info')];
        }
        try {
            const projectName = this.extractFileName(projectFile).replace(/\.[^.]+$/, '');
            const result = await this.mcpCall('binlog_project_targets', {
                project: projectName,
            });
            const data = this.tryParseJson(result.text);
            const items: BinlogTreeItem[] = [];
            if (Array.isArray(data)) {
                for (const t of data) {
                    const name = t.name || t.targetName || '';
                    const durationMs = t.exclusiveDurationMs || t.inclusiveDurationMs || t.durationMs || t.duration || 0;
                    const durStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
                    const skipped = t.skipped || false;
                    const icon = skipped ? 'debug-step-over' : 'symbol-event';
                    const item = new BinlogTreeItem(
                        String(name),
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    item.nodeKind = 'target';
                    item.description = skipped ? '⏭ skipped' : durStr;
                    item.tooltip = `Target: ${name}\nDuration: ${durStr}\nSkipped: ${skipped}`;
                    item.iconPath = new vscode.ThemeIcon(icon);
                    item.projectFile = projectFile;
                    item.targetName = String(name);
                    item.contextValue = 'copyable-target';
                    item.fullText = `${name} — ${durStr}`;
                    items.push(item);
                }
            } else if (data && typeof data === 'object') {
                for (const [name, info] of Object.entries(data as Record<string, any>)) {
                    const durationMs = info.exclusiveDurationMs || info.inclusiveDurationMs || info.durationMs || info.duration || 0;
                    const durStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
                    const skipped = info.skipped || false;
                    const item = new BinlogTreeItem(
                        name,
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    item.nodeKind = 'target';
                    item.description = skipped ? '⏭ skipped' : durStr;
                    item.tooltip = `Target: ${name}\nDuration: ${durStr}`;
                    item.iconPath = new vscode.ThemeIcon(skipped ? 'debug-step-over' : 'symbol-event');
                    item.projectFile = projectFile;
                    item.targetName = name;
                    item.contextValue = 'copyable-target';
                    item.fullText = `${name} — ${durStr}`;
                    items.push(item);
                }
            }
            return items.length > 0 ? items : [this.makeInfoItem('No targets found', 'info')];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [this.makeInfoItem(`Error: ${msg.substring(0, 80)}`, 'error')];
        }
    }

    /** Fetch tasks within a target (lazy on expand) */
    private async fetchTargetTasks(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        if (!this.mcpClient) {
            return [this.makeInfoItem('MCP server not connected', 'info')];
        }
        const targetName = element.targetName;
        if (!targetName) {
            return [this.makeInfoItem('No target name', 'info')];
        }
        try {
            const projectName = element.projectFile
                ? this.extractFileName(element.projectFile).replace(/\.[^.]+$/, '')
                : '';
            const args: Record<string, unknown> = {
                target_name: targetName,
                project: projectName,
            };
            const result = await this.mcpCall('binlog_tasks_in_target', args);
            const data = this.tryParseJson(result.text);
            const items: BinlogTreeItem[] = [];
            const entries = Array.isArray(data) ? data : (data && typeof data === 'object' ? Object.entries(data).map(([name, info]) => ({ name, ...(info as object) })) : []);
            for (const t of entries) {
                const name = t.name || t.taskName || '';
                const durationMs = t.durationMs || t.totalDurationMs || t.duration || 0;
                const durStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
                const item = new BinlogTreeItem(
                    String(name),
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.nodeKind = 'task';
                item.description = durStr;
                item.tooltip = `Task: ${name}\nDuration: ${durStr}\nTarget: ${targetName}`;
                item.iconPath = new vscode.ThemeIcon('tools');
                item.projectFile = element.projectFile;
                item.targetName = targetName;
                item.taskName = String(name);
                item.contextValue = 'copyable-task';
                item.fullText = `${name} — ${durStr}`;
                items.push(item);
            }
            // If we got raw text but no structured data, show as messages
            if (items.length === 0 && result.text.trim()) {
                const lines = result.text.split('\n').filter((l: string) => l.trim());
                for (const line of lines.slice(0, 20)) {
                    const msgItem = new BinlogTreeItem(
                        line.trim(),
                        vscode.TreeItemCollapsibleState.None
                    );
                    msgItem.nodeKind = 'message';
                    msgItem.iconPath = new vscode.ThemeIcon('note');
                    msgItem.tooltip = line.trim();
                    msgItem.fullText = line.trim();
                    items.push(msgItem);
                }
            }
            return items.length > 0 ? items : [this.makeInfoItem('No tasks found', 'info')];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [this.makeInfoItem(`Error: ${msg.substring(0, 80)}`, 'error')];
        }
    }

    /** Fetch task details (lazy on expand) */
    private async fetchTaskDetails(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        if (!this.mcpClient) {
            return [this.makeInfoItem('MCP server not connected', 'info')];
        }
        const taskName = element.taskName;
        if (!taskName) {
            return [this.makeInfoItem('No task name', 'info')];
        }
        try {
            const projectName = element.projectFile
                ? this.extractFileName(element.projectFile).replace(/\.[^.]+$/, '')
                : '';
            const args: Record<string, unknown> = {
                task_name: taskName,
                project: projectName,
                target_name: element.targetName || '',
            };
            const result = await this.mcpCall('binlog_task_details', args);
            const items: BinlogTreeItem[] = [];

            // Try to parse as JSON first
            const data = this.tryParseJson(result.text);
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                const details = data as Record<string, any>;
                // Show parameters, messages, etc.
                if (details.parameters) {
                    for (const [k, v] of Object.entries(details.parameters)) {
                        const valStr = String(v);
                        const paramItem = new BinlogTreeItem(
                            `${k} = ${valStr}`,
                            vscode.TreeItemCollapsibleState.None
                        );
                        paramItem.nodeKind = 'message';
                        paramItem.iconPath = new vscode.ThemeIcon('symbol-parameter');
                        paramItem.tooltip = `${k} = ${valStr}`;
                        paramItem.fullText = `${k} = ${valStr}`;
                        paramItem.contextValue = 'copyable-message';
                        items.push(paramItem);
                    }
                }
                if (details.messages && Array.isArray(details.messages)) {
                    for (const msg of details.messages.slice(0, 30)) {
                        const msgText = typeof msg === 'string' ? msg : (msg.text || msg.message || JSON.stringify(msg));
                        const msgStr = String(msgText);
                        const msgItem = new BinlogTreeItem(
                            msgStr,
                            vscode.TreeItemCollapsibleState.None
                        );
                        msgItem.nodeKind = 'message';
                        msgItem.iconPath = new vscode.ThemeIcon('note');
                        msgItem.tooltip = msgStr;
                        msgItem.fullText = msgStr;
                        msgItem.contextValue = 'copyable-message';
                        items.push(msgItem);
                    }
                }
            }

            // Fallback: parse as lines
            if (items.length === 0) {
                const lines = result.text.split('\n').filter((l: string) => l.trim());
                for (const line of lines.slice(0, 50)) {
                    const trimmed = line.trim();
                    const msgItem = new BinlogTreeItem(
                        trimmed,
                        vscode.TreeItemCollapsibleState.None
                    );
                    msgItem.nodeKind = 'message';
                    msgItem.iconPath = new vscode.ThemeIcon('note');
                    msgItem.tooltip = trimmed;
                    msgItem.fullText = trimmed;
                    msgItem.contextValue = 'copyable-message';
                    items.push(msgItem);
                }
            }
            return items.length > 0 ? items : [this.makeInfoItem('No details available', 'info')];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [this.makeInfoItem(`Error: ${msg.substring(0, 80)}`, 'error')];
        }
    }



    /** Execute a search query against the binlog and return results */
    async searchBinlog(query: string, maxResults: number = 100): Promise<{ text: string }> {
        if (!this.mcpClient) {
            throw new Error('MCP server not connected');
        }
        return this.mcpCall('binlog_search', {
            query,
            limit: maxResults,
        });
    }

    /** Get the internal MCP client for direct access */
    getMcpClient(): McpClient | null {
        return this.mcpClient;
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

        const ci = new BinlogTreeItem('Download from CI/CD...', vscode.TreeItemCollapsibleState.None);
        ci.nodeKind = 'action';
        ci.command = { command: 'binlog.downloadFromCi', title: 'Download' };
        ci.iconPath = new vscode.ThemeIcon('cloud-download');
        actions.push(ci);

        const refresh = new BinlogTreeItem('Reload', vscode.TreeItemCollapsibleState.None);
        refresh.nodeKind = 'action';
        refresh.command = { command: 'binlog.refreshTree', title: 'Reload' };
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

        // Optimize Build action
        const optimize = new BinlogTreeItem('Optimize build...', vscode.TreeItemCollapsibleState.None);
        optimize.nodeKind = 'action';
        optimize.command = { command: 'binlog.optimizeBuild', title: 'Optimize' };
        optimize.iconPath = new vscode.ThemeIcon('rocket');
        optimize.description = 'apply & compare';
        actions.push(optimize);

        return actions;
    }

    private getAboutChildren(): BinlogTreeItem[] {
        const items: BinlogTreeItem[] = [];
        const info = this.aboutInfo;

        // Extension version
        if (info.extensionVersion) {
            const ext = new BinlogTreeItem(
                'Extension Version',
                vscode.TreeItemCollapsibleState.None
            );
            ext.nodeKind = 'about-item';
            ext.description = `v${info.extensionVersion}`;
            ext.iconPath = new vscode.ThemeIcon('extensions');
            items.push(ext);
        }

        // MCP Server sub-section
        const mcpNode = new BinlogTreeItem(
            'MCP Server',
            vscode.TreeItemCollapsibleState.Collapsed
        );
        mcpNode.nodeKind = 'about-mcp';
        mcpNode.iconPath = new vscode.ThemeIcon('server');
        mcpNode.contextValue = 'mcpRoot';
        if (info.mcpVersion) {
            mcpNode.description = `v${info.mcpVersion}`;
        }
        items.push(mcpNode);

        return items;
    }

    private getMcpChildren(): BinlogTreeItem[] {
        const items: BinlogTreeItem[] = [];
        const info = this.aboutInfo;

        // Location
        if (info.mcpToolPath) {
            const location = new BinlogTreeItem(
                'Location',
                vscode.TreeItemCollapsibleState.None
            );
            location.nodeKind = 'mcp-item';
            location.description = info.mcpToolPath;
            location.tooltip = info.mcpToolPath;
            location.iconPath = new vscode.ThemeIcon('folder-library');
            items.push(location);
        }

        // Config file links
        if (info.mcpConfigPaths && info.mcpConfigPaths.length > 0) {
            for (const cfgPath of info.mcpConfigPaths) {
                const label = cfgPath.includes('.vscode') ? 'Workspace mcp.json' : 'User mcp.json';
                const cfg = new BinlogTreeItem(label, vscode.TreeItemCollapsibleState.None);
                cfg.nodeKind = 'mcp-item';
                cfg.description = cfgPath;
                cfg.tooltip = `Click to open ${cfgPath}`;
                cfg.iconPath = new vscode.ThemeIcon('go-to-file');
                cfg.command = {
                    command: 'vscode.open',
                    title: 'Open Config',
                    arguments: [vscode.Uri.file(cfgPath)]
                };
                items.push(cfg);
            }
        }

        // Check for updates button
        const check = new BinlogTreeItem(
            'Check for updates',
            vscode.TreeItemCollapsibleState.None
        );
        check.nodeKind = 'mcp-item';
        check.iconPath = new vscode.ThemeIcon('sync');
        check.command = { command: 'binlog.checkForUpdates', title: 'Check for updates' };
        items.push(check);

        // Update status (at the bottom)
        if (info.mcpUpdateAvailable && info.mcpLatestVersion) {
            const update = new BinlogTreeItem(
                `Update available: v${info.mcpLatestVersion}`,
                vscode.TreeItemCollapsibleState.None
            );
            update.nodeKind = 'mcp-item';
            update.description = 'click to update';
            update.iconPath = new vscode.ThemeIcon('cloud-download');
            update.command = { command: 'binlog.updateMcpServer', title: 'Update' };
            items.push(update);
        } else if (info.mcpVersion && info.mcpLatestVersion) {
            const upToDate = new BinlogTreeItem(
                'Up to date',
                vscode.TreeItemCollapsibleState.None
            );
            upToDate.nodeKind = 'mcp-item';
            upToDate.iconPath = new vscode.ThemeIcon('check');
            items.push(upToDate);
        }

        return items;
    }

    // --- Evaluation methods ---

    private async fetchEvaluations(): Promise<BinlogTreeItem[]> {
        if (this.evaluationsCache) {
            return this.evaluationsCache.map(d => this.dataToItem(d));
        }
        telemetry.trackTreeExpand('root-evaluations');
        if (!this.mcpClient) {
            return [this.makeInfoItem('MCP server not connected', 'info')];
        }
        try {
            const result = await this.mcpCall('binlog_evaluations');
            const data = this.tryParseJson(result.text);
            const entries = Array.isArray(data) ? data : [];

            const items: TreeNodeData[] = entries.map((e: any) => {
                const file = e.projectFile || e.ProjectFile || '';
                const durMs = e.durationMs || e.DurationMs || 0;
                const durStr = durMs >= 1000 ? `${(durMs / 1000).toFixed(1)}s` : `${durMs}ms`;
                const evalId = e.id || e.Id || 0;
                return {
                    kind: 'evaluation' as NodeKind,
                    label: this.extractFileName(file),
                    description: durStr,
                    tooltip: `Evaluation #${evalId}\n${file}\nDuration: ${durStr}\n\nExpand to see evaluated properties`,
                    icon: 'library',
                    children: [],
                    evaluationId: evalId,
                    projectFile: file,
                };
            });

            this.evaluationsCache = items;
            this._onDidChangeTreeData.fire(undefined);
            return items.length > 0
                ? items.map(d => this.dataToItem(d))
                : [this.makeInfoItem('No evaluations found', 'info')];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [this.makeInfoItem(`Error: ${msg.substring(0, 80)}`, 'error')];
        }
    }

    private getEvaluationChildren(element: BinlogTreeItem): BinlogTreeItem[] {
        const propsNode = new BinlogTreeItem('Properties', vscode.TreeItemCollapsibleState.Collapsed);
        propsNode.nodeKind = 'eval-properties';
        propsNode.iconPath = new vscode.ThemeIcon('symbol-property');
        propsNode.evaluationId = element.evaluationId;

        const globalNode = new BinlogTreeItem('Global Properties', vscode.TreeItemCollapsibleState.Collapsed);
        globalNode.nodeKind = 'eval-global-props';
        globalNode.iconPath = new vscode.ThemeIcon('globe');
        globalNode.evaluationId = element.evaluationId;

        return [propsNode, globalNode];
    }

    private async fetchEvalProperties(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        if (!this.mcpClient || element.evaluationId === undefined) {
            return [this.makeInfoItem('No evaluation ID', 'info')];
        }
        try {
            const result = await this.mcpCall('binlog_evaluation_properties', {
                evaluation_id: element.evaluationId,
            });
            const data = this.tryParseJson(result.text);
            const items: BinlogTreeItem[] = [];
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
                    const item = new BinlogTreeItem(
                        `${k} = ${String(v)}`,
                        vscode.TreeItemCollapsibleState.None
                    );
                    item.nodeKind = 'eval-property';
                    item.iconPath = new vscode.ThemeIcon('symbol-property');
                    item.tooltip = `${k} = ${String(v)}`;
                    item.fullText = `${k} = ${String(v)}`;
                    item.contextValue = 'copyable-message';
                    items.push(item);
                }
            } else if (Array.isArray(data)) {
                for (const entry of data) {
                    const name = entry.name || entry.Name || entry.propertyName || '';
                    const value = entry.value || entry.Value || '';
                    const item = new BinlogTreeItem(
                        `${name} = ${String(value)}`,
                        vscode.TreeItemCollapsibleState.None
                    );
                    item.nodeKind = 'eval-property';
                    item.iconPath = new vscode.ThemeIcon('symbol-property');
                    item.tooltip = `${name} = ${String(value)}`;
                    item.fullText = `${name} = ${String(value)}`;
                    item.contextValue = 'copyable-message';
                    items.push(item);
                }
            }
            return items.length > 0 ? items : [this.makeInfoItem('No properties', 'info')];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [this.makeInfoItem(`Error: ${msg.substring(0, 80)}`, 'error')];
        }
    }

    private async fetchEvalGlobalProps(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        if (!this.mcpClient || element.evaluationId === undefined) {
            return [this.makeInfoItem('No evaluation ID', 'info')];
        }
        try {
            const result = await this.mcpCall('binlog_evaluation_global_properties', {
                evaluation_id: element.evaluationId,
            });
            const data = this.tryParseJson(result.text);
            const items: BinlogTreeItem[] = [];
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
                    const item = new BinlogTreeItem(
                        `${k} = ${String(v)}`,
                        vscode.TreeItemCollapsibleState.None
                    );
                    item.nodeKind = 'eval-property';
                    item.iconPath = new vscode.ThemeIcon('globe');
                    item.tooltip = `${k} = ${String(v)}`;
                    item.fullText = `${k} = ${String(v)}`;
                    item.contextValue = 'copyable-message';
                    items.push(item);
                }
            } else if (Array.isArray(data)) {
                for (const entry of data) {
                    const name = entry.name || entry.Name || entry.propertyName || '';
                    const value = entry.value || entry.Value || '';
                    const item = new BinlogTreeItem(
                        `${name} = ${String(value)}`,
                        vscode.TreeItemCollapsibleState.None
                    );
                    item.nodeKind = 'eval-property';
                    item.iconPath = new vscode.ThemeIcon('globe');
                    item.tooltip = `${name} = ${String(value)}`;
                    item.fullText = `${name} = ${String(value)}`;
                    item.contextValue = 'copyable-message';
                    items.push(item);
                }
            }
            return items.length > 0 ? items : [this.makeInfoItem('No global properties', 'info')];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [this.makeInfoItem(`Error: ${msg.substring(0, 80)}`, 'error')];
        }
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

        // Auto-inject binlog_file for multi-binlog to avoid
        // "requires explicit binlog_file" errors.
        if (!args.binlog_file && this.binlogPaths.length > 1) {
            args.binlog_file = this.binlogPaths[0];
        }

        this.loadingSet.add(parentKind);
        try {
            const result = await this.mcpCall(toolName, args);
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

    /**
     * Call MCP tool with auto-injected binlog_file for multi-binlog mode.
     * Used by direct callTool sites outside of the callMcpTool helper.
     */
    private mcpCall(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string }> {
        if (!this.mcpClient) { throw new Error('MCP server not connected'); }
        if (!args.binlog_file && this.binlogPaths.length > 1) {
            args.binlog_file = this.binlogPaths[0];
        }
        return this.mcpClient.callTool(tool, args);
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
        if (data.projectFile) { item.projectFile = data.projectFile; }
        if (data.projectId) { /* stored in command args */ }
        if (data.targetName) { item.targetName = data.targetName; }
        if (data.itemType) { item.itemType = data.itemType; }
        if (data.evaluationId !== undefined) { item.evaluationId = data.evaluationId; }
        // Build full text for clipboardand set context for menus
        const parts = [data.label];
        if (data.description) { parts.push(data.description); }
        item.fullText = parts.join(' — ');
        if (data.tooltip && data.tooltip !== data.label) {
            item.fullText = String(data.tooltip);
        }
        item.contextValue = data.kind === 'diagnostic' ? 'copyable-diagnostic'
            : data.kind === 'perf-item' ? 'copyable-perf'
            : data.kind === 'project' ? 'copyable-project'
            : data.kind === 'binlog-file' ? 'copyable-file'
            : data.kind === 'search-result' ? 'copyable-search'
            : undefined;
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

    private extractDirectory(filePath: string): string {
        const parts = filePath.replace(/\\/g, '/').split('/');
        if (parts.length <= 1) { return ''; }
        parts.pop(); // remove filename
        // Show last 2-3 path segments to keep it readable
        const segments = parts.filter(Boolean);
        if (segments.length <= 3) { return segments.join('/'); }
        return '…/' + segments.slice(-3).join('/');
    }

    /**
     * Resolve a file path from binlog data to a local file that exists.
     * Returns the resolved path or null if the file can't be found locally.
     * Handles binlogs built on different machines (CI, coworker).
     */
    private resolveLocalPath(filePath: string): string | null {
        if (!filePath) { return null; }
        // 1. Exact path exists
        if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
            return filePath;
        }
        const fileName = path.basename(filePath);
        const relative = filePath.replace(/^[a-zA-Z]:/, '').replace(/^[\\/]+/, '');
        // 2. Try workspace folders
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
            for (const folder of folders) {
                const byRelative = path.join(folder.uri.fsPath, relative);
                if (fs.existsSync(byRelative)) { return byRelative; }
                const byName = path.join(folder.uri.fsPath, fileName);
                if (fs.existsSync(byName)) { return byName; }
            }
        }
        // 3. Try relative to binlog directory
        if (this.binlogPaths.length > 0) {
            const binlogDir = path.dirname(this.binlogPaths[0]);
            const nearBinlog = path.join(binlogDir, fileName);
            if (fs.existsSync(nearBinlog)) { return nearBinlog; }
        }
        return null;
    }

    /** Build a vscode.open command for a file path, resolving against workspace. */
    private makeOpenCommand(filePath: string, lineNum: number, colNum: number): vscode.Command | undefined {
        const resolved = this.resolveLocalPath(filePath);
        if (!resolved) { return undefined; }
        return {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [
                vscode.Uri.file(resolved),
                lineNum > 0
                    ? { selection: new vscode.Range(lineNum - 1, Math.max(0, colNum - 1), lineNum - 1, Math.max(0, colNum - 1)) }
                    : undefined,
            ],
        };
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

    /** Get project file paths from the cache (for build command reconstruction) */
    getProjectFiles(): string[] {
        if (!this.projectsCache) { return []; }
        return this.projectsCache
            .map(p => p.projectFile || '')
            .filter(p => p.length > 0);
    }

    /** Get formatted diagnostics for the fix-all prompt */
    getDiagnosticsSummary(): { errors: string[], warnings: string[], errorCount: number, warningCount: number } {
        const formatDiag = (d: TreeNodeData) => {
            const desc = d.description || '';
            return `- ${d.label} (${desc})`;
        };
        return {
            errors: (this.errorsCache || []).map(formatDiag),
            warnings: (this.warningsCache || []).map(formatDiag),
            errorCount: this.errorsCache?.length || 0,
            warningCount: this.warningsCache?.length || 0,
        };
    }

    /** Get diagnostic counts for a specific project file */
    getProjectDiagnosticCounts(projectFileName: string): { errorCount: number; warningCount: number } {
        const lowerName = projectFileName.toLowerCase();
        const matchesProject = (d: TreeNodeData) => {
            const file = (d.projectFile || d.description || '').toLowerCase();
            return file.includes(lowerName);
        };
        return {
            errorCount: (this.errorsCache || []).filter(matchesProject).length,
            warningCount: (this.warningsCache || []).filter(matchesProject).length,
        };
    }

    /** Get cached diagnostic items for copy-all commands */
    getCachedDiagnostics(type: 'error' | 'warning'): { label: string | vscode.TreeItemLabel, fullText?: string }[] {
        const cache = type === 'error' ? this.errorsCache : this.warningsCache;
        if (!cache) { return []; }
        return cache.map(d => ({
            label: d.label,
            fullText: d.tooltip || `${d.label}${d.description ? ' — ' + d.description : ''}`,
        }));
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
    /** Full text for clipboard copy (label + description + tooltip details) */
    fullText?: string;
    /** For project nodes: full path of the project file */
    projectFile?: string;
    /** For target nodes: target name */
    targetName?: string;
    /** For task nodes: task name */
    taskName?: string;
    /** For item type nodes: the item type name */
    itemType?: string;
    /** For evaluation nodes: evaluation id from MCP */
    evaluationId?: number;
    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
        super(label, collapsibleState);
    }
}
