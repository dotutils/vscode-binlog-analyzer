import * as vscode from 'vscode';
import * as path from 'path';

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

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('binlog');
        this.decorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: new vscode.ThemeIcon('error').id,
            overviewRulerColor: 'red',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
    }

    async loadFromBinlog(binlogPath: string, config: vscode.WorkspaceConfiguration) {
        const severityFilter = config.get<string>('diagnosticsSeverityFilter', 'Warning');
        const showInline = config.get<boolean>('inlineDecorations', true);

        // Parse diagnostics from the binlog using the MCP server
        // This uses a lightweight direct parse approach as a fallback
        const diagnostics = await this.parseDiagnosticsFromBinlog(binlogPath);

        if (!diagnostics || diagnostics.length === 0) {
            return;
        }

        // Filter by severity
        const filtered = this.filterBySeverity(diagnostics, severityFilter);

        // Group by file and push to Problems panel
        const groupedByFile = new Map<string, vscode.Diagnostic[]>();

        for (const diag of filtered) {
            const filePath = this.resolveFilePath(diag.file);
            if (!filePath) continue;

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

        // Clear previous and set new
        this.diagnosticCollection.clear();
        for (const [filePath, diags] of groupedByFile) {
            this.diagnosticCollection.set(vscode.Uri.file(filePath), diags);
        }

        // Apply inline decorations if enabled
        if (showInline) {
            this.applyInlineDecorations(groupedByFile);
        }

        const errorCount = filtered.filter(d => d.severity === 'error').length;
        const warnCount = filtered.filter(d => d.severity === 'warning').length;
        vscode.window.showInformationMessage(
            `Binlog diagnostics: ${errorCount} error(s), ${warnCount} warning(s) pushed to Problems panel.`
        );
    }

    private async parseDiagnosticsFromBinlog(_binlogPath: string): Promise<BinlogDiagnostic[]> {
        // The actual parsing is done by the MCP server (baronfel.binlog.mcp).
        // This method provides a placeholder that returns an empty array.
        // When the MCP server is active, Copilot Chat will use get_diagnostics tool directly.
        // A future enhancement could invoke the MCP tool programmatically here.
        return [];
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

        // If absolute, use as-is
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        // Try to resolve relative to workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const resolved = path.join(folder.uri.fsPath, filePath);
                return resolved; // Best effort - file may not exist yet
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
    }
}
