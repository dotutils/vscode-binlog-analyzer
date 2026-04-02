import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as telemetry from './telemetry';

export interface BuildCheckResult {
    code: string;
    severity: 'error' | 'warning' | 'suggestion';
    message: string;
    file?: string;
    line?: number;
    column?: number;
    project?: string;
}

export interface BuildCheckSummary {
    results: BuildCheckResult[];
    sdkVersion: string;
    binlogPath: string;
    durationMs: number;
}

export interface PropertyTrackingLevel {
    hasReassignment: boolean;
    hasInitialValues: boolean;
    hasEnvReads: boolean;
    level: number;
}

let buildCheckDiagnostics: vscode.DiagnosticCollection | undefined;

export function initBuildCheckDiagnostics(): vscode.DiagnosticCollection {
    if (!buildCheckDiagnostics) {
        buildCheckDiagnostics = vscode.languages.createDiagnosticCollection('msbuild-buildcheck');
    }
    return buildCheckDiagnostics;
}

export function getBuildCheckDiagnostics(): vscode.DiagnosticCollection | undefined {
    return buildCheckDiagnostics;
}

export async function detectSdkVersion(): Promise<{ supported: boolean; sdkVersion: string }> {
    return new Promise((resolve) => {
        cp.execFile('dotnet', ['--version'], { timeout: 10000, shell: true }, (err, stdout) => {
            if (err) {
                resolve({ supported: false, sdkVersion: 'unknown' });
                return;
            }
            const version = stdout.trim();
            const parts = version.split('.');
            const major = parseInt(parts[0], 10) || 0;
            const minor = parseInt(parts[1], 10) || 0;
            const patch = parseInt(parts[2], 10) || 0;
            const supported = major > 9 || (major === 9 && (minor > 0 || patch >= 100));
            resolve({ supported, sdkVersion: version });
        });
    });
}

export async function runBuildCheck(binlogPath: string): Promise<BuildCheckSummary> {
    const start = Date.now();
    const { supported, sdkVersion } = await detectSdkVersion();

    if (!supported) {
        return {
            results: [],
            sdkVersion,
            binlogPath,
            durationMs: Date.now() - start,
        };
    }

    return new Promise((resolve) => {
        const args = ['build', binlogPath, '/check'];
        const proc = cp.spawn('dotnet', args, {
            cwd: path.dirname(binlogPath),
            shell: true,
            timeout: 120000,
        });

        let output = '';
        proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });

        proc.on('close', () => {
            const results = parseBuildCheckOutput(output);
            resolve({
                results,
                sdkVersion,
                binlogPath,
                durationMs: Date.now() - start,
            });
        });

        proc.on('error', () => {
            resolve({
                results: [],
                sdkVersion,
                binlogPath,
                durationMs: Date.now() - start,
            });
        });
    });
}

function parseBuildCheckOutput(output: string): BuildCheckResult[] {
    const results: BuildCheckResult[] = [];
    // Match MSBuild diagnostic output patterns:
    // path\to\file.csproj(12,5): warning BC0102: message
    // path\to\file.csproj : warning BC0102: message
    // warning BC0102: message
    const lineRegex = /^(.+?)\((\d+),(\d+)\)\s*:\s*(error|warning|message)\s+(BC\d+)\s*:\s*(.+)$/gm;
    const noLocRegex = /^(.+?)\s*:\s*(error|warning|message)\s+(BC\d+)\s*:\s*(.+)$/gm;
    const bareRegex = /^\s*(error|warning|message)\s+(BC\d+)\s*:\s*(.+)$/gm;

    let match;
    while ((match = lineRegex.exec(output)) !== null) {
        results.push({
            file: match[1].trim(),
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
            severity: mapSeverity(match[4]),
            code: match[5],
            message: match[6].trim(),
        });
    }

    while ((match = noLocRegex.exec(output)) !== null) {
        const code = match[3];
        if (results.some(r => r.code === code && r.file === match![1].trim())) { continue; }
        results.push({
            file: match[1].trim(),
            severity: mapSeverity(match[2]),
            code,
            message: match[4].trim(),
        });
    }

    while ((match = bareRegex.exec(output)) !== null) {
        const code = match[2];
        if (results.some(r => r.code === code)) { continue; }
        results.push({
            severity: mapSeverity(match[1]),
            code,
            message: match[3].trim(),
        });
    }

    return results;
}

