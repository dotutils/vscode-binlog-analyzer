import * as vscode from 'vscode';
import { McpClient } from './mcpClient';

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDuration(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

interface BuildSummary {
    result: string;
    duration: string;
    durationSeconds: number;
    projectCount: number;
    errorCount: number;
    warningCount: number;
}

interface ErrorEntry {
    code: string;
    message: string;
    file: string;
    line: number;
    key: string;
}

interface PerfEntry {
    name: string;
    ms: number;
}

function parseSummary(text: string): BuildSummary {
    // The overview output is JSON: {"succeeded":true,"duration":"00:01:42","projectCount":2,...}
    try {
        const data = JSON.parse(text);
        const obj = data.overviewA || data.overviewB || data; // handle both compare wrapper and direct overview
        const succeeded = obj.succeeded ?? obj.Succeeded;
        const result = succeeded === true ? 'SUCCEEDED' : succeeded === false ? 'FAILED' : 'UNKNOWN';

        let durationSeconds = 0;
        let duration = '';
        const durStr = obj.duration || obj.Duration || '';
        if (durStr) {
            // Parse "00:01:42" or "00:04:53.1234" format (TimeSpan)
            const tsMatch = durStr.match(/^(\d+):(\d+):(\d+)/);
            if (tsMatch) {
                durationSeconds = parseInt(tsMatch[1]) * 3600 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
                const h = parseInt(tsMatch[1]);
                const m = parseInt(tsMatch[2]);
                const s = parseInt(tsMatch[3]);
                duration = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
            } else {
                // Try seconds
                const sec = parseFloat(durStr);
                if (!isNaN(sec)) {
                    durationSeconds = sec;
                    duration = sec >= 60 ? `${Math.floor(sec / 60)}m ${(sec % 60).toFixed(0)}s` : `${sec.toFixed(1)}s`;
                }
            }
        }
        // Also check durationSeconds / totalSeconds
        if (!durationSeconds && (obj.durationSeconds || obj.totalSeconds || obj.duration_seconds)) {
            durationSeconds = obj.durationSeconds || obj.totalSeconds || obj.duration_seconds;
            duration = durationSeconds >= 60 ? `${Math.floor(durationSeconds / 60)}m ${(durationSeconds % 60).toFixed(0)}s` : `${durationSeconds.toFixed(1)}s`;
        }

        // projectCount from overview is MSBuild evaluations (solution-level), not actual .csproj count.
        // Count unique project files from the projects array if available.
        let projectCount = 0;
        if (Array.isArray(obj.projects)) {
            const uniqueProjects = new Set(obj.projects.map((p: any) => {
                const f = p.projectFile || p.ProjectFile || '';
                return String(f).split(/[/\\]/).pop()?.toLowerCase() || '';
            }).filter((n: string) => n && !n.endsWith('.sln')));
            projectCount = uniqueProjects.size || obj.projects.length;
        }
        if (projectCount === 0) {
            projectCount = obj.projectCount ?? obj.ProjectCount ?? obj.project_count ?? 0;
        }

        return {
            result,
            duration,
            durationSeconds,
            projectCount,
            errorCount: obj.errorCount ?? obj.ErrorCount ?? obj.error_count ?? 0,
            warningCount: obj.warningCount ?? obj.WarningCount ?? obj.warning_count ?? 0,
        };
    } catch {
        // Fallback to regex parsing for non-JSON output
        const result = /failed/i.test(text) ? 'FAILED' : /succeeded/i.test(text) ? 'SUCCEEDED' : 'UNKNOWN';
        const durMatch = text.match(/Duration\**[:\s]+(\d+)\s*m\s*([\d.]+)\s*s/i) || text.match(/(?:in)\s+(\d+)\s*m\s*([\d.]+)\s*s/i);
        const secMatch = text.match(/Duration\**[:\s]+([\d.]+)\s*s/i);
        let duration = '';
        let durationSeconds = 0;
        if (durMatch) { durationSeconds = parseInt(durMatch[1]) * 60 + parseFloat(durMatch[2]); duration = `${durMatch[1]}m ${parseFloat(durMatch[2]).toFixed(0)}s`; }
        else if (secMatch) { durationSeconds = parseFloat(secMatch[1]); duration = `${durationSeconds.toFixed(1)}s`; }
        const projMatch = text.match(/Projects\**[:\s]+(\d+)/i) || text.match(/(\d+)\s+project/i);
        const errMatch = text.match(/Errors\**[:\s]+(\d+)/i) || text.match(/(\d+)\s+error/i);
        const warnMatch = text.match(/Warnings\**[:\s]+(\d+)/i) || text.match(/(\d+)\s+warning/i);
        return {
            result, duration, durationSeconds,
            projectCount: projMatch ? parseInt(projMatch[1]) : 0,
            errorCount: errMatch ? parseInt(errMatch[1]) : 0,
            warningCount: warnMatch ? parseInt(warnMatch[1]) : 0,
        };
    }
}

function parseErrors(text: string): ErrorEntry[] {
    try {
        const data = JSON.parse(text);
        const arr: unknown[] = Array.isArray(data) ? data : (data.diagnostics ?? []);
        return arr.map((e: any) => {
            const code = e.code || e.Code || '';
            const message = e.message || e.Message || '';
            const file = e.file || e.File || e.filePath || '';
            const line = e.line || e.Line || e.lineNumber || 0;
            return { code, message, file, line, key: `${code}|${file}|${line}` };
        });
    } catch {
        return [];
    }
}

function parsePerfData(text: string): PerfEntry[] {
    try {
        const data = JSON.parse(text);
        const entries: PerfEntry[] = [];
        if (Array.isArray(data)) {
            for (const entry of data) {
                const name = entry.name || entry.Name || entry.targetName || entry.TargetName || entry.taskName || entry.TaskName || '';
                const ms = entry.ExclusiveDurationMs || entry.exclusiveDurationMs || entry.totalExclusiveMs ||
                    entry.InclusiveDurationMs || entry.inclusiveDurationMs || entry.totalInclusiveMs ||
                    entry.totalDurationMs || entry.durationMs || entry.duration || 0;
                if (name) { entries.push({ name, ms }); }
            }
        } else {
            for (const [name, info] of Object.entries(data as Record<string, any>)) {
                const ms = info.ExclusiveDurationMs || info.exclusiveDurationMs || info.totalExclusiveMs ||
                    info.InclusiveDurationMs || info.inclusiveDurationMs || info.totalInclusiveMs ||
                    info.totalDurationMs || info.durationMs || info.duration || 0;
                entries.push({ name, ms });
            }
        }
        return entries;
    } catch {
        return [];
    }
}

interface PropertyDiff { name: string; valueA: string; valueB: string }
interface PackageDiff { name: string; versionA: string; versionB: string }

function parsePropertyDiffs(compareText: string): PropertyDiff[] {
    try {
        const data = JSON.parse(compareText);
        if (Array.isArray(data.propertyDiffs)) {
            return data.propertyDiffs.map((d: any) => ({
                name: d.name || d.Name || '',
                valueA: d.valueA || d.ValueA || d.oldValue || '(not set)',
                valueB: d.valueB || d.ValueB || d.newValue || '(not set)',
            }));
        }
    } catch { /* not JSON */ }
    // Fallback: line-based
    const diffs: PropertyDiff[] = [];
    for (const line of compareText.split('\n')) {
        const m = line.match(/^\s{2,}(\S[^:]*?):\s*(.+?)\s*(?:→|➔|->)+\s*(.+?)\s*$/);
        if (m) { diffs.push({ name: m[1].trim(), valueA: m[2].trim(), valueB: m[3].trim() }); }
    }
    return diffs;
}

function parsePropertyMap(text: string): Map<string, string> {
    const map = new Map<string, string>();
    try {
        const data = JSON.parse(text);
        const entries: any[] = Array.isArray(data) ? data : (data.properties ?? []);
        for (const e of entries) {
            const name = e.name || e.Name || '';
            const value = e.value || e.Value || '';
            if (name) { map.set(name, String(value)); }
        }
    } catch {
        // Try line-based parsing: "PropertyName = Value"
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*(\S+)\s*[=:]\s*(.*)$/);
            if (m) { map.set(m[1], m[2].trim()); }
        }
    }
    return map;
}

