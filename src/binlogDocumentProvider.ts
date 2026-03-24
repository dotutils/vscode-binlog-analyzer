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

        // Build overview
        try {
            const overviewResult = await this.mcpClient!.callTool('binlog_overview');
            const ov = JSON.parse(overviewResult.text);
            const status = ov.succeeded ? '✅ BUILD SUCCEEDED' : '❌ BUILD FAILED';
            const dur = ov.duration || '';
            // Parse "HH:MM:SS.xxx" duration to a readable format
            const durMatch = dur.match(/(\d+):(\d+):(\d+)/);
            let durStr = dur;
            if (durMatch) {
                const h = parseInt(durMatch[1]);
                const m = parseInt(durMatch[2]);
                const s = parseInt(durMatch[3]);
                durStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
            }

            lines.push(`${status}  ·  ${durStr}  ·  MSBuild ${ov.msBuildVersion || ''}`.trimEnd());
            if (ov.errorCount > 0 || ov.warningCount > 0) {
                const parts: string[] = [];
                if (ov.errorCount > 0) { parts.push(`${ov.errorCount} error${ov.errorCount > 1 ? 's' : ''}`); }
                if (ov.warningCount > 0) { parts.push(`${ov.warningCount} warning${ov.warningCount > 1 ? 's' : ''}`); }
                lines.push(`  ${parts.join('  ·  ')}`);
            }
            lines.push('');
        } catch {
            // overview not available — continue without it
        }

        // Projects
        try {
            const projResult = await this.mcpClient!.callTool('binlog_projects');
            const projData = JSON.parse(projResult.text);

            // Handle both formats: array (BinlogInsights) and object (baronfel)
            let projectFiles: string[] = [];
            if (Array.isArray(projData)) {
                // BinlogInsights: [{ fullPath, isLegacy }, ...]
                projectFiles = projData.map((p: any) => p.fullPath || '').filter(Boolean);
            } else {
                // baronfel: { "id": { projectFile, entryTargets }, ... }
                projectFiles = Object.values(projData as Record<string, any>)
                    .map((p: any) => p.projectFile || '')
                    .filter(Boolean);
            }

            // Deduplicate by filename
            const seen = new Set<string>();
            const uniqueFiles = projectFiles.filter(f => {
                const name = f.split(/[/\\]/).pop()?.toLowerCase() || '';
                if (seen.has(name)) { return false; }
                seen.add(name);
                return true;
            });

            lines.push(`📁 PROJECTS (${uniqueFiles.length})`);
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

            for (const file of uniqueFiles) {
                const name = file.split(/[/\\]/).pop() || file;

                // Per-project diagnostics
                const projKey = name.toLowerCase();
                const diag = diagsByProject?.get(projKey);
                const diagParts: string[] = [];
                if (diag && diag.errors > 0) { diagParts.push(`${diag.errors}E`); }
                if (diag && diag.warnings > 0) { diagParts.push(`${diag.warnings}W`); }
                const diagStr = diagParts.length > 0 ? `  [${diagParts.join(' ')}]` : '';

                const statusIcon = diag && diag.errors > 0 ? '❌' : '✅';
                lines.push(`  ${statusIcon} ${name}${diagStr}`);
            }
            if (uniqueFiles.length === 0) {
                lines.push('  (no projects found)');
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
            for (const item of this.parsePerfEntries(targetsData)) {
                lines.push(`  ${item.name.padEnd(40)} ${item.durStr.padStart(8)}  (×${item.count})`);
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
            for (const item of this.parsePerfEntries(tasksData)) {
                lines.push(`  ${item.name.padEnd(40)} ${item.durStr.padStart(8)}  (×${item.count})`);
            }
        } catch {
            lines.push('  (could not load tasks)');
        }

        // Analyzers
        try {
            const analyzersResult = await this.mcpClient!.callTool('binlog_expensive_analyzers', { limit: 10 });
            const analyzersData = JSON.parse(analyzersResult.text);
            const entries = this.parsePerfEntries(analyzersData);
            if (entries.length > 0) {
                lines.push('');
                lines.push('🔬 SLOWEST ANALYZERS');
                lines.push('─────────────────────────────────────────────────────');
                for (const a of entries) {
                    const shortName = a.name.length > 45 ? a.name.substring(0, 42) + '...' : a.name;
                    lines.push(`  ${shortName.padEnd(45)} ${a.durStr.padStart(8)}  (×${a.count})`);
                }
            }
        } catch {
            // No analyzer data — non-fatal
        }

        lines.push('');
        lines.push('═══════════════════════════════════════════════════════');
        lines.push('  Use @binlog in Copilot Chat for deeper analysis');
        lines.push('═══════════════════════════════════════════════════════');

        return lines.join('\n');
    }

    private async renderProjectDetails(projectId: string, projectFile: string): Promise<string> {
        const lines: string[] = [];
        const projectName = projectFile.split(/[/\\]/).pop() || projectFile;
        lines.push('═══════════════════════════════════════════════════════');
        lines.push(`  Project: ${projectName}`);
        lines.push('═══════════════════════════════════════════════════════');
        lines.push('');

        lines.push(`📁 Project File: ${projectFile}`);
        lines.push('');

        // Get per-project target times
        try {
            const targetTimesResult = await this.mcpClient!.callTool('binlog_project_target_times', {
                project: projectName,
            });
            const targetData = JSON.parse(targetTimesResult.text);
            const targets = Array.isArray(targetData) ? targetData
                : (targetData && typeof targetData === 'object') ? Object.entries(targetData).map(([k, v]: [string, any]) => ({ name: k, ...v }))
                : [];

            if (targets.length > 0) {
                // Calculate total build time from targets
                const totalMs = targets.reduce((sum: number, t: any) => sum + (t.inclusiveDurationMs || t.durationMs || 0), 0);
                if (totalMs > 0) {
                    const totalStr = totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`;
                    lines.push(`⏱️  BUILD TIME: ${totalStr}`);
                    lines.push('');
                }

                lines.push('🎯 TARGETS');
                lines.push('─────────────────────────────────────────────────────');
                for (const t of targets) {
                    const name = t.name || t.targetName || '';
                    const dur = t.inclusiveDurationMs || t.durationMs || 0;
                    const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`;
                    lines.push(`  ${name.padEnd(40)} ${durStr.padStart(8)}`);
                }
                lines.push('');
            }
        } catch {
            // Try fallback: binlog_expensive_projects for at least a total time
            try {
                const buildTimeResult = await this.mcpClient!.callTool('binlog_expensive_projects');
                const data = JSON.parse(buildTimeResult.text);
                const projects = Array.isArray(data) ? data : [];
                const match = projects.find((p: any) =>
                    (p.projectFile || p.fullPath || '').toLowerCase().includes(projectName.toLowerCase())
                );
                if (match) {
                    const dur = match.inclusiveDurationMs || 0;
                    const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`;
                    lines.push(`⏱️  BUILD TIME: ${durStr}`);
                    lines.push('');
                }
            } catch { /* non-fatal */ }
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

    /** Parse perf entries from both array (BinlogInsights) and object (baronfel) formats */
    private parsePerfEntries(data: unknown): Array<{ name: string; durStr: string; count: number }> {
        const items: Array<{ name: string; durStr: string; count: number; durMs: number }> = [];
        if (Array.isArray(data)) {
            for (const entry of data) {
                const name = entry.targetName || entry.taskName || entry.analyzerName || entry.name || '';
                const dur = entry.totalInclusiveMs || entry.totalDurationMs || entry.inclusiveDurationMs || entry.durationMs || 0;
                const count = entry.executionCount || 1;
                const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`;
                items.push({ name, durStr, count, durMs: dur });
            }
        } else if (data && typeof data === 'object') {
            for (const [name, info] of Object.entries(data as Record<string, any>)) {
                const dur = info.inclusiveDurationMs || info.totalDurationMs || info.durationMs || 0;
                const count = info.executionCount || 1;
                const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`;
                items.push({ name, durStr, count, durMs: dur });
            }
        }
        return items;
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
