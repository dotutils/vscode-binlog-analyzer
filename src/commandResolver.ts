/**
 * Safe executable resolution for `child_process.execFile`.
 *
 * Historically `execCommand` in `ciIntegration.ts` passed `shell: true` on
 * Windows so that the `.cmd` shims used by `az` (and previously `gh`) could be
 * launched at all. That is a remote-code-execution hazard: Node does **not**
 * escape the `args` array when a shell is used — it concatenates the arguments
 * into a single command line that is handed to `cmd.exe`, so any argument
 * containing `&`, `|`, `;`, `(`, `)` … starts a second command. Node reports
 * this as DEP0190.
 *
 * This module solves the `.cmd` problem properly instead:
 *
 *  - `resolveExecutable` searches `PATH` (honouring `PATHEXT`) once per command
 *    name and returns the absolute path of the real file.
 *  - `buildLaunchSpec` turns a command + argv into something that can be handed
 *    to `execFile` **without** a shell. Real executables (`.exe`, `.com`) are
 *    launched directly. `.cmd`/`.bat` shims are launched through `cmd.exe /d /s
 *    /c` with a command line we build and quote ourselves, and any argument
 *    that cannot be represented safely inside that command line is rejected
 *    outright rather than escaped.
 *
 * Nothing in this module imports `vscode`, so it is unit-testable.
 */
import * as fs from 'fs';
import * as path from 'path';

const IS_WINDOWS = process.platform === 'win32';

/** Extensions that `CreateProcess` can launch directly. */
const DIRECT_EXEC_EXTENSIONS = ['.exe', '.com'];

/** Extensions that must be interpreted by `cmd.exe`. */
const SHIM_EXTENSIONS = ['.cmd', '.bat'];

/**
 * Everything `execFile` needs in order to launch a command without a shell.
 */
export interface LaunchSpec {
    /** Executable to launch (absolute path when resolution succeeded). */
    file: string;
    /** Argument vector, already adapted for `file`. */
    args: string[];
    /**
     * True only for the `cmd.exe` shim path, where `args` is a pre-built,
     * fully quoted command line that must not be re-quoted by libuv.
     */
    windowsVerbatimArguments: boolean;
}

/** Successful resolutions only — a negative result is cheap to recompute and
 * caching it would hide a CLI that the user installs mid-session. */
const resolveCache = new Map<string, string>();

