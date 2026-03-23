import * as vscode from 'vscode';
import { McpClient } from './mcpClient';

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
    | 'perf-analyzers' // "Slowest Analyzers" sub-section
    | 'perf-item'     // individual target/task
    | 'root-properties' // "Properties" section
    | 'property-item'   // individual property
    | 'root-items'      // "Items" section
    | 'item-type'       // item type group (e.g. PackageReference)
    | 'item-entry'      // individual item entry
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
    /** For target nodes: target name */
    targetName?: string;
    /** For item type nodes: the item type name */
    itemType?: string;
}

export class BinlogTreeDataProvider implements vscode.TreeDataProvider<BinlogTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BinlogTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private binlogPaths: string[] = [];
    private mcpClient: McpClient | null = null;
    private _isLoading = false;

    // Cached data from MCP calls
    private projectsCache: TreeNodeData[] | null = null;
    private errorsCache: TreeNodeData[] | null = null;
    private warningsCache: TreeNodeData[] | null = null;
    private targetsCache: TreeNodeData[] | null = null;
    private tasksCache: TreeNodeData[] | null = null;
    private analyzersCache: TreeNodeData[] | null = null;

    private loadingSet = new Set<NodeKind>();

    setBinlogPaths(paths: string[]) {
        this.binlogPaths = paths;
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

    /** Pre-fetch all data so tree expansion is instant */
    private async prefetch() {
        if (!this.mcpClient) { return; }
        const client = this.mcpClient;

        await vscode.window.withProgress(
            { location: { viewId: 'binlogExplorer' }, },
            async () => {
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
                            // Only cache non-empty results; let fetchExpensiveAnalyzers try its fallback parser
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
        );
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
                const label = code ? `${code}: ${msg}` : String(msg);
                const loc = file ? `${this.extractFileName(String(file))}${line ? ':' + line : ''}` : '';
                items.push({
                    kind: 'diagnostic',
                    label: label.length > 120 ? label.substring(0, 117) + '...' : label,
                    description: loc,
                    tooltip: `${label}\n${file}${line ? ':' + line : ''}`,
                    icon: severity === 'error' ? 'error' : 'warning',
                    projectFile: file,
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
        this.analyzersCache = null;
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
        if (this.binlogPaths.length === 0 && !this._isLoading) {
            return [];
        }

        const items: BinlogTreeItem[] = [];

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

        return items;
    }

    private async getNodeChildren(element: BinlogTreeItem): Promise<BinlogTreeItem[]> {
        switch (element.nodeKind) {
            case 'root-files':
                return this.getFileChildren();
            case 'root-projects':
                return this.fetchProjects();
            case 'project':
                return this.fetchProjectTargets(element);
            case 'target':
                return this.fetchTargetTasks(element);
            case 'task':
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
            'Slowest Analyzers',
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

        if (!this.mcpClient) {
            return [this.makeInfoItem('MCP server not connected', 'info')];
        }

        // Try the dedicated MCP tool first
        try {
            const result = await this.mcpClient.callTool('binlog_expensive_analyzers', { limit: 20 });
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
            const checkResult = await this.mcpClient.callTool('binlog_search', {
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
                    const result = await this.mcpClient.callTool('binlog_search', {
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
            const result = await this.mcpClient.callTool('binlog_project_targets', {
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
            const result = await this.mcpClient.callTool('binlog_tasks_in_target', args);
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
                        line.trim().substring(0, 120),
                        vscode.TreeItemCollapsibleState.None
                    );
                    msgItem.nodeKind = 'message';
                    msgItem.iconPath = new vscode.ThemeIcon('note');
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
            const result = await this.mcpClient.callTool('binlog_task_details', args);
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
        return this.mcpClient.callTool('binlog_search', {
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
        if (data.projectFile) { item.projectFile = data.projectFile; }
        if (data.projectId) { /* stored in command args */ }
        if (data.targetName) { item.targetName = data.targetName; }
        if (data.itemType) { item.itemType = data.itemType; }
        // Build full text for clipboard and set context for menus
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
    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
        super(label, collapsibleState);
    }
}
