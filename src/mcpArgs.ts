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
