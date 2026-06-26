/**
 * Versioned-envelope handling at the MCP boundary. Kept in its own pure module
 * (no `vscode` import) so it is unit-testable outside a VS Code host, like
 * `mcpArgs.ts`.
 *
 * With `--envelope`, the binlog-mcp server wraps each *contract* tool's result
 * in a JSON envelope `{ schemaVersion, kind, data, error }`. This extension
 * consumes the major-1 (ungrouped) envelope: validate the major, surface a
 * server-side `error`, and hand the inner `data` back to the existing parsers
 * as JSON text — so downstream consumers stay unchanged.
 *
 * Not every tool is enveloped. Empirically (and per the server's Program.cs),
 * only the tools in `ENVELOPE_CONTRACT_TOOLS` switch to enveloped output under
 * `--envelope`; the rest still return bare JSON or plain text and must pass
 * through untouched.
 */

/** Schema major versions this (ungrouped) extension understands. v2 is grouped — out of scope. */
export const SUPPORTED_CONTRACT_MAJORS: readonly number[] = [1];

export interface ContractEnvelope<TData = unknown> {
    schemaVersion: string;
    kind: string;
    data?: TData;
    error?: { code: string; message: string };
}

/**
 * Tools that the envelope-aware server wraps under `--envelope` AND that this
 * extension consumes. A *non-envelope* response from one of these means an old
 * binlog-mcp ignored the unknown `--envelope` flag and returned legacy v1
 * output (bare arrays for projects/errors/warnings/analyzers, prose for
 * overview/compare). Source: server `Program.cs` registers the enveloped
 * variants of exactly these tools when `--envelope` is set.
 */
export const ENVELOPE_CONTRACT_TOOLS: ReadonlySet<string> = new Set([
    'binlog_overview',
    'binlog_projects',
    'binlog_errors',
    'binlog_warnings',
    'binlog_expensive_analyzers',
    'binlog_compare',
]);

/** Shared remediation step appended to old-server / startup-failure messages. */
const UPDATE_INSTRUCTION =
    'Update it with: dotnet tool update -g Microsoft.AITools.BinlogMcp ' +
    '(dnceng dotnet-tools feed).';

/** Actionable message shown when the installed server predates `--envelope`. */
export const OLD_SERVER_MESSAGE =
    'The installed binlog-mcp server is too old to support --envelope. ' +
    UPDATE_INSTRUCTION;

/**
 * Error message for when the init handshake never completes. Distinguishes a
 * server that *exited* during startup from one that stays up but never answers.
 *
 * The only startup variable this extension adds is `--envelope`, so a process
 * that exits during the handshake most likely means the installed server
 * rejected that unknown flag — surface the actionable update instruction. A
 * process that is still running (no exit observed) is unresponsive for some
 * other reason, so keep the generic message there.
 *
 * @param startupExitCode the child's exit code if it exited during startup
 *   (`null` when terminated by a signal), or `undefined` if it was still
 *   running when the handshake gave up.
 */
export function initFailureMessage(startupExitCode: number | null | undefined): string {
    if (startupExitCode === undefined) {
        return 'Failed to initialize MCP server after 5 attempts';
    }
    const code = startupExitCode === null ? 'unknown' : String(startupExitCode);
    return (
        `The binlog-mcp server exited during startup (exit code ${code}). ` +
        'This usually means the installed server is too old to support --envelope. ' +
        UPDATE_INSTRUCTION
    );
}

function isEnvelope(value: unknown): value is ContractEnvelope {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof (value as { schemaVersion?: unknown }).schemaVersion === 'string';
}

/** Whether the envelope's `schemaVersion` is a major this extension supports. */
export function isSupportedMajor(schemaVersion: string): boolean {
    const major = Number(schemaVersion.split('.')[0]);
    return Number.isInteger(major) && SUPPORTED_CONTRACT_MAJORS.includes(major);
}

/**
 * Unwrap a tool's text result at the MCP boundary.
 *
 * - Envelope present → validate the major, surface a server-side `error`, then
 *   return the inner `data` re-serialized as JSON text (downstream parses it
 *   exactly as it parsed legacy v1 output).
 * - No envelope on a contract tool → throw the actionable old-server error.
 * - No envelope on any other tool → return the text unchanged (legitimate bare
 *   JSON such as `binlog_expensive_targets`, or plain text such as a
 *   `binlog_search` "No results" message).
 */
export function unwrapToolResultText(toolName: string, text: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Not JSON. Plain-text tools pass through, but a contract tool emitting
        // prose (legacy overview/compare) means the server ignored --envelope.
        if (ENVELOPE_CONTRACT_TOOLS.has(toolName)) {
            throw new Error(OLD_SERVER_MESSAGE);
        }
        return text;
    }

    if (isEnvelope(parsed)) {
        if (!isSupportedMajor(parsed.schemaVersion)) {
            throw new Error(
                `Unsupported binlog-mcp envelope schemaVersion '${parsed.schemaVersion}' ` +
                `for tool '${toolName}'; this extension supports major ${SUPPORTED_CONTRACT_MAJORS.join(', ')}.`
            );
        }
        if (parsed.error) {
            throw new Error(`binlog-mcp '${parsed.kind || toolName}' error ${parsed.error.code}: ${parsed.error.message}`);
        }
        if (parsed.data === undefined) {
            throw new Error(`binlog-mcp envelope for '${toolName}' contained no data.`);
        }
        return JSON.stringify(parsed.data);
    }

    // Parsed as JSON but not an envelope (bare array/object). For a contract
    // tool that is legacy v1 from an old server; for everything else it is the
    // normal, unenveloped shape and must pass through unchanged.
    if (ENVELOPE_CONTRACT_TOOLS.has(toolName)) {
        throw new Error(OLD_SERVER_MESSAGE);
    }
    return text;
}