function renderPropertyDiffsTable(diffs: PropertyDiff[]): string {
    let html = `<div style="margin-bottom:12px"><input type="text" placeholder="Filter properties…" oninput="filterProps(this.value)" style="width:100%;padding:6px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#444);border-radius:4px;font-size:13px;box-sizing:border-box;" /></div>`;
    html += '<table class="summary-table prop-table"><tr><th>Property</th><th>Build A</th><th>Build B</th><th></th></tr>';
    for (const d of diffs) {
        html += `<tr class="prop-row"><td title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</td>
            <td class="val-a">${escapeHtml(d.valueA)}</td>
            <td class="val-b">${escapeHtml(d.valueB)}</td>
            <td>${aiBtn('property', d.name, 'explain', d.valueA, d.valueB)}</td></tr>`;
    }
    html += '</table>';
    return html;
}

function parsePackageDiffs(compareText: string): PackageDiff[] {
    try {
        const data = JSON.parse(compareText);
        const diffs: PackageDiff[] = [];
        const addPkgs = (arr: any[] | undefined) => {
            if (!Array.isArray(arr)) return;
            for (const d of arr) {
                diffs.push({
                    name: d.name || d.Name || d.packageName || '',
                    versionA: d.versionA || d.VersionA || d.oldVersion || '(not present)',
                    versionB: d.versionB || d.VersionB || d.newVersion || '(not present)',
                });
            }
        };
        addPkgs(data.packageDiffs);
        addPkgs(data.solutionPackageDiffs);
        return diffs;
    } catch { return []; }
}

function extractSection(text: string, sectionPattern: RegExp, nextSectionPattern?: RegExp): string {
    const start = text.search(sectionPattern);
    if (start < 0) { return ''; }
    const rest = text.substring(start);
    if (nextSectionPattern) {
        const lines = rest.split('\n');
        const result: string[] = [lines[0]];
        for (let i = 1; i < lines.length; i++) {
            if (nextSectionPattern.test(lines[i])) { break; }
            result.push(lines[i]);
        }
        return result.join('\n');
    }
    return rest;
}

