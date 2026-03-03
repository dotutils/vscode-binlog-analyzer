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
