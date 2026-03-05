import * as vscode from 'vscode';
import * as path from 'path';
import { McpClient } from './mcpClient';

interface BinlogDiagnostic {
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    message: string;
    code: string;
    severity: 'error' | 'warning' | 'info';
    projectFile?: string;
}

export class BinlogDiagnosticsProvider implements vscode.Disposable {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private decorationType: vscode.TextEditorDecorationType;
    private mcpClient: McpClient | null = null;
    private cachedDiagnostics: BinlogDiagnostic[] = [];
    private codeActionProvider: vscode.Disposable | undefined;

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('binlog');
        this.decorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: new vscode.ThemeIcon('error').id,
            overviewRulerColor: 'red',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
        // Register code action provider for quick fixes on binlog diagnostics
        this.codeActionProvider = vscode.languages.registerCodeActionsProvider(
            { scheme: 'file' },
            new BinlogCodeActionProvider(this.diagnosticCollection),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        );
    }

    setMcpClient(client: McpClient | null) {
        this.mcpClient = client;
    }

    /** Load diagnostics from already-fetched MCP data (avoids duplicate MCP call) */
    loadFromRawData(data: unknown, config: vscode.WorkspaceConfiguration) {
        const diagnostics = this.parseMcpDiagnostics(data);
        this.cachedDiagnostics = diagnostics;
        this.pushDiagnostics(diagnostics, config);
    }

    /** Load diagnostics via the MCP client and push to Problems panel */
    async loadFromMcpClient(config: vscode.WorkspaceConfiguration) {
        if (!this.mcpClient) { return; }

        try {
            const result = await this.mcpClient.callTool('get_diagnostics');
            const data = JSON.parse(result.text);
            const diagnostics = this.parseMcpDiagnostics(data);
            this.cachedDiagnostics = diagnostics;
            this.pushDiagnostics(diagnostics, config);
        } catch {
            // MCP call failed — non-fatal, tree view still works
        }
    }

    /** Parse MCP get_diagnostics response into BinlogDiagnostic[] */
    private parseMcpDiagnostics(data: unknown): BinlogDiagnostic[] {
        const results: BinlogDiagnostic[] = [];
        if (!data || typeof data !== 'object') { return results; }

        const obj = data as Record<string, any>;
        const diagnostics = obj.diagnostics || [];
        if (!Array.isArray(diagnostics)) { return results; }

        for (const d of diagnostics) {
            const sev = String(d.severity || d.Severity || d.level || '').toLowerCase();
            const severity: 'error' | 'warning' | 'info' =
                /error/i.test(sev) ? 'error' : /warn/i.test(sev) ? 'warning' : 'info';

            results.push({
                file: String(d.file || d.File || d.projectFile || ''),
                line: Number(d.lineNumber || d.LineNumber || d.line || 1),
                column: Number(d.columnNumber || d.ColumnNumber || d.column || 1),
                endLine: d.endLineNumber ? Number(d.endLineNumber) : undefined,
                endColumn: d.endColumnNumber ? Number(d.endColumnNumber) : undefined,
                message: String(d.message || d.Message || d.text || ''),
                code: String(d.code || d.Code || ''),
                severity,
                projectFile: d.projectFile ? String(d.projectFile) : undefined,
            });
        }
        return results;
    }

    /** Push parsed diagnostics into VS Code Problems panel */
    private pushDiagnostics(diagnostics: BinlogDiagnostic[], config: vscode.WorkspaceConfiguration) {
        const severityFilter = config.get<string>('diagnosticsSeverityFilter', 'Warning');
        const showInline = config.get<boolean>('inlineDecorations', true);

        const filtered = this.filterBySeverity(diagnostics, severityFilter);

        const groupedByFile = new Map<string, vscode.Diagnostic[]>();

        for (const diag of filtered) {
            const filePath = this.resolveFilePath(diag.file);
            if (!filePath) { continue; }

            const vscodeDiag = new vscode.Diagnostic(
                new vscode.Range(
                    Math.max(0, diag.line - 1),
                    Math.max(0, diag.column - 1),
                    Math.max(0, (diag.endLine || diag.line) - 1),
                    Math.max(0, (diag.endColumn || diag.column) - 1)
                ),
                diag.message,
                this.toVSCodeSeverity(diag.severity)
            );
            vscodeDiag.code = diag.code;
            vscodeDiag.source = 'MSBuild Binlog';

            if (!groupedByFile.has(filePath)) {
                groupedByFile.set(filePath, []);
            }
            groupedByFile.get(filePath)!.push(vscodeDiag);
        }

        this.diagnosticCollection.clear();
        for (const [filePath, diags] of groupedByFile) {
            this.diagnosticCollection.set(vscode.Uri.file(filePath), diags);
        }

        if (showInline) {
            this.applyInlineDecorations(groupedByFile);
        }

        const errorCount = filtered.filter(d => d.severity === 'error').length;
        const warnCount = filtered.filter(d => d.severity === 'warning').length;
        if (errorCount > 0 || warnCount > 0) {
            vscode.window.showInformationMessage(
                `Binlog: ${errorCount} error(s), ${warnCount} warning(s) pushed to Problems panel.`
            );
        }
    }

    /** Get summary counts for status bar and other consumers */
    getDiagnosticCounts(): { errorCount: number; warningCount: number } {
        const errors = this.cachedDiagnostics.filter(d => d.severity === 'error').length;
        const warnings = this.cachedDiagnostics.filter(d => d.severity === 'warning').length;
        return { errorCount: errors, warningCount: warnings };
    }

    async loadFromBinlog(binlogPath: string, config: vscode.WorkspaceConfiguration) {
        // This is now a no-op — diagnostics are loaded via loadFromMcpClient after MCP client starts
    }

    private filterBySeverity(diagnostics: BinlogDiagnostic[], minSeverity: string): BinlogDiagnostic[] {
        const levels: Record<string, number> = { 'Error': 0, 'Warning': 1, 'Info': 2 };
        const minLevel = levels[minSeverity] ?? 1;

        return diagnostics.filter(d => {
            const diagLevel = levels[d.severity.charAt(0).toUpperCase() + d.severity.slice(1)] ?? 2;
            return diagLevel <= minLevel;
        });
    }

    private resolveFilePath(filePath: string): string | null {
        if (!filePath) return null;

        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const resolved = path.join(folder.uri.fsPath, filePath);
                return resolved;
            }
        }

        return filePath;
    }

    private toVSCodeSeverity(severity: string): vscode.DiagnosticSeverity {
        switch (severity.toLowerCase()) {
            case 'error': return vscode.DiagnosticSeverity.Error;
            case 'warning': return vscode.DiagnosticSeverity.Warning;
            case 'info': return vscode.DiagnosticSeverity.Information;
            default: return vscode.DiagnosticSeverity.Warning;
        }
    }

    private applyInlineDecorations(groupedByFile: Map<string, vscode.Diagnostic[]>) {
        for (const editor of vscode.window.visibleTextEditors) {
            const filePath = editor.document.uri.fsPath;
            const diags = groupedByFile.get(filePath);
            if (diags) {
                const decorations = diags
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
                    .map(d => ({
                        range: d.range,
                        hoverMessage: `🔴 ${d.message} (${d.code})`
                    }));
                editor.setDecorations(this.decorationType, decorations);
            }
        }
    }

    dispose() {
        this.diagnosticCollection.dispose();
        this.decorationType.dispose();
        this.codeActionProvider?.dispose();
    }
}

