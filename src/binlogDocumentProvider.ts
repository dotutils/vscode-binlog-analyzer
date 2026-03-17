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
                    content = await this.renderExpensive('binlog_expensive_targets', 'Slowest Targets');
                    break;
                case '/tasks':
                    content = await this.renderExpensive('binlog_expensive_tasks', 'Slowest Tasks');
                    break;
                default:
                    if (section.startsWith('/project/')) {
                        const projectId = decodeURIComponent(section.substring('/project/'.length));
                        content = await this.renderProjectDetails(projectId, binlogName);
                    } else {
                        content = await this.renderSummary(binlogName);
                    }
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

        // Projects — filter out restore-phase entries and show compact summary
        try {
            const projResult = await this.mcpClient!.callTool('binlog_projects');
            const projData = JSON.parse(projResult.text);
            const projects = Object.entries(projData as Record<string, any>);

            // Deduplicate by project file, merging targets
            const byFile = new Map<string, { ids: string[]; targets: Map<string, number>; totalMs: number }>();
            for (const [id, proj] of projects) {
                const p = proj as any;
                const file = p.projectFile || '';
                if (!byFile.has(file)) {
                    byFile.set(file, { ids: [], targets: new Map(), totalMs: 0 });
                }
                const entry = byFile.get(file)!;
                entry.ids.push(id);
                const targets = p.entryTargets || {};
                for (const t of Object.values(targets) as any[]) {
                    const name = t.targetName || '';
                    const dur = t.durationMs || 0;
                    entry.targets.set(name, (entry.targets.get(name) || 0) + dur);
                    entry.totalMs += dur;
                }
            }

            // Filter out restore-only entries (all targets are restore-related)
            const isRestoreTarget = (name: string) =>
                /restore/i.test(name) || name === '_IsProjectRestoreSupported';
            const buildProjects = [...byFile.entries()].filter(([, info]) => {
                if (info.targets.size === 0) { return false; }
                const allRestore = [...info.targets.keys()].every(isRestoreTarget);
                return !allRestore;
            });

            // Sort by duration descending
            buildProjects.sort((a, b) => b[1].totalMs - a[1].totalMs);

            lines.push(`📁 PROJECTS (${buildProjects.length})`);
            lines.push('─────────────────────────────────────────────────────');

            // Collect diagnostics for per-project error/warning counts
            let diagsByProject: Map<string, { errors: number; warnings: number }> | undefined;
            try {
                const [errResult, warnResult] = await Promise.allSettled([
                    this.mcpClient!.callTool('binlog_errors'),
                    this.mcpClient!.callTool('binlog_warnings'),
                ]);
                diagsByProject = new Map();
                for (const result of [errResult, warnResult]) {
                    if (result.status !== 'fulfilled') { continue; }
                    const diagData = JSON.parse(result.value.text);
                    const diags = Array.isArray(diagData) ? diagData : diagData.diagnostics || diagData.errors || diagData.warnings || [];
                    const isError = result === errResult;
                    for (const d of diags) {
                        const f = (d.projectFile || d.file || '').replace(/\\/g, '/');
                        const projName = f.split('/').pop()?.toLowerCase() || '';
                        if (!diagsByProject.has(projName)) {
                            diagsByProject.set(projName, { errors: 0, warnings: 0 });
                        }
                        const counts = diagsByProject.get(projName)!;
                        if (isError) { counts.errors++; }
                        else { counts.warnings++; }
                    }
                }
            } catch { /* non-fatal */ }

            for (const [file, info] of buildProjects) {
                const name = file.split(/[/\\]/).pop() || file;
                const durStr = info.totalMs >= 1000
                    ? `${(info.totalMs / 1000).toFixed(1)}s`
                    : info.totalMs >= 100 ? `${info.totalMs}ms` : '';

                // Build target list, excluding restore targets
                const buildTargets = [...info.targets.entries()]
                    .filter(([t]) => !isRestoreTarget(t))
                    .map(([t]) => t);

                // Per-project diagnostics
                const projKey = name.toLowerCase();
                const diag = diagsByProject?.get(projKey);
                const diagParts: string[] = [];
                if (diag && diag.errors > 0) { diagParts.push(`${diag.errors}E`); }
                if (diag && diag.warnings > 0) { diagParts.push(`${diag.warnings}W`); }
                const diagStr = diagParts.length > 0 ? `  [${diagParts.join(' ')}]` : '';

                const statusIcon = diag && diag.errors > 0 ? '❌' : '✅';
                lines.push(`  ${statusIcon} ${name}${durStr ? '  ' + durStr : ''}${diagStr}`);
                if (buildTargets.length > 0 && buildTargets[0] !== 'Build') {
                    lines.push(`     → ${buildTargets.join(', ')}`);
                }
            }
            if (buildProjects.length === 0) {
                lines.push('  (no build projects found)');
            }
        } catch {
            lines.push('  (could not load projects)');
        }
        lines.push('');

        // Diagnostics
        try {
            const [errResult, warnResult] = await Promise.allSettled([
                this.mcpClient!.callTool('binlog_errors'),
                this.mcpClient!.callTool('binlog_warnings'),
            ]);

            const parseItems = (r: PromiseSettledResult<any>) => {
                if (r.status !== 'fulfilled') { return []; }
                const d = JSON.parse(r.value.text);
                return Array.isArray(d) ? d : d.diagnostics || d.errors || d.warnings || [];
            };
            const errors = parseItems(errResult);
            const warnings = parseItems(warnResult);

            lines.push(`❌ ERRORS (${errors.length})`);
            lines.push('─────────────────────────────────────────────────────');
            if (errors.length === 0) {
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

            lines.push(`⚠️  WARNINGS (${warnings.length})`);
            lines.push('─────────────────────────────────────────────────────');
            if (warnings.length === 0) {
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
            const targetsResult = await this.mcpClient!.callTool('binlog_expensive_targets', { top_number: 10 });
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
            const tasksResult = await this.mcpClient!.callTool('binlog_expensive_tasks', { top_number: 10 });
            const tasksData = JSON.parse(tasksResult.text);
            lines.push('🔧 SLOWEST TASKS');
            lines.push('─────────────────────────────────────────────────────');
            for (const [name, info] of Object.entries(tasksData as Record<string, any>)) {
                const dur = info.inclusiveDurationMs || info.totalDurationMs || info.durationMs || info.exclusiveDurationMs || 0;
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

    private async renderProjectDetails(projectId: string, projectFile: string): Promise<string> {
        const lines: string[] = [];
        lines.push('═══════════════════════════════════════════════════════');
        lines.push(`  Project: ${projectFile}`);
        lines.push('═══════════════════════════════════════════════════════');
        lines.push('');

        // Get project info from list_projects
        try {
            const projResult = await this.mcpClient!.callTool('binlog_projects');            const projData = JSON.parse(projResult.text);
            const project = projData[projectId];
            if (project) {
                const file = project.projectFile || '';
                lines.push(`📁 Project File: ${file}`);
                lines.push(`🆔 Project ID: ${projectId}`);
                lines.push('');

                const targets = project.entryTargets || {};
                const targetEntries = Object.entries(targets);
                if (targetEntries.length > 0) {
                    lines.push('🎯 ENTRY TARGETS');
                    lines.push('─────────────────────────────────────────────────────');
                    for (const [, t] of targetEntries) {
                        const target = t as any;
                        const name = target.targetName || '';
                        const dur = target.durationMs || 0;
                        const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`;
                        lines.push(`  ${name.padEnd(40)} ${durStr.padStart(8)}`);
                    }
                    lines.push('');
                }
            }
        } catch {
            lines.push('  (could not load project info)');
            lines.push('');
        }

        // Get project build time
        try {
            const buildTimeResult = await this.mcpClient!.callTool('binlog_expensive_projects', {
                project_path: projectFile,
            });
            const buildTimeData = JSON.parse(buildTimeResult.text);
            lines.push('⏱️  BUILD TIME');
            lines.push('─────────────────────────────────────────────────────');
            lines.push(JSON.stringify(buildTimeData, null, 2));
            lines.push('');
        } catch {
            // Tool may not exist or may fail — non-fatal
        }

        // Get diagnostics and filter for this project
        try {
            const [errResult, warnResult] = await Promise.allSettled([
                this.mcpClient!.callTool('binlog_errors'),
                this.mcpClient!.callTool('binlog_warnings'),
            ]);

            const parseItems = (r: PromiseSettledResult<any>) => {
                if (r.status !== 'fulfilled') { return []; }
                const d = JSON.parse(r.value.text);
                return Array.isArray(d) ? d : d.diagnostics || d.errors || d.warnings || [];
            };

            const allErrors = parseItems(errResult);
            const allWarnings = parseItems(warnResult);

            const matchesProject = (d: any) => {
                const f = (d.file || d.File || d.projectFile || '').toLowerCase();
                return f.includes(projectFile.toLowerCase()) ||
                    f.includes(projectFile.split(/[/\\]/).pop()?.toLowerCase() || '');
            };
            const errors = allErrors.filter(matchesProject);
            const warnings = allWarnings.filter(matchesProject);

            if (errors.length > 0) {
                lines.push(`❌ ERRORS (${errors.length})`);
                lines.push('─────────────────────────────────────────────────────');
                for (const e of errors) {
                    const code = e.code || '';
                    const msg = e.message || '';
                    const file = e.file || '';
                    const ln = e.lineNumber || '';
                    lines.push(`  ${code}: ${msg}`);
                    if (file) { lines.push(`    📄 ${file}${ln ? ':' + ln : ''}`); }
                    lines.push('');
                }
            }

            if (warnings.length > 0) {
                lines.push(`⚠️  WARNINGS (${warnings.length})`);
                lines.push('─────────────────────────────────────────────────────');
                for (const w of warnings) {
                    const code = w.code || '';
                    const msg = w.message || '';
                    const file = w.file || '';
                    const ln = w.lineNumber || '';
                    lines.push(`  ${code}: ${msg}`);
                    if (file) { lines.push(`    📄 ${file}${ln ? ':' + ln : ''}`); }
                    lines.push('');
                }
            }

            if (errors.length === 0 && warnings.length === 0) {
                lines.push('✅ No diagnostics for this project');
                lines.push('');
            }
        } catch {
            lines.push('  (could not load diagnostics)');
            lines.push('');
        }

        lines.push('═══════════════════════════════════════════════════════');
        lines.push('  Use @binlog in Copilot Chat for deeper analysis');
        lines.push('═══════════════════════════════════════════════════════');

        return lines.join('\n');
    }

    private async renderProjects(): Promise<string> {
        const result = await this.mcpClient!.callTool('binlog_projects');
        return this.formatSection('PROJECTS', result.text);
    }

    private async renderDiagnostics(type: 'errors' | 'warnings'): Promise<string> {
        const tool = type === 'errors' ? 'binlog_errors' : 'binlog_warnings';
        const result = await this.mcpClient!.callTool(tool);
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
