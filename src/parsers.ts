/** Pure parsing functions extracted for testability */

export interface ParsedProject {
    id: string;
    label: string;
    filePath: string;
    directory: string;
    description?: string;
    totalMs: number;
    targetNames: string;
}

export interface ParsedDiagnostic {
    label: string;
    description: string;
    tooltip: string;
    severity: 'error' | 'warning';
    code: string;
    message: string;
    file: string;
    line: string;
}

export function extractFileName(path: string): string {
    const name = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    return name || path;
}

export function extractDirectory(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    if (parts.length <= 1) { return ''; }
    parts.pop();
    const segments = parts.filter(Boolean);
    if (segments.length <= 3) { return segments.join('/'); }
    return '…/' + segments.slice(-3).join('/');
}

export function isError(severity: string): boolean {
    const s = String(severity).toLowerCase();
    return s === 'error' || s === 'criticalerror' || s === 'warningaserror';
}

export function isWarning(severity: string): boolean {
    const s = String(severity).toLowerCase();
    return s === 'warning' || s === 'warn';
}

export function parseProjects(data: unknown): ParsedProject[] {
    const items: ParsedProject[] = [];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [id, proj] of Object.entries(data as Record<string, any>)) {
            const file = proj.projectFile || proj.ProjectFile || '';
            const targets = proj.entryTargets || {};
            const totalMs = Math.max(0, Object.values(targets).reduce(
                (sum: number, t: any) => sum + (t.durationMs || 0), 0
            ));
            const targetNames = Object.values(targets)
                .map((t: any) => t.targetName)
                .join(', ');
            const filePath = String(file);
            const dirPath = extractDirectory(filePath);
            const timeStr = totalMs > 0 ? `${(totalMs / 1000).toFixed(1)}s` : '';
            const desc = dirPath
                ? (timeStr ? `${dirPath}  ${timeStr}` : dirPath)
                : (timeStr || undefined);
            items.push({
                id,
                label: extractFileName(filePath),
                filePath,
                directory: dirPath,
                description: desc,
                totalMs,
                targetNames,
            });
        }
    }
    // Deduplicate by id (not label — same filename in different dirs should be kept)
    const seen = new Set<string>();
    return items.filter(i => {
        if (seen.has(i.id)) { return false; }
        seen.add(i.id);
        return true;
    });
}

export function parseDiagnostics(data: unknown): { errors: ParsedDiagnostic[]; warnings: ParsedDiagnostic[] } {
    const errors: ParsedDiagnostic[] = [];
    const warnings: ParsedDiagnostic[] = [];
    if (data && typeof data === 'object') {
        const obj = data as Record<string, any>;
        const diagnostics = obj.diagnostics || [];
        if (Array.isArray(diagnostics)) {
            for (const d of diagnostics) {
                const sev = d.severity || d.Severity || d.level || '';
                const code = String(d.code || d.Code || '');
                const msg = String(d.message || d.Message || d.text || '');
                const file = String(d.file || d.File || d.projectFile || '');
                const line = String(d.lineNumber || d.LineNumber || d.line || '');
                const label = code ? `${code}: ${msg}` : msg;
                const loc = file ? `${extractFileName(file)}${line ? ':' + line : ''}` : '';
                const item: ParsedDiagnostic = {
                    label: label.length > 120 ? label.substring(0, 117) + '...' : label,
                    description: loc,
                    tooltip: `${label}\n${file}${line ? ':' + line : ''}`,
                    severity: isError(sev) ? 'error' : 'warning',
                    code,
                    message: msg,
                    file,
                    line,
                };
                if (isError(sev)) {
                    errors.push(item);
                } else {
                    warnings.push(item);
                }
            }
        }
    }
    return { errors, warnings };
}

/**
 * Extract candidate workspace root folders from project file paths.
 * Returns paths sorted by frequency (most projects share the root).
 */
export function getProjectRootCandidates(projectPaths: string[]): string[] {
    const roots = new Map<string, number>();
    for (const fullPath of projectPaths) {
        if (!fullPath || fullPath.length < 4) { continue; }
        const normalized = fullPath.replace(/\\/g, '/');
        const parts = normalized.split('/');
        for (let depth = 2; depth <= Math.min(5, parts.length - 1); depth++) {
            const candidate = parts.slice(0, depth + 1).join('/');
            roots.set(candidate, (roots.get(candidate) || 0) + 1);
        }
    }
    return [...roots.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([path]) => path)
        .filter(p => p.length > 3)
        .slice(0, 10);
}