/** Test seam: forget every cached resolution. */
export function clearCommandResolutionCache(): void {
    resolveCache.clear();
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function isExecutableFile(candidate: string): boolean {
    if (!isFile(candidate)) { return false; }
    if (IS_WINDOWS) { return true; }
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Extensions to probe, in `PATHEXT` order, restricted to the ones we know how
 * to launch safely. `.vbs`, `.js`, `.wsf` … are deliberately excluded: they
 * require a script host and would reintroduce an interpreter we do not control.
 */
function candidateExtensions(): string[] {
    if (!IS_WINDOWS) { return ['']; }
    const known = [...DIRECT_EXEC_EXTENSIONS, ...SHIM_EXTENSIONS];
    const fromEnv = (process.env.PATHEXT || '')
        .split(';')
        .map(ext => ext.trim().toLowerCase())
        .filter(ext => known.includes(ext));
    return fromEnv.length > 0 ? fromEnv : known;
}

function searchDirectories(): string[] {
    const raw = process.env.PATH ?? process.env.Path ?? '';
    return raw
        .split(path.delimiter)
        .map(dir => dir.trim())
        // Windows allows quoted PATH entries; strip them before use.
        .map(dir => (dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir))
        .filter(dir => dir.length > 0);
}

function probe(basePath: string): string | null {
    if (IS_WINDOWS) {
        // An explicit extension wins, but only if we know how to launch it.
        const ext = path.extname(basePath).toLowerCase();
        if (ext && [...DIRECT_EXEC_EXTENSIONS, ...SHIM_EXTENSIONS].includes(ext)) {
            return isExecutableFile(basePath) ? basePath : null;
        }
    } else if (path.extname(basePath) && isExecutableFile(basePath)) {
        return basePath;
    }
    for (const ext of candidateExtensions()) {
        const candidate = basePath + ext;
        if (isExecutableFile(candidate)) { return candidate; }
    }
    return null;
}

/**
 * Resolve `cmd` to an absolute path by searching `PATH` (and `PATHEXT` on
 * Windows). Returns `null` when the command cannot be found. The current
 * working directory is intentionally *not* searched — that is a classic
 * binary-planting vector.
 */
export function resolveExecutable(cmd: string): string | null {
    if (!cmd) { return null; }

    const cached = resolveCache.get(cmd);
    if (cached !== undefined) { return cached; }

    let resolved: string | null = null;

    if (cmd.includes('/') || cmd.includes('\\') || path.isAbsolute(cmd)) {
        resolved = probe(path.resolve(cmd));
    } else {
        for (const dir of searchDirectories()) {
            resolved = probe(path.join(dir, cmd));
            if (resolved) { break; }
        }
    }

    if (resolved) {
        resolved = path.resolve(resolved);
        resolveCache.set(cmd, resolved);
    }
    return resolved;
}

/**
 * Characters that cannot be represented safely inside the `cmd.exe` command
 * line we build:
 *
 *  - `"` would unbalance the quoting we rely on to neutralise `& | < > ( ) ^`.
 *  - `%` is expanded by `cmd.exe` even inside double quotes.
 *  - `!` is expanded when delayed expansion is enabled machine-wide.
 *  - CR / LF / NUL terminate or split the command line.
 *
 * We reject rather than escape: escaping `cmd.exe` correctly is famously
 * error-prone, and no legitimate CI identifier needs these characters.
 */
const CMD_UNREPRESENTABLE = /["%!\r\n\u0000]/;

/**
 * Quote a single argument for inclusion in a `cmd.exe /d /s /c "…"` command
 * line. Throws for arguments that cannot be represented safely.
 */
export function quoteForCmdExe(arg: string): string {
    if (typeof arg !== 'string') {
        throw new TypeError('quoteForCmdExe: argument must be a string');
    }
    const unsafe = CMD_UNREPRESENTABLE.exec(arg);
    if (unsafe) {
        throw new Error(
            `Refusing to run command: argument contains a character that cannot be passed ` +
            `safely through cmd.exe (${JSON.stringify(unsafe[0])} in ${JSON.stringify(arg)})`
        );
    }
    // Wrapping in quotes makes `& | < > ( ) ^` literal for cmd.exe. A run of
    // trailing backslashes would otherwise escape the closing quote when the
    // target process re-parses the command line, so double it.
    const escaped = arg.replace(/(\\+)$/, '$1$1');
    return `"${escaped}"`;
}

function comSpec(): string {
    const fromEnv = process.env.ComSpec || process.env.COMSPEC;
    if (fromEnv && isFile(fromEnv)) { return fromEnv; }
    const systemRoot = process.env.SystemRoot || process.env.windir;
    if (systemRoot) {
        const fallback = path.join(systemRoot, 'System32', 'cmd.exe');
        if (isFile(fallback)) { return fallback; }
    }
    return 'cmd.exe';
}

/**
 * Build a `cmd.exe /d /s /c "<line>"` launch spec for `args`, quoting every
 * token ourselves. Throws when an argument cannot be represented safely.
 */
export function buildCmdExeLaunch(args: readonly string[]): LaunchSpec {
    const commandLine = args.map(quoteForCmdExe).join(' ');
    return {
        file: comSpec(),
        // /d skips AutoRun commands, /s makes the outer quote stripping
        // deterministic, /c runs and exits.
        args: ['/d', '/s', '/c', `"${commandLine}"`],
        windowsVerbatimArguments: true,
    };
}

/**
 * Build everything `execFile` needs to run `cmd` with `args` and **no shell**.
 *
 * Throws when an argument cannot be passed safely through the `cmd.exe` shim
 * path; callers should surface the message to the user.
 */
export function buildLaunchSpec(cmd: string, args: readonly string[]): LaunchSpec {
    const resolved = resolveExecutable(cmd);

    if (!resolved) {
        // Let `execFile` do its own lookup and fail with the usual ENOENT.
        // Still no shell — a missing CLI must never become a shell invocation.
        return { file: cmd, args: [...args], windowsVerbatimArguments: false };
    }

    const ext = path.extname(resolved).toLowerCase();
    if (IS_WINDOWS && SHIM_EXTENSIONS.includes(ext)) {
        return buildCmdExeLaunch([resolved, ...args]);
    }

    return { file: resolved, args: [...args], windowsVerbatimArguments: false };
}
