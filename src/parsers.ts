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
    return path.split(/[/\\]/).pop() || path;
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
    return /error/i.test(String(severity));
}

export function isWarning(severity: string): boolean {
    return /warn/i.test(String(severity));
}

export function parseProjects(data: unknown): ParsedProject[] {
    const items: ParsedProject[] = [];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
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
    // Deduplicate by label
    const seen = new Set<string>();
    return items.filter(i => {
        if (seen.has(i.label)) { return false; }
        seen.add(i.label);
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
    const levels: Record<string, number> = { 'Error': 0, 'Warning': 1, 'Info': 2 };
    const minLevel = levels[minSeverity] ?? 1;

    return diagnostics.filter(d => {
        const diagLevel = levels[d.severity.charAt(0).toUpperCase() + d.severity.slice(1)] ?? 2;
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
    const allNames = [...new Set([...mapA.keys(), ...mapB.keys()])];

    return allNames.map(name => {
        const a = mapA.get(name) || 0;
        const b = mapB.get(name) || 0;
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
