import * as vscode from 'vscode';
import { McpClient } from './mcpClient';

const SCHEME = 'binlog';

/**
 * Virtual document provider that renders binlog content as a read-only
 * text document in the editor. Clicking tree items opens the relevant
 * section (projects, errors, targets, etc.) in the editor.
 */
export class BinlogDocumentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private mcpClient: McpClient | null = null;
    private cache = new Map<string, string>();

    setMcpClient(client: McpClient | null) {
        this.mcpClient = client;
        this.cache.clear();
    }

    invalidate(uri: vscode.Uri) {
        this.cache.delete(uri.toString());
        this._onDidChange.fire(uri);
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const cached = this.cache.get(uri.toString());
        if (cached) { return cached; }

        if (!this.mcpClient) {
            return '⏳ MCP server not connected. Reload the binlog.';
        }

        const section = uri.path; // e.g. /summary, /projects, /errors, /targets
        const binlogName = uri.query; // the binlog filename for display

        try {
            let content: string;
            switch (section) {
                case '/summary':
                    content = await this.renderSummary(binlogName);
                    break;
                case '/projects':
                    content = await this.renderProjects();
                    break;
                case '/errors':
                    content = await this.renderDiagnostics('errors');
                    break;
                case '/warnings':
                    content = await this.renderDiagnostics('warnings');
                    break;
                case '/targets':
                    content = await this.renderExpensive('get_expensive_targets', 'Slowest Targets');
                    break;
                case '/tasks':
                    content = await this.renderExpensive('get_expensive_tasks', 'Slowest Tasks');
                    break;
                default:
                    content = await this.renderSummary(binlogName);
            }
            this.cache.set(uri.toString(), content);
            return content;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error loading binlog data: ${msg}`;
        }
    }

    private async renderSummary(binlogName: string): Promise<string> {
        const lines: string[] = [];
        lines.push('═══════════════════════════════════════════════════════');
        lines.push(`  MSBuild Binary Log: ${binlogName}`);
        lines.push('═══════════════════════════════════════════════════════');
        lines.push('');

        // Projects
        try {
            const projResult = await this.mcpClient!.callTool('list_projects');
            const projData = JSON.parse(projResult.text);
            const projects = Object.entries(projData as Record<string, any>);
            const seen = new Set<string>();
            const unique = projects.filter(([, p]) => {
                const f = (p as any).projectFile || '';
                if (seen.has(f)) { return false; }
                seen.add(f);
                return true;
            });
            lines.push(`📁 PROJECTS (${unique.length})`);
            lines.push('─────────────────────────────────────────────────────');
            for (const [id, proj] of unique) {
                const p = proj as any;
                const file = p.projectFile || '';
                const targets = p.entryTargets || {};
                const totalMs = Object.values(targets).reduce(
                    (sum: number, t: any) => sum + (t.durationMs || 0), 0
                );
                const targetNames = Object.values(targets)
                    .map((t: any) => t.targetName)
                    .join(', ');
                lines.push(`  [${id}] ${file}`);
                if (targetNames) {
                    lines.push(`       Targets: ${targetNames}`);
                }
                if (totalMs > 0) {
                    lines.push(`       Duration: ${(totalMs / 1000).toFixed(1)}s`);
                }
                lines.push('');
            }
        } catch {
            lines.push('  (could not load projects)');
        }
        lines.push('');

        // Diagnostics
        try {
            const diagResult = await this.mcpClient!.callTool('get_diagnostics');
            const diagData = JSON.parse(diagResult.text);
            const diags = diagData.diagnostics || [];
            const errors = diags.filter((d: any) => /error/i.test(d.severity || ''));
            const warnings = diags.filter((d: any) => /warn/i.test(d.severity || ''));

            lines.push(`❌ ERRORS (${diagData.errorCount || errors.length})`);
            lines.push('─────────────────────────────────────────────────────');
            if (errors.length === 0 && (diagData.errorCount || 0) === 0) {
                lines.push('  ✅ No errors');
            }
            for (const e of errors) {
                const code = e.code || '';
                const msg = e.message || '';
                const file = e.file || '';
                const ln = e.lineNumber || '';
                lines.push(`  ${code}: ${msg}`);
                if (file) { lines.push(`    📄 ${file}${ln ? ':' + ln : ''}`); }
                lines.push('');
            }
            lines.push('');

            lines.push(`⚠️  WARNINGS (${diagData.warningCount || warnings.length})`);
            lines.push('─────────────────────────────────────────────────────');
            if (warnings.length === 0 && (diagData.warningCount || 0) === 0) {
                lines.push('  ✅ No warnings');
            }
            for (const w of warnings) {
                const code = w.code || '';
                const msg = w.message || '';
                const file = w.file || '';
                const ln = w.lineNumber || '';
                lines.push(`  ${code}: ${msg}`);
                if (file) { lines.push(`    📄 ${file}${ln ? ':' + ln : ''}`); }
                lines.push('');
            }
        } catch {
            lines.push('  (could not load diagnostics)');
        }
        lines.push('');

        // Performance
        try {
            const targetsResult = await this.mcpClient!.callTool('get_expensive_targets', { top_number: 10 });
            const targetsData = JSON.parse(targetsResult.text);
            lines.push('🔥 SLOWEST TARGETS');
            lines.push('─────────────────────────────────────────────────────');
            for (const [name, info] of Object.entries(targetsData as Record<string, any>)) {
                const dur = info.inclusiveDurationMs || 0;
                const count = info.executionCount || 1;
                const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`;
                lines.push(`  ${name.padEnd(40)} ${durStr.padStart(8)}  (×${count})`);
            }
        } catch {
            lines.push('  (could not load targets)');
        }
        lines.push('');

        try {
            const tasksResult = await this.mcpClient!.callTool('get_expensive_tasks', { top_number: 10 });
            const tasksData = JSON.parse(tasksResult.text);
            lines.push('🔧 SLOWEST TASKS');
            lines.push('─────────────────────────────────────────────────────');
            for (const [name, info] of Object.entries(tasksData as Record<string, any>)) {
                const dur = info.inclusiveDurationMs || info.durationMs || 0;
                const count = info.executionCount || 1;
                const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`;
                lines.push(`  ${name.padEnd(40)} ${durStr.padStart(8)}  (×${count})`);
            }
        } catch {
            lines.push('  (could not load tasks)');
        }

        lines.push('');
        lines.push('═══════════════════════════════════════════════════════');
        lines.push('  Use @binlog in Copilot Chat for deeper analysis');
        lines.push('═══════════════════════════════════════════════════════');

        return lines.join('\n');
    }

    private async renderProjects(): Promise<string> {
        const result = await this.mcpClient!.callTool('list_projects');
        return this.formatSection('PROJECTS', result.text);
    }

    private async renderDiagnostics(type: 'errors' | 'warnings'): Promise<string> {
        const result = await this.mcpClient!.callTool('get_diagnostics');
        return this.formatSection(type.toUpperCase(), result.text);
    }

    private async renderExpensive(tool: string, title: string): Promise<string> {
        const result = await this.mcpClient!.callTool(tool, { top_number: 20 });
        return this.formatSection(title.toUpperCase(), result.text);
    }

    private formatSection(title: string, jsonText: string): string {
        const lines: string[] = [];
        lines.push(`═══ ${title} ═══`);
        lines.push('');
        try {
            lines.push(JSON.stringify(JSON.parse(jsonText), null, 2));
        } catch {
            lines.push(jsonText);
        }
        return lines.join('\n');
    }

    dispose() {
        this._onDidChange.dispose();
    }
}

/** Opens a binlog document in the editor */
export async function openBinlogDocument(section: string, binlogName: string): Promise<void> {
    const uri = vscode.Uri.parse(`${SCHEME}:${section}?${encodeURIComponent(binlogName)}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
    });
}

export const BINLOG_SCHEME = SCHEME;
