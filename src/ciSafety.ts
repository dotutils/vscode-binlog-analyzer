/**
 * Safety helpers for CI artifact handling. Extracted from `ciIntegration.ts`
 * so they can be unit-tested without spawning network requests or a VS Code
 * host.
 */
import * as path from 'path';
import * as fs from 'fs';
import { URL } from 'url';

/**
 * Hosts we will follow HTTP redirects to. Intentionally narrow — limited to
 * hosts that GitHub Actions and Azure DevOps are known to redirect to for
 * artifact downloads (storage accounts, CDN endpoints, etc.).
 */
const ALLOWED_REDIRECT_HOST_SUFFIXES = [
    'github.com',
    'githubusercontent.com',                  // raw.githubusercontent.com
    'actions.githubusercontent.com',          // GH Actions artifacts
    'pipelines.actions.githubusercontent.com',
    'dev.azure.com',
    'visualstudio.com',                       // legacy AzDO domains
    'core.windows.net',                       // Azure storage (artifact backing)
    'azureedge.net',                          // Azure CDN
];

/** True iff `host` ends with any of the allowed suffixes (case-insensitive). */
export function isAllowedRedirectHost(host: string): boolean {
    if (!host) { return false; }
    const lower = host.toLowerCase();
    return ALLOWED_REDIRECT_HOST_SUFFIXES.some(suffix =>
        lower === suffix || lower.endsWith('.' + suffix)
    );
}

/** Validate a redirect URL: must be http(s) and target a trusted host. */
export function isAllowedRedirectUrl(rawUrl: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return false;
    }
    return isAllowedRedirectHost(parsed.hostname);
}

/**
 * Reduce an arbitrary string to a safe filesystem basename. Strips any path
 * separators and parent-directory traversal; rejects empty results and
 * Windows reserved device names. Never returns a string containing `\` `/`
 * or `..`.
 */
export function safeBasename(name: string): string {
    if (typeof name !== 'string') {
        throw new Error('safeBasename: name must be a string');
    }
    // Take only the trailing path component, then strip remaining separators
    // (defends against backslash on POSIX where path.basename ignores it).
    let base = path.basename(name).replace(/[\\/]/g, '_').trim();
    // Collapse parent-traversal segments
    base = base.replace(/\.\.+/g, '_');
    // Strip leading dots (hidden files / Windows reserved like `.`)
    base = base.replace(/^\.+/, '');
    // Reject Windows reserved device names (CON, PRN, AUX, NUL, COM1..9, LPT1..9)
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(base)) {
        base = '_' + base;
    }
    if (!base) {
        throw new Error(`safeBasename: refusing empty/invalid name (input: ${JSON.stringify(name)})`);
    }
    return base;
}

/**
 * Escape a string so it is safe to embed inside a single-quoted PowerShell
 * literal: PowerShell escapes `'` by doubling it (`''`). Returns the value
 * already wrapped in single quotes.
 */
export function psSingleQuote(value: string): string {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * Walk `extractDir` recursively and verify every file/directory resolves
 * (real path, after symlink resolution) to a location strictly inside
 * `extractDir`. Throws on the first violation. Used as a defense-in-depth
 * post-check after `Expand-Archive` / `az ... artifact download` since
 * neither tool guarantees zip-slip safety on every platform/version.
 */
export function assertNoZipSlip(extractDir: string): void {
    const realRoot = fs.realpathSync(extractDir);
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            let realPath: string;
            try {
                realPath = fs.realpathSync(fullPath);
            } catch {
                // Broken symlink — treat as a violation rather than skipping.
                throw new Error(
                    `Refusing to load archive: entry could not be resolved (${fullPath})`
                );
            }
            if (realPath !== realRoot && !realPath.startsWith(rootWithSep)) {
                throw new Error(
                    `Refusing to load archive: entry escapes extract directory (${realPath})`
                );
            }
            if (entry.isDirectory()) {
                walk(fullPath);
            }
        }
    };
    walk(extractDir);
}