function aiBtn(type: string, name: string, mode: 'explain' | 'fix', valueA = '', valueB = '', status = ''): string {
    const icon = mode === 'explain' ? '🔍' : '🔧';
    const title = mode === 'explain' ? 'Explain this change' : 'Suggest a fix';
    const escapedName = escapeHtml(name).replace(/'/g, "\\'");
    const escapedA = escapeHtml(valueA).replace(/'/g, "\\'");
    const escapedB = escapeHtml(valueB).replace(/'/g, "\\'");
    return `<button class="ai-btn" title="${title}" onclick="askAI('${mode}','${escapeHtml(type)}','${escapedName}','${escapedA}','${escapedB}','${escapeHtml(status)}')">${icon}</button>`;
}

function renderSummaryTab(summA: BuildSummary, summB: BuildSummary, failed: string[]): string {
    function delta(a: number, b: number, lowerIsBetter: boolean): string {
        if (a === 0 && b === 0) { return '—'; }
        const diff = b - a;
        if (diff === 0) { return '<span class="delta-neutral">0</span>'; }
        const pct = a > 0 ? ((diff / a) * 100).toFixed(1) : '';
        const sign = diff > 0 ? '+' : '';
        const isGood = lowerIsBetter ? diff < 0 : diff > 0;
        const cls = isGood ? 'delta-better' : 'delta-worse';
        return `<span class="${cls}">${sign}${diff}${pct ? ` (${sign}${pct}%)` : ''}</span>`;
    }

    function durationDelta(a: number, b: number): string {
        if (a === 0 && b === 0) { return '—'; }
        const diff = b - a;
        if (Math.abs(diff) < 0.05) { return '<span class="delta-neutral">0s</span>'; }
        const sign = diff > 0 ? '+' : '';
        const cls = diff > 0 ? 'delta-worse' : 'delta-better';
        const pct = a > 0 ? ` (${sign}${((diff / a) * 100).toFixed(1)}%)` : '';
        return `<span class="${cls}">${sign}${diff.toFixed(1)}s${pct}</span>`;
    }

    const resultColorA = summA.result === 'SUCCEEDED' ? 'var(--vscode-charts-green,#89d185)' : summA.result === 'FAILED' ? 'var(--vscode-charts-red,#f14c4c)' : 'inherit';
    const resultColorB = summB.result === 'SUCCEEDED' ? 'var(--vscode-charts-green,#89d185)' : summB.result === 'FAILED' ? 'var(--vscode-charts-red,#f14c4c)' : 'inherit';

    const failNote = failed.length > 0 ? `<div class="fail-note">⚠ Some data could not be loaded: ${failed.map(f => escapeHtml(f)).join(', ')}</div>` : '';

    return `
${failNote}
<div class="summary-actions">
    <button class="action-btn" onclick="askAI('explain','summary','all','','','')" title="Explain all changes">🔍 Explain all changes</button>
    <button class="action-btn" onclick="askAI('fix','summary','optimize','','','')" title="What should I optimize next?">🔧 What should I optimize next?</button>
</div>
<table class="summary-table">
<thead><tr>
    <th style="width:120px"></th>
    <th style="width:140px"><span class="col-dot" style="background:var(--vscode-charts-blue,#3794ff)"></span> Build A</th>
    <th style="width:140px"><span class="col-dot" style="background:var(--vscode-charts-orange,#d18616)"></span> Build B</th>
    <th>Change</th>
</tr></thead>
<tbody>
<tr>
    <td class="row-label">Result</td>
    <td style="color:${resultColorA};font-weight:600">${escapeHtml(summA.result)}</td>
    <td style="color:${resultColorB};font-weight:600">${escapeHtml(summB.result)}</td>
    <td>${summA.result === summB.result ? '<span class="delta-neutral">Same</span>' : '<span class="delta-worse">Changed</span>'}</td>
</tr>
<tr>
    <td class="row-label">Duration</td>
    <td class="val-a">${escapeHtml(summA.duration) || '—'}</td>
    <td class="val-b">${escapeHtml(summB.duration) || '—'}</td>
    <td>${durationDelta(summA.durationSeconds, summB.durationSeconds)}</td>
</tr>
<tr>
    <td class="row-label">Projects</td>
    <td class="val-a">${summA.projectCount || '—'}</td>
    <td class="val-b">${summB.projectCount || '—'}</td>
    <td>${delta(summA.projectCount, summB.projectCount, false)}</td>
</tr>
<tr>
    <td class="row-label">Errors</td>
    <td class="val-a">${summA.errorCount}</td>
    <td class="val-b">${summB.errorCount}</td>
    <td>${delta(summA.errorCount, summB.errorCount, true)}</td>
</tr>
<tr>
    <td class="row-label">Warnings</td>
    <td class="val-a">${summA.warningCount}</td>
    <td class="val-b">${summB.warningCount}</td>
    <td>${delta(summA.warningCount, summB.warningCount, true)}</td>
</tr>
</tbody>
</table>`;
}

function renderErrorsTab(errorsA: ErrorEntry[], errorsB: ErrorEntry[]): string {
    const keysA = new Set(errorsA.map(e => e.key));
    const keysB = new Set(errorsB.map(e => e.key));
    const allByKey = new Map<string, { a?: ErrorEntry; b?: ErrorEntry }>();
    for (const e of errorsA) { allByKey.set(e.key, { ...allByKey.get(e.key), a: e }); }
    for (const e of errorsB) { allByKey.set(e.key, { ...allByKey.get(e.key), b: e }); }

    const fixed: Array<[string, ErrorEntry]> = [];
    const newErr: Array<[string, ErrorEntry]> = [];
    const unchanged: Array<[string, ErrorEntry]> = [];

    for (const [key, pair] of allByKey) {
        if (pair.a && !pair.b) { fixed.push([key, pair.a]); }
        else if (!pair.a && pair.b) { newErr.push([key, pair.b]); }
        else if (pair.a) { unchanged.push([key, pair.a]); }
    }

    let html = `<div style="margin-bottom:12px"><input type="text" id="diagFilter" placeholder="Filter diagnostics…" oninput="filterDiags(this.value)" style="width:100%;padding:6px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#444);border-radius:4px;font-size:13px;box-sizing:border-box;" /></div>
    <div class="error-counts">
        <span class="badge badge-green">FIXED: ${fixed.length}</span>
        <span class="badge badge-red">NEW: ${newErr.length}</span>
        <span class="badge badge-gray">UNCHANGED: ${unchanged.length}</span>
    </div>`;

    function renderErrorRow(e: ErrorEntry, status: string, badgeCls: string): string {
        const label = `${e.code ? e.code + ': ' : ''}${e.message}`;
        return `<div class="error-row err-row">
            <span class="badge ${badgeCls}">${status}</span>
            <span class="error-text" title="${escapeHtml(e.file)}:${e.line}">${escapeHtml(label)}</span>
            ${aiBtn('error', label, 'explain', '', '', status.toLowerCase())}
            ${aiBtn('error', label, 'fix', '', '', status.toLowerCase())}
        </div>`;
    }

    if (fixed.length) {
        html += '<h3>✅ Fixed diagnostics</h3>';
        for (const [, e] of fixed) { html += renderErrorRow(e, 'FIXED', 'badge-green'); }
    }
    if (newErr.length) {
        html += '<h3>🔴 New diagnostics</h3>';
        for (const [, e] of newErr) { html += renderErrorRow(e, 'NEW', 'badge-red'); }
    }
    if (unchanged.length) {
        html += `<details class="unchanged-errors"><summary>Gray: ${unchanged.length} unchanged error(s)</summary>`;
        for (const [, e] of unchanged) { html += renderErrorRow(e, 'UNCHANGED', 'badge-gray'); }
        html += '</details>';
    }
    if (allByKey.size === 0) {
        html += '<p class="empty-note">No errors found in either build.</p>';
    }
    return html;
}

function renderPropertiesTab(compareText: string): string {
    const diffs = parsePropertyDiffs(compareText);
    // Also extract reference and import diffs
    let refHtml = '';
    try {
        const data = JSON.parse(compareText);
        const refsA = data.referencesOnlyInA || [];
        const refsB = data.referencesOnlyInB || [];
        const importsA = data.importsOnlyInA || [];
        const importsB = data.importsOnlyInB || [];
        if (refsA.length > 0 || refsB.length > 0) {
            const totalRefs = refsA.length + refsB.length;
            refHtml += `<details${totalRefs <= 5 ? ' open' : ''}><summary style="cursor:pointer;font-weight:600;margin:12px 0 8px 0">🔗 Reference Differences <span style="font-weight:normal;color:var(--vscode-descriptionForeground);font-size:12px">(${refsA.length} removed, ${refsB.length} added)</span></summary>`;
            for (const r of refsA) { refHtml += `<div class="err-row"><span class="badge badge-red">REMOVED</span> ${escapeHtml(String(r))}</div>`; }
            for (const r of refsB) { refHtml += `<div class="err-row"><span class="badge badge-green">ADDED</span> ${escapeHtml(String(r))}</div>`; }
            refHtml += '</details>';
        }
        if (importsA.length > 0 || importsB.length > 0) {
            const totalImports = importsA.length + importsB.length;
            refHtml += `<details${totalImports <= 5 ? ' open' : ''}><summary style="cursor:pointer;font-weight:600;margin:12px 0 8px 0">📦 Import Differences <span style="font-weight:normal;color:var(--vscode-descriptionForeground);font-size:12px">(${importsA.length} removed, ${importsB.length} added)</span></summary>`;
            for (const r of importsA) { refHtml += `<div class="err-row"><span class="badge badge-red">REMOVED</span> ${escapeHtml(String(r))}</div>`; }
            for (const r of importsB) { refHtml += `<div class="err-row"><span class="badge badge-green">ADDED</span> ${escapeHtml(String(r))}</div>`; }
            refHtml += '</details>';
        }
    } catch { /* not JSON */ }

    if (diffs.length === 0 && !refHtml) {
        if (!compareText.trim()) { return '<p class="empty-note">No comparison data available.</p>'; }
        return '<p class="empty-note">No property differences found.</p>' + refHtml;
    }

    let html = '';
    if (diffs.length > 0) {
        html = renderPropertyDiffsTable(diffs);
    } else {
        html = '<p class="empty-note">No property differences found.</p>';
    }
    return html + refHtml;
}

function renderPackagesTab(compareText: string): string {
    const diffs = parsePackageDiffs(compareText);

    if (diffs.length === 0) {
        if (!compareText.trim()) { return '<p class="empty-note">No comparison data available.</p>'; }
        return '<p class="empty-note">No package version differences found.</p>';
    }

    let html = `<table class="diff-table"><tr><th>Package</th><th>Build A</th><th>Build B</th><th>Status</th><th></th></tr>`;
    for (const d of diffs) {
        const isAdded = /not present/i.test(d.versionA);
        const isRemoved = /not present/i.test(d.versionB) || /removed/i.test(d.versionB);
        const badge = isAdded ? '<span class="badge badge-green">ADDED</span>'
            : isRemoved ? '<span class="badge badge-red">REMOVED</span>'
            : '<span class="badge badge-orange">CHANGED</span>';
        html += `<tr>
            <td class="prop-name">${escapeHtml(d.name)}</td>
            <td class="val-a">${escapeHtml(d.versionA)}</td>
            <td class="val-b">${escapeHtml(d.versionB)}</td>
            <td>${badge}</td>
            <td class="ai-cell">${aiBtn('package', d.name, 'explain', d.versionA, d.versionB)} ${aiBtn('package', d.name, 'fix', d.versionA, d.versionB)}</td>
        </tr>`;
    }
    html += '</table>';
    return html;
}

function renderPerformanceTab(
    targetsA: PerfEntry[], targetsB: PerfEntry[],
    tasksA: PerfEntry[], tasksB: PerfEntry[],
): string {
    function toMap(entries: PerfEntry[]): Map<string, number> {
        const m = new Map<string, number>();
        for (const e of entries) { m.set(e.name, e.ms); }
        return m;
    }

    function renderBars(title: string, emoji: string, mapA: Map<string, number>, mapB: Map<string, number>): string {
        const allNames = [...new Set([...mapA.keys(), ...mapB.keys()])];
        allNames.sort((a, b) => Math.max(mapA.get(b) ?? 0, mapB.get(b) ?? 0) - Math.max(mapA.get(a) ?? 0, mapB.get(a) ?? 0));
        const maxMs = Math.max(...[...mapA.values(), ...mapB.values(), 1]);

        let html = `<details open><summary>${emoji} ${title} <span>(${allNames.length})</span></summary>`;
        for (const name of allNames) {
            const msA = mapA.get(name) ?? 0;
            const msB = mapB.get(name) ?? 0;
            const pctA = Math.max(1, (msA / maxMs) * 100);
            const pctB = Math.max(1, (msB / maxMs) * 100);
            const deltaPct = msA > 0 ? ((msB - msA) / msA * 100) : (msB > 0 ? 100 : 0);
            const deltaSign = deltaPct > 0 ? '+' : '';
            const deltaCls = deltaPct > 5 ? 'delta-worse' : deltaPct < -5 ? 'delta-better' : 'delta-neutral';
            const deltaStr = msA > 0 || msB > 0 ? `<span class="${deltaCls}">${deltaSign}${deltaPct.toFixed(0)}%</span>` : '';
            const badge = msA === 0 && msB > 0 ? '<span class="badge badge-orange">NEW</span>'
                : msA > 0 && msB === 0 ? '<span class="badge badge-gray">REMOVED</span>' : '';

            html += `<div class="cmp-row">
                <div class="cmp-label" title="${escapeHtml(name)}">${escapeHtml(name)} ${badge}</div>
                <div class="cmp-bars">
                    <div class="cmp-bar-pair">
                        <div class="cmp-bar-track"><div class="cmp-bar-fill bar-a" style="width:${pctA}%"></div></div>
                        <div class="cmp-bar-val val-a">${msA > 0 ? formatDuration(msA) : '—'}</div>
                    </div>
                    <div class="cmp-bar-pair">
                        <div class="cmp-bar-track"><div class="cmp-bar-fill bar-b" style="width:${pctB}%"></div></div>
                        <div class="cmp-bar-val val-b">${msB > 0 ? formatDuration(msB) : '—'}</div>
                    </div>
                </div>
                <div class="cmp-delta">${deltaStr}</div>
                <div class="cmp-ai">${aiBtn('target', name, 'explain', formatDuration(msA), formatDuration(msB), `${deltaSign}${deltaPct.toFixed(0)}%`)}${aiBtn('target', name, 'fix', formatDuration(msA), formatDuration(msB), `${deltaSign}${deltaPct.toFixed(0)}%`)}</div>
            </div>`;
        }
        if (allNames.length === 0) { html += '<p class="empty-note">No data available.</p>'; }
        html += '</details>';
        return html;
    }

    return `<div style="margin-bottom:12px"><input type="text" placeholder="Filter targets/tasks…" oninput="filterPerf(this.value)" style="width:100%;padding:6px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#444);border-radius:4px;font-size:13px;box-sizing:border-box;" /></div>`
        + renderBars('Target Comparison', '🔥', toMap(targetsA), toMap(targetsB))
        + renderBars('Task Comparison', '🔧', toMap(tasksA), toMap(tasksB));
}

function buildHtml(
    nameA: string, nameB: string,
    summaryHtml: string, errorsHtml: string,
    propertiesHtml: string, packagesHtml: string,
    performanceHtml: string,
    mismatchHtml: string,
): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<style>
:root {
    --bar-a: var(--vscode-charts-blue, #3794ff);
    --bar-b: var(--vscode-charts-orange, #d18616);
    --card-bg: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
    --card-border: var(--vscode-widget-border, #333);
    --radius: 8px;
}
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px 28px; max-width: 1100px; margin: 0 auto; }
h3 { font-size: 1.05em; margin-top: 24px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }

/* Header */
.header { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
.header-icon { font-size: 1.5em; display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--radius); background: var(--card-bg); }
.header-title { font-size: 1.35em; font-weight: 600; letter-spacing: -0.01em; }

/* Legend pills */
.legend { display: flex; gap: 10px; margin: 0 0 18px; }
.legend-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; padding: 4px 12px 4px 8px; border-radius: 20px; background: var(--card-bg); border: 1px solid var(--card-border); color: var(--vscode-foreground); }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

/* Tab bar (segmented control) */
.tab-radios { position: absolute; opacity: 0; pointer-events: none; }
.tab-bar { display: flex; gap: 0; background: var(--card-bg); border-radius: var(--radius); padding: 3px; margin-bottom: 20px; border: 1px solid var(--card-border); width: fit-content; }
.tab-bar label { padding: 7px 20px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--vscode-descriptionForeground); border-radius: 6px; transition: color .15s, background .15s; user-select: none; white-space: nowrap; }
.tab-bar label:hover { color: var(--vscode-foreground); }
.tab-content { display: none; max-height: calc(100vh - 180px); overflow-y: auto; padding-right: 4px; }
#tab-summary:checked ~ .tab-bar label[for="tab-summary"],
#tab-errors:checked ~ .tab-bar label[for="tab-errors"],
#tab-properties:checked ~ .tab-bar label[for="tab-properties"],
#tab-packages:checked ~ .tab-bar label[for="tab-packages"],
#tab-performance:checked ~ .tab-bar label[for="tab-performance"] { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, #333); box-shadow: 0 1px 3px rgba(0,0,0,0.25); }
#tab-summary:checked ~ .tab-content.tc-summary,
#tab-errors:checked ~ .tab-content.tc-errors,
#tab-properties:checked ~ .tab-content.tc-properties,
#tab-packages:checked ~ .tab-content.tc-packages,
#tab-performance:checked ~ .tab-content.tc-performance { display: block; }

/* Summary metric cards */
.metric-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 16px; }
.summary-table { width: 100%; border-collapse: separate; border-spacing: 0; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--card-border); background: var(--card-bg); }
.summary-table th { text-align: left; padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--card-border); background: transparent; }
.summary-table td { padding: 12px 16px; font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--card-border); }
.summary-table tr:last-child td { border-bottom: none; }
.summary-table tr:hover { background: rgba(255,255,255,0.03); }
.row-label { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 13px; }
.col-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.metric-delta { font-size: 12px; font-weight: 600; }
.summary-actions { display: flex; gap: 10px; margin-top: 12px; }
.action-btn { background: var(--vscode-button-secondaryBackground, #333); color: var(--vscode-button-secondaryForeground, #ccc); border: 1px solid var(--card-border); padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; transition: background .15s; }
.action-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
.fail-note { background: var(--vscode-inputValidation-warningBackground, #5a4e00); color: var(--vscode-inputValidation-warningForeground, #ccc); padding: 10px 14px; border-radius: var(--radius); margin-bottom: 12px; font-size: 12px; border: 1px solid rgba(255,200,0,0.15); }

/* Summary table (properties tab) */
.summary-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.summary-table th, .summary-table td { text-align: left; padding: 8px 14px; border-bottom: 1px solid var(--card-border); font-size: 13px; }
.summary-table th { color: var(--vscode-descriptionForeground); font-weight: 600; }

/* Errors */
.error-counts { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.error-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px; border-radius: 6px; margin: 2px 0; transition: background .1s; }
.error-row:hover { background: var(--card-bg); }
.error-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unchanged-errors { margin-top: 12px; background: var(--card-bg); border-radius: var(--radius); padding: 2px; }
.unchanged-errors summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; padding: 8px 12px; }

/* Diff table */
.diff-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
.diff-table th, .diff-table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--card-border); font-size: 12px; }
.diff-table th { color: var(--vscode-descriptionForeground); font-weight: 600; }
.prop-name { font-weight: 500; }
.val-a { color: var(--bar-a); }
.val-b { color: var(--bar-b); }
.ai-cell { white-space: nowrap; }
.raw-output { background: var(--card-bg); padding: 12px; border-radius: var(--radius); font-size: 12px; overflow-x: auto; max-height: 400px; overflow-y: auto; }

/* Badges */
.badge { font-size: 10px; padding: 3px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; letter-spacing: 0.02em; }
.badge-green { background: rgba(137,209,133,0.18); color: var(--vscode-charts-green, #89d185); border: 1px solid rgba(137,209,133,0.3); }
.badge-red { background: rgba(241,76,76,0.15); color: var(--vscode-charts-red, #f14c4c); border: 1px solid rgba(241,76,76,0.3); }
.badge-orange { background: rgba(209,134,22,0.15); color: var(--bar-b); border: 1px solid rgba(209,134,22,0.3); }
.badge-gray { background: rgba(150,150,150,0.12); color: var(--vscode-descriptionForeground); border: 1px solid rgba(150,150,150,0.2); }

/* Performance bars — side-by-side layout */
.cmp-row { display: flex; align-items: center; padding: 6px 10px; border-radius: 6px; margin: 1px 0; min-width: 0; }
.cmp-row:nth-child(odd) { background: var(--card-bg); }
.cmp-label { width: 200px; min-width: 200px; max-width: 200px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 4px; }
.cmp-ai { width: 44px; min-width: 44px; display: flex; gap: 2px; align-items: center; }
.cmp-bars { flex: 1; display: flex; flex-direction: row; gap: 6px; align-items: center; min-width: 0; }
.cmp-bar-pair { display: flex; align-items: center; flex: 1; min-width: 0; }
.cmp-bar-track { flex: 1; height: 18px; background: rgba(128,128,128,0.08); border-radius: 9px; overflow: hidden; }
.cmp-bar-fill { height: 100%; border-radius: 9px; min-width: 3px; transition: width .5s ease; }
.bar-a { background: linear-gradient(90deg, var(--bar-a), color-mix(in srgb, var(--bar-a) 80%, white)); }
.bar-b { background: linear-gradient(90deg, var(--bar-b), color-mix(in srgb, var(--bar-b) 80%, white)); }
.cmp-bar-val { width: 55px; text-align: right; font-size: 11px; padding-left: 6px; font-variant-numeric: tabular-nums; font-weight: 500; }
.cmp-delta { width: 70px; text-align: right; font-size: 11px; padding-left: 10px; font-weight: 600; }
.delta-worse { color: var(--vscode-charts-red, #f14c4c); }
.delta-better { color: var(--vscode-charts-green, #89d185); }
.delta-neutral { color: var(--vscode-descriptionForeground); }
.row-ai { display: inline-flex; gap: 2px; margin-left: 4px; }

/* AI button */
.ai-btn { background: none; border: none; cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 4px; opacity: 0; transition: opacity 0.15s; }
.ai-btn:hover { opacity: 1 !important; background: var(--card-bg); }
tr:hover .ai-btn, .cmp-row:hover .ai-btn, .err-row:hover .ai-btn, .cmp-row:hover .cmp-ai .ai-btn { opacity: 0.6; }
.empty-note { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 13px; }

/* Filter inputs */
input[type="text"][placeholder*="Filter"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 6px;
    padding: 7px 12px;
    font-size: 13px;
    font-family: var(--vscode-font-family);
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition: border-color .15s;
}
input[type="text"][placeholder*="Filter"]:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
}

/* Details/summary sections in perf tab */
details > summary { cursor: pointer; font-weight: 600; font-size: 1.05em; margin: 16px 0 10px 0; padding: 8px 12px; background: var(--card-bg); border-radius: var(--radius); border: 1px solid var(--card-border); }
details > summary span { font-weight: normal; color: var(--vscode-descriptionForeground); font-size: 12px; }

/* Scrollbar styling */
.tab-content::-webkit-scrollbar { width: 6px; }
.tab-content::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 3px; }
.tab-content::-webkit-scrollbar-track { background: transparent; }
</style>
</head>
<body>
<div class="header">
    <div class="header-icon">📊</div>
    <div class="header-title">Build Comparison</div>
</div>
<div class="legend">
    <span class="legend-pill"><span class="legend-dot" style="background:var(--bar-a)"></span>A: ${escapeHtml(nameA)}</span>
    <span class="legend-pill"><span class="legend-dot" style="background:var(--bar-b)"></span>B: ${escapeHtml(nameB)}</span>
</div>
${mismatchHtml}

<input type="radio" name="tab" id="tab-summary" class="tab-radios" checked>
<input type="radio" name="tab" id="tab-errors" class="tab-radios">
<input type="radio" name="tab" id="tab-properties" class="tab-radios">
<input type="radio" name="tab" id="tab-packages" class="tab-radios">
<input type="radio" name="tab" id="tab-performance" class="tab-radios">

<div class="tab-bar">
    <label for="tab-summary">Summary</label>
    <label for="tab-errors">Diagnostics</label>
    <label for="tab-properties">Properties</label>
    <label for="tab-packages">Packages</label>
    <label for="tab-performance">Performance</label>
</div>

<div class="tab-content tc-summary">${summaryHtml}</div>
<div class="tab-content tc-errors">${errorsHtml}</div>
<div class="tab-content tc-properties">${propertiesHtml}</div>
<div class="tab-content tc-packages">${packagesHtml}</div>
<div class="tab-content tc-performance">${performanceHtml}</div>

<script>
const vscode = acquireVsCodeApi();
function askAI(mode, type, name, valueA, valueB, status) {
    vscode.postMessage({ command: 'askAI', mode, type, name, valueA, valueB, status });
}
function filterDiags(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.err-row').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = q && !text.includes(q) ? 'none' : '';
    });
}
function filterPerf(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.cmp-row').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = q && !text.includes(q) ? 'none' : '';
    });
}
function filterProps(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.prop-row').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = q && !text.includes(q) ? 'none' : '';
    });
}
</script>
</body>
</html>`;
}

export async function showComparisonWebview(
    context: vscode.ExtensionContext,
    mcpClient: McpClient,
    pathA: string,
    pathB: string,
): Promise<void> {
    const nameA = pathA.split(/[/\\]/).pop() || pathA;
    const nameB = pathB.split(/[/\\]/).pop() || pathB;

    const panel = vscode.window.createWebviewPanel(
        'binlogCompare',
        `Compare: ${nameA} vs ${nameB}`,
        vscode.ViewColumn.One,
        { enableScripts: true },
    );

    panel.webview.html = `<!DOCTYPE html><html><body style="padding:40px;color:var(--vscode-foreground)"><h2>Loading comparison data…</h2></body></html>`;

    // Fetch all data in parallel
    const [
        compareResult,
        overviewAResult,
        overviewBResult,
        errorsAResult,
        errorsBResult,
        warningsAResult,
        warningsBResult,
        targetsAResult,
        targetsBResult,
        tasksAResult,
        tasksBResult,
        projectsAResult,
        projectsBResult,
    ] = await Promise.allSettled([
        mcpClient.callTool('binlog_compare', { binlog_file_a: pathA, binlog_file_b: pathB }),
        mcpClient.callTool('binlog_overview', { binlog_file: pathA }),
        mcpClient.callTool('binlog_overview', { binlog_file: pathB }),
        mcpClient.callTool('binlog_errors', { binlog_file: pathA }),
        mcpClient.callTool('binlog_errors', { binlog_file: pathB }),
        mcpClient.callTool('binlog_warnings', { binlog_file: pathA }),
        mcpClient.callTool('binlog_warnings', { binlog_file: pathB }),
        mcpClient.callTool('binlog_expensive_targets', { top_number: 20, binlog_file: pathA }),
        mcpClient.callTool('binlog_expensive_targets', { top_number: 20, binlog_file: pathB }),
        mcpClient.callTool('binlog_expensive_tasks', { top_number: 20, binlog_file: pathA }),
        mcpClient.callTool('binlog_expensive_tasks', { top_number: 20, binlog_file: pathB }),
        mcpClient.callTool('binlog_projects', { binlog_file: pathA }),
        mcpClient.callTool('binlog_projects', { binlog_file: pathB }),
    ]);

    const val = <T>(r: PromiseSettledResult<T>, fallback: T): T => r.status === 'fulfilled' ? r.value : fallback;
    const failed: string[] = [];
    if (compareResult.status === 'rejected') { failed.push('binlog_compare'); }
    if (overviewAResult.status === 'rejected') { failed.push('overview A'); }
    if (overviewBResult.status === 'rejected') { failed.push('overview B'); }
    if (errorsAResult.status === 'rejected') { failed.push('errors A'); }
    if (errorsBResult.status === 'rejected') { failed.push('errors B'); }
    if (targetsAResult.status === 'rejected') { failed.push('targets A'); }
    if (targetsBResult.status === 'rejected') { failed.push('targets B'); }
    if (tasksAResult.status === 'rejected') { failed.push('tasks A'); }
    if (tasksBResult.status === 'rejected') { failed.push('tasks B'); }

    const noResult = { text: '' };
    const compareText = val(compareResult, noResult).text;
    const overviewA = val(overviewAResult, noResult).text;
    const overviewB = val(overviewBResult, noResult).text;
    const errorsAText = val(errorsAResult, noResult).text;
    const errorsBText = val(errorsBResult, noResult).text;
    const warningsAText = val(warningsAResult, noResult).text;
    const warningsBText = val(warningsBResult, noResult).text;
    const targetsAText = val(targetsAResult, noResult).text;
    const targetsBText = val(targetsBResult, noResult).text;
    const tasksAText = val(tasksAResult, noResult).text;
    const tasksBText = val(tasksBResult, noResult).text;
    const projectsAText = val(projectsAResult, noResult).text;
    const projectsBText = val(projectsBResult, noResult).text;

    // Count actual projects (unique .csproj files, excluding .sln)
    function countProjects(text: string): number {
        try {
            const data = JSON.parse(text);
            const entries: any[] = Array.isArray(data) ? data : Object.values(data);
            const names = new Set(entries.map((p: any) => {
                const f = p.fullPath || p.projectFile || p.ProjectFile || '';
                return String(f).split(/[/\\]/).pop()?.toLowerCase() || '';
            }).filter((n: string) => n && !n.endsWith('.sln')));
            return names.size || entries.length;
        } catch { return 0; }
    }

    // Parse summaries — try direct overview first, then fall back to binlog_compare's embedded overviews
    let summA = parseSummary(overviewA);
    let summB = parseSummary(overviewB);
    if (compareText && (summA.result === 'UNKNOWN' || !summA.duration)) {
        try {
            const cmpData = JSON.parse(compareText);
            if (cmpData.overviewA) { summA = parseSummary(JSON.stringify(cmpData.overviewA)); }
            if (cmpData.overviewB) { summB = parseSummary(JSON.stringify(cmpData.overviewB)); }
        } catch { /* ignore */ }
    }
    const errorsA = parseErrors(errorsAText);
    const errorsB = parseErrors(errorsBText);
    const warningsA = parseErrors(warningsAText);
    const warningsB = parseErrors(warningsBText);
    // Merge errors + warnings for the diff
    const allDiagsA = [...errorsA, ...warningsA];
    const allDiagsB = [...errorsB, ...warningsB];
    // Always use actual diagnostic counts from the MCP tools (deduplicated)
    summA.errorCount = errorsA.length;
    summB.errorCount = errorsB.length;
    summA.warningCount = warningsA.length;
    summB.warningCount = warningsB.length;
    // Use actual project counts from binlog_projects
    const projCountA = countProjects(projectsAText);
    const projCountB = countProjects(projectsBText);
    if (projCountA > 0) { summA.projectCount = projCountA; }
    if (projCountB > 0) { summB.projectCount = projCountB; }
    const targetsA = parsePerfData(targetsAText);
    const targetsB = parsePerfData(targetsBText);
    const tasksA = parsePerfData(tasksAText);
    const tasksB = parsePerfData(tasksBText);

    // Extract project names for mismatch detection
    function extractProjectNames(text: string): string[] {
        try {
            const data = JSON.parse(text);
            const entries: any[] = Array.isArray(data) ? data : Object.values(data);
            return entries.map((p: any) => {
                const f = p.fullPath || p.projectFile || p.ProjectFile || '';
                return String(f).split(/[/\\]/).pop() || '';
            }).filter((n: string) => n && !n.endsWith('.sln'));
        } catch { return []; }
    }
    const projectNamesA = extractProjectNames(projectsAText);
    const projectNamesB = extractProjectNames(projectsBText);

    // Detect project/solution mismatch — shown above tabs on all views
    let mismatchHtml = '';
    if (projectNamesA.length > 0 && projectNamesB.length > 0) {
        const setA = new Set(projectNamesA.map(n => n.toLowerCase()));
        const setB = new Set(projectNamesB.map(n => n.toLowerCase()));
        const common = [...setA].filter(n => setB.has(n));
        const overlap = common.length / Math.max(setA.size, setB.size);
        if (overlap < 0.5) {
            mismatchHtml = `<div class="fail-note" style="background:var(--vscode-inputValidation-warningBackground,#5a4000)">⚠️ <strong>These binlogs appear to be from different projects.</strong> Only ${common.length} of ${Math.max(setA.size, setB.size)} projects overlap. The comparison may not be meaningful.</div>`;
        }
    }

    const summaryHtml = renderSummaryTab(summA, summB, failed);
    const errorsHtml = renderErrorsTab(allDiagsA, allDiagsB);

    // Properties: try binlog_compare's propertyDiffs first, then fall back to diffing binlog_properties
    let propertiesHtml: string;
    let packagesHtml: string;
    const parsedPropDiffs = compareText ? parsePropertyDiffs(compareText) : [];
    const parsedPkgDiffs = compareText ? parsePackageDiffs(compareText) : [];

    if (compareText && (parsedPropDiffs.length > 0 || parsedPkgDiffs.length > 0)) {
        // binlog_compare returned meaningful diffs
        propertiesHtml = renderPropertiesTab(compareText);
        packagesHtml = renderPackagesTab(compareText);
    } else {
        // Either binlog_compare failed, or propertyDiffs was empty — diff binlog_properties ourselves
        try {
            const [propsAResult, propsBResult] = await Promise.allSettled([
                mcpClient.callTool('binlog_properties', { binlog_file: pathA }),
                mcpClient.callTool('binlog_properties', { binlog_file: pathB }),
            ]);
            if (propsAResult.status === 'fulfilled' && propsBResult.status === 'fulfilled') {
                const propsA = parsePropertyMap(propsAResult.value.text);
                const propsB = parsePropertyMap(propsBResult.value.text);
                const propDiffs: PropertyDiff[] = [];
                const allKeys = new Set([...propsA.keys(), ...propsB.keys()]);
                for (const key of [...allKeys].sort()) {
                    const a = propsA.get(key) ?? '(not set)';
                    const b = propsB.get(key) ?? '(not set)';
                    if (a !== b) { propDiffs.push({ name: key, valueA: a, valueB: b }); }
                }
                let html = propDiffs.length > 0
                    ? renderPropertyDiffsTable(propDiffs)
                    : '<p class="empty-note">No property differences found.</p>';
                // Still show reference/import diffs from binlog_compare if available
                if (compareText) {
                    const refHtml = renderPropertiesTab(compareText);
                    // Extract only the reference/import sections
                    const refMatch = refHtml.match(/<details[\s\S]*$/);
                    if (refMatch) { html += refMatch[0]; }
                }
                propertiesHtml = html;
            } else {
                propertiesHtml = compareText ? renderPropertiesTab(compareText) : '<p class="empty-note">Could not load properties for comparison.</p>';
            }
        } catch {
            propertiesHtml = compareText ? renderPropertiesTab(compareText) : '<p class="empty-note">Could not load properties for comparison.</p>';
        }
        packagesHtml = compareText ? renderPackagesTab(compareText) : '<p class="empty-note">Package comparison requires binlog_compare. Try updating BinlogInsights.Mcp.</p>';
    }
    const performanceHtml = renderPerformanceTab(targetsA, targetsB, tasksA, tasksB);

    panel.webview.html = buildHtml(nameA, nameB, summaryHtml, errorsHtml, propertiesHtml, packagesHtml, performanceHtml, mismatchHtml);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(message => {
        if (message.command === 'askAI') {
            let prompt: string;
            if (message.type === 'summary') {
                prompt = message.mode === 'explain'
                    ? `@binlog /compare Explain all the differences between ${nameA} and ${nameB}. Focus on what changed and why it matters.`
                    : `@binlog Based on the comparison of ${nameA} and ${nameB}, what should I optimize next? Prioritize by impact.`;
            } else if (message.type === 'error') {
                prompt = message.mode === 'explain'
                    ? `@binlog Explain this error change between builds: ${message.name}. Was it fixed or introduced? What caused it?`
                    : `@binlog This error ${message.status === 'new' ? 'appeared' : 'was fixed'} between builds: ${message.name}. ${message.status === 'new' ? 'How do I fix it?' : 'What change fixed it?'}`;
            } else if (message.type === 'property') {
                prompt = `@binlog The MSBuild property "${message.name}" changed from "${message.valueA}" to "${message.valueB}" between builds. What does this property control and what is the impact of this change?`;
            } else if (message.type === 'package') {
                prompt = `@binlog The package "${message.name}" changed from version ${message.valueA || '(not present)'} to ${message.valueB || '(removed)'} between builds. Is this a breaking change? What should I check?`;
            } else if (message.type === 'target') {
                prompt = `@binlog The target "${message.name}" went from ${message.valueA} to ${message.valueB} between builds (${message.status}). Why did this change? Is this expected?`;
            } else {
                prompt = `@binlog Analyze this change between builds: ${message.name} (${message.valueA} → ${message.valueB})`;
            }
            vscode.commands.executeCommand('workbench.action.chat.open', prompt);
        }
    }, undefined, context.subscriptions);
}