/** Provides Quick Fix code actions for binlog diagnostics */
class BinlogCodeActionProvider implements vscode.CodeActionProvider {
    constructor(private readonly diagnosticCollection: vscode.DiagnosticCollection) {}

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const binlogDiags = context.diagnostics.filter(d => d.source === 'MSBuild Binlog');

        for (const diag of binlogDiags) {
            // "Fix with Copilot" action
            const fixAction = new vscode.CodeAction(
                `$(sparkle) Fix "${diag.code}" with Copilot`,
                vscode.CodeActionKind.QuickFix
            );
            fixAction.diagnostics = [diag];
            fixAction.command = {
                command: 'workbench.action.chat.open',
                title: 'Fix with Copilot',
                arguments: [`@binlog Fix this build error: ${diag.code}: ${diag.message} in ${document.uri.fsPath}:${diag.range.start.line + 1}`],
            };
            actions.push(fixAction);

            // "Suppress with NoWarn" action for warnings
            if (diag.severity === vscode.DiagnosticSeverity.Warning && diag.code) {
                const suppressAction = new vscode.CodeAction(
                    `Suppress ${diag.code} with #pragma`,
                    vscode.CodeActionKind.QuickFix
                );
                suppressAction.diagnostics = [diag];
                const edit = new vscode.WorkspaceEdit();
                const lineStart = new vscode.Position(diag.range.start.line, 0);
                const indent = document.lineAt(diag.range.start.line).text.match(/^\s*/)?.[0] || '';
                edit.insert(document.uri, lineStart,
                    `${indent}#pragma warning disable ${diag.code} // Suppressed: from binlog analysis\n`);
                suppressAction.edit = edit;
                actions.push(suppressAction);
            }
        }

        return actions;
    }
}
