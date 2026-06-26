/**
 * Pure helpers used by the MCP client. Kept in their own module so they
 * are unit-testable outside a VS Code host (mocha cannot load `vscode`).
 */

/**
 * Builds CLI args from a template string and binlog paths.
 *
 * The template uses `${binlog}` as a placeholder. The template is tokenized
 * on whitespace ONCE, then `${binlog}` is substituted in each token per
 * binlog path. This preserves paths that contain spaces — they remain a
 * single argv entry instead of fragmenting.
 *
 * Example: `--binlog ${binlog}` with `['/tmp/has space.binlog']` produces
 * `['--binlog', '/tmp/has space.binlog']` (two argv entries, not three).
 */
export function buildMcpArgs(template: string, binlogPaths: string[]): string[] {
    const tokens = template.split(/\s+/).filter(Boolean);
    return binlogPaths.flatMap(p =>
        tokens.map(t => t.replace(/\$\{binlog\}/g, p))
    );
}

/**
 * Launch flags this extension requires from the binlog-mcp server.
 *
 * `--envelope` makes the server wrap each contract tool's result in a versioned
 * JSON envelope (schemaVersion major 1) whose `data` is the same ungrouped v1
 * payload the extension already parses. We deliberately do NOT pass `--grouped`
 * (that selects the v2 grouped envelope, which is out of scope here).
 */
export const CONTRACT_LAUNCH_FLAGS: readonly string[] = ['--envelope'];

/**
 * Builds the full server argv: the contract launch flags followed by the
 * per-binlog args. Mirrors `buildMcpArgs` but prepends `--envelope` so the
 * extension always consumes the versioned envelope.
 */
export function buildLaunchArgs(template: string, binlogPaths: string[]): string[] {
    return [...CONTRACT_LAUNCH_FLAGS, ...buildMcpArgs(template, binlogPaths)];
}