/** Parsed diagnostic from MCP get_diagnostics response */
export interface McpDiagnostic {
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

/**
 * Parse raw MCP get_diagnostics response into typed diagnostics.
 * Pure function — no VS Code dependencies.
 */
export function parseMcpDiagnostics(data: unknown): McpDiagnostic[] {
    const results: McpDiagnostic[] = [];
    if (!data || typeof data !== 'object') { return results; }

    const obj = data as Record<string, any>;
    const diagnostics = obj.diagnostics || [];
    if (!Array.isArray(diagnostics)) { return results; }

    for (const d of diagnostics) {
        const sev = String(d.severity || d.Severity || d.level || '').toLowerCase();
        const severity: 'error' | 'warning' | 'info' =
            /error/i.test(sev) ? 'error' : /warn/i.test(sev) ? 'warning' : 'info';

        const rawLine = d.lineNumber ?? d.LineNumber ?? d.line;
        const rawCol = d.columnNumber ?? d.ColumnNumber ?? d.column;

        results.push({
            file: String(d.file || d.File || d.projectFile || ''),
            line: rawLine != null ? (Number.isFinite(Number(rawLine)) ? Number(rawLine) : 1) : 1,
            column: rawCol != null ? (Number.isFinite(Number(rawCol)) ? Number(rawCol) : 1) : 1,
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

/**
 * Check if a file was actually modified by comparing mtime.
 * Returns true if the file was modified since the given mtime.
 * Pure function — caller provides stat result.
 */
export function wasFileModified(currentMtimeMs: number, previousMtimeMs: number): boolean {
    return currentMtimeMs !== previousMtimeMs;
}

/**
 * Filter diagnostics by minimum severity level.
 * Pure function — no VS Code dependencies.
 */
export function filterDiagnosticsBySeverity(
    diagnostics: McpDiagnostic[],
    minSeverity: string
): McpDiagnostic[] {
    const levels: Record<string, number> = { 'error': 0, 'warning': 1, 'info': 2 };
    const minLevel = levels[minSeverity.toLowerCase()] ?? 1;

    return diagnostics.filter(d => {
        const diagLevel = levels[d.severity.toLowerCase()] ?? 2;
        return diagLevel <= minLevel;
    });
}

/**
 * Compute comparison data between two sets of performance items.
 * Returns unified list with delta percentages.
 */
export interface ComparisonItem {
    name: string;
    durationA: number;
    durationB: number;
    deltaPct: number;
    status: 'faster' | 'slower' | 'same' | 'new' | 'removed';
}

export function computePerfComparison(
    mapA: Map<string, number>,
    mapB: Map<string, number>,
    thresholdPct: number = 5
): ComparisonItem[] {
    // Merge keys case-insensitively, preserving original casing from mapA or mapB
    const nameMap = new Map<string, string>(); // lowercase → original
    for (const k of mapA.keys()) { nameMap.set(k.toLowerCase(), k); }
    for (const k of mapB.keys()) { if (!nameMap.has(k.toLowerCase())) { nameMap.set(k.toLowerCase(), k); } }
    const allNames = [...nameMap.values()];

    // Build case-insensitive lookup
    const getA = (name: string) => {
        for (const [k, v] of mapA) { if (k.toLowerCase() === name.toLowerCase()) { return v; } }
        return 0;
    };
    const getB = (name: string) => {
        for (const [k, v] of mapB) { if (k.toLowerCase() === name.toLowerCase()) { return v; } }
        return 0;
    };

    return allNames.map(name => {
        const a = getA(name);
        const b = getB(name);
        const deltaPct = a > 0 ? ((b - a) / a * 100) : (b > 0 ? 100 : 0);
        let status: ComparisonItem['status'] = 'same';
        if (a === 0 && b > 0) { status = 'new'; }
        else if (a > 0 && b === 0) { status = 'removed'; }
        else if (deltaPct > thresholdPct) { status = 'slower'; }
        else if (deltaPct < -thresholdPct) { status = 'faster'; }

        return { name, durationA: a, durationB: b, deltaPct, status };
    }).sort((a, b) =>
        Math.max(b.durationA, b.durationB) - Math.max(a.durationA, a.durationB)
    );
}

/**
 * Checks if a workspace folder matches a binlog's location.
 * Returns true if binlog dir is a parent/child of workspace, or vice versa.
 */
export function workspaceMatchesBinlog(workspacePath: string | undefined, binlogPath: string): boolean {
    if (!workspacePath) { return false; }
    const path = require('path');
    const binlogDir = path.dirname(binlogPath).toLowerCase().replace(/[/\\]+$/, '');
    const ws = workspacePath.toLowerCase().replace(/[/\\]+$/, '');
    if (binlogDir === ws) { return true; }
    const sep = path.sep.toLowerCase();
    return binlogDir.startsWith(ws + sep) || ws.startsWith(binlogDir + sep);
}

/**
 * Determines the best source label for the Projects tree node.
 * Shows workspace name if it matches the binlog, otherwise the binlog's parent dir name.
 */
export function getSourceLabel(
    workspacePath: string | undefined,
    workspaceName: string | undefined,
    binlogPath: string
): { label: string; tooltip: string } {
    const path = require('path');
    const binlogDir = path.dirname(binlogPath);

    if (workspacePath && workspaceMatchesBinlog(workspacePath, binlogPath)) {
        return {
            label: workspaceName || path.basename(workspacePath),
            tooltip: `Workspace: ${workspacePath}`,
        };
    }

    return {
        label: path.basename(binlogDir),
        tooltip: `Binlog source: ${binlogDir}`,
    };
}

/**
 * Validates that a file path looks like a binlog file.
 * Returns an error message if invalid, or null if valid.
 */
export function validateBinlogPath(filePath: string): string | null {
    if (!filePath || filePath.trim().length === 0) {
        return 'File path is empty';
    }
    if (!filePath.toLowerCase().endsWith('.binlog')) {
        return `Expected a .binlog file, got: ${extractFileName(filePath)}`;
    }
    return null;
}