import * as vscode from 'vscode';

/**
 * CodeAction provider for diagnostics produced by the binlog analyzer
 * (source = 'MSBuild Binlog'). Offers two flows:
 *
 *  1. "Ask @binlog about this error" — opens Copilot Chat pre-filled with
 *     a prompt that targets the @binlog participant and includes the error
 *     code, message, file path and line number. This is the primary
 *     "knowledge gap" bridge: a one-click jump from a build squiggle to a
 *     contextualised AI explanation backed by BinlogInsights MCP tools.
 *
 *  2. "Fix this build error with @binlog" — same routing but with a fix-
 *     oriented prompt prefix.
 *
 *  3. "Suppress {code} with #pragma" — purely local edit, kept for warnings.
 */
export class BinlogCodeActionProvider implements vscode.CodeActionProvider {
    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
    static readonly DIAGNOSTIC_SOURCE = 'MSBuild Binlog';

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const binlogDiags = context.diagnostics.filter(
            d => d.source === BinlogCodeActionProvider.DIAGNOSTIC_SOURCE,
        );

        for (const diag of binlogDiags) {
            actions.push(this.askAction(document, diag));
            actions.push(this.fixAction(document, diag));
            const suppress = this.suppressAction(document, diag);
            if (suppress) {
                actions.push(suppress);
            }
        }

        return actions;
    }

    private buildLocation(document: vscode.TextDocument, diag: vscode.Diagnostic): string {
        return `${document.uri.fsPath}:${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
    }

    private askAction(document: vscode.TextDocument, diag: vscode.Diagnostic): vscode.CodeAction {
        const code = diag.code ? String(typeof diag.code === 'object' ? diag.code.value : diag.code) : '';
        const action = new vscode.CodeAction(
            `$(comment-discussion) Ask @binlog about ${code || 'this build issue'}`,
            vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diag];
        const prompt =
            `@binlog Explain this MSBuild diagnostic and what is causing it. ` +
            `Use binlog_search and binlog_errors to gather context.\n\n` +
            `- Code: ${code || '(none)'}\n` +
            `- Message: ${diag.message}\n` +
            `- Location: ${this.buildLocation(document, diag)}`;
        action.command = {
            command: 'workbench.action.chat.open',
            title: 'Ask @binlog',
            arguments: [{ query: prompt }],
        };
        return action;
    }

    private fixAction(document: vscode.TextDocument, diag: vscode.Diagnostic): vscode.CodeAction {
        const code = diag.code ? String(typeof diag.code === 'object' ? diag.code.value : diag.code) : '';
        const action = new vscode.CodeAction(
            `$(sparkle) Fix ${code || 'this build issue'} with @binlog`,
            vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diag];
        action.isPreferred = diag.severity === vscode.DiagnosticSeverity.Error;
        const prompt =
            `@binlog Suggest a concrete fix for this MSBuild diagnostic. ` +
            `Provide exact MSBuild XML or CLI flags and indicate which file to edit.\n\n` +
            `- Code: ${code || '(none)'}\n` +
            `- Message: ${diag.message}\n` +
            `- Location: ${this.buildLocation(document, diag)}`;
        action.command = {
            command: 'workbench.action.chat.open',
            title: 'Fix with @binlog',
            arguments: [{ query: prompt }],
        };
        return action;
    }

    private suppressAction(
        document: vscode.TextDocument,
        diag: vscode.Diagnostic,
    ): vscode.CodeAction | undefined {
        if (diag.severity !== vscode.DiagnosticSeverity.Warning || !diag.code) {
            return undefined;
        }
        const code = String(typeof diag.code === 'object' ? diag.code.value : diag.code);
        const action = new vscode.CodeAction(
            `Suppress ${code} with #pragma`,
            vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diag];
        const edit = new vscode.WorkspaceEdit();
        const lineStart = new vscode.Position(diag.range.start.line, 0);
        const indent = document.lineAt(diag.range.start.line).text.match(/^\s*/)?.[0] || '';
        edit.insert(
            document.uri,
            lineStart,
            `${indent}#pragma warning disable ${code} // Suppressed: from binlog analysis\n`,
        );
        action.edit = edit;
        return action;
    }
}