function mapSeverity(s: string): 'error' | 'warning' | 'suggestion' {
    switch (s.toLowerCase()) {
        case 'error': return 'error';
        case 'warning': return 'warning';
        default: return 'suggestion';
    }
}

export function pushBuildCheckToProblemsPanel(
    summary: BuildCheckSummary,
    collection: vscode.DiagnosticCollection
): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const result of summary.results) {
        const filePath = result.file;
        if (!filePath) { continue; }

        let uri: vscode.Uri;
        try {
            uri = path.isAbsolute(filePath)
                ? vscode.Uri.file(filePath)
                : vscode.Uri.file(path.join(path.dirname(summary.binlogPath), filePath));
        } catch {
            continue;
        }

        const key = uri.toString();
        const diags = byFile.get(key) || [];

        const severity = result.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : result.severity === 'warning'
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information;

        const line = Math.max(0, (result.line || 1) - 1);
        const col = Math.max(0, (result.column || 1) - 1);

        const diag = new vscode.Diagnostic(
            new vscode.Range(line, col, line, col + 100),
            `${result.message}`,
            severity
        );
        diag.source = 'MSBuild BuildCheck';
        diag.code = result.code;
        diags.push(diag);
        byFile.set(key, diags);
    }

    collection.clear();
    for (const [uriStr, diags] of byFile) {
        collection.set(vscode.Uri.parse(uriStr), diags);
    }
}

export function formatBuildCheckForChat(summary: BuildCheckSummary): string {
    if (summary.results.length === 0) {
        return '✅ **BuildCheck passed** — no issues found.\n';
    }

    const grouped = new Map<string, BuildCheckResult[]>();
    for (const r of summary.results) {
        const list = grouped.get(r.code) || [];
        list.push(r);
        grouped.set(r.code, list);
    }

    const codeDescriptions: Record<string, string> = {
        BC0101: 'Shared output path',
        BC0102: 'Double writes',
        BC0103: 'Environment variable usage',
        BC0104: 'Reference instead of ProjectReference',
        BC0105: 'EmbeddedResource missing Culture',
        BC0106: 'CopyToOutputDirectory=Always',
        BC0107: 'TargetFramework + TargetFrameworks conflict',
        BC0201: 'Undefined property usage',
        BC0202: 'Property used before declared',
        BC0203: 'Property declared but never used',
    };

    const lines: string[] = [];
    lines.push(`⚠️ **BuildCheck found ${summary.results.length} issue(s):**\n`);

    for (const [code, items] of grouped) {
        const desc = codeDescriptions[code] || code;
        const icon = items[0].severity === 'error' ? '🔴' : items[0].severity === 'warning' ? '🟡' : '🔵';
        lines.push(`### ${icon} ${code}: ${desc} (${items.length})\n`);
        for (const item of items.slice(0, 5)) {
            const loc = item.file
                ? item.line
                    ? `\`${path.basename(item.file)}:${item.line}\``
                    : `\`${path.basename(item.file)}\``
                : '';
            lines.push(`- ${item.message} ${loc}`);
        }
        if (items.length > 5) {
            lines.push(`- ... and ${items.length - 5} more`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

export async function buildWithPropertyTracking(
    wsFolder: string,
    buildTarget: string | undefined,
    binlogName: string,
    trackingLevel: number = 15
): Promise<string> {
    const safeName = binlogName.endsWith('.binlog') ? binlogName : `${binlogName}.binlog`;
    const binlogPath = path.join(wsFolder, safeName);

    const buildArg = buildTarget ? `"${buildTarget}"` : '';
    const cmd = `dotnet build ${buildArg} /bl:"${binlogPath}"`;

    const terminal = vscode.window.createTerminal({
        name: 'Build with Property Tracking',
        cwd: wsFolder,
        env: {
            MsBuildLogPropertyTracking: String(trackingLevel),
        },
    });
    terminal.show();
    terminal.sendText(cmd);

    return binlogPath;
}
