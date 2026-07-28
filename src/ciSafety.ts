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

// ─── Command-argument allow-lists ────────────────────────────────────────────
//
// Every value below is attacker-influenced (git remote URL, branch name, or a
// string chosen by the CI server) and ends up as an argument to `gh` / `az`.
// The command runner no longer uses a shell, but these allow-lists are the
// second, independent layer: they make the values structurally incapable of
// carrying shell syntax, and they stop option injection (`--repo -x`).

/** owner / repo / org / project. */
const REPO_IDENTIFIER_RE = /^[A-Za-z0-9._-]+$/;

/** Characters that are never legal in a value we hand to a CLI. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

/**
 * Shell metacharacters plus whitespace. Git allows most of these in ref names,
 * which is exactly why a branch name is a viable injection vector.
 */
const REF_FORBIDDEN_RE = /[\s&|;<>()$`'"\\!*?[\]{}~^%]/;

/** Artifact names: letters, digits and a few punctuation characters only. */
const ARTIFACT_NAME_RE = /^[A-Za-z0-9 ._+=-]+$/;

const MAX_IDENTIFIER_LENGTH = 100;
const MAX_REF_LENGTH = 255;

/** True for a value usable as a GitHub owner/repo or an Azure DevOps org/project. */
export function isValidRepoIdentifier(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_IDENTIFIER_LENGTH
        && REPO_IDENTIFIER_RE.test(value)
        && !value.startsWith('-')
        && value !== '.'
        && value !== '..';
}

/** True for a value usable as a git branch / ref argument. */
export function isValidGitRef(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_REF_LENGTH
        && !CONTROL_CHARS_RE.test(value)
        && !REF_FORBIDDEN_RE.test(value)
        && !value.startsWith('-')
        && !value.startsWith('/')
        && !value.endsWith('/')
        && !value.includes('..');
}

/** True for a CI artifact name we are willing to pass to a CLI. */
export function isValidArtifactName(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_REF_LENGTH
        && ARTIFACT_NAME_RE.test(value)
        && !value.startsWith('-')
        && !value.includes('..')
        && value.trim().length > 0;
}

/** True for a CI build/run identifier. */
export function isValidRunId(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
}

function reject(label: string, value: unknown, requirement: string): never {
    throw new Error(
        `Refusing to run CI command: invalid ${label} ${JSON.stringify(String(value))}. ${requirement}`
    );
}

/**
 * Validate a GitHub owner/repo or Azure DevOps org/project.
 * `label` is used verbatim in the error message shown to the user.
 */
export function assertValidRepoIdentifier(value: unknown, label: string): string {
    if (isValidRepoIdentifier(value)) { return value; }
    reject(label, value, `Only letters, digits, '.', '_' and '-' are allowed.`);
}

/** Validate a branch name / git ref before it reaches a CLI argument. */
export function assertValidGitRef(value: unknown, label: string = 'branch'): string {
    if (isValidGitRef(value)) { return value; }
    reject(label, value, `Shell metacharacters, whitespace and control characters are not allowed.`);
}

/** Validate a CI artifact name before it reaches a CLI argument. */
export function assertValidArtifactName(value: unknown, label: string = 'artifact name'): string {
    if (isValidArtifactName(value)) { return value; }
    reject(label, value, `Path separators and shell metacharacters are not allowed.`);
}

/** Validate a CI build/run identifier before it reaches a CLI argument. */
export function assertValidRunId(value: unknown, label: string = 'run ID'): string {
    if (isValidRunId(value)) { return value; }
    reject(label, value, `Only digits are allowed.`);
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
