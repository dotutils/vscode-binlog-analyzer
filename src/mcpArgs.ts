/**
 * Pure helpers used by the MCP client. Kept in their own module so they
 * are unit-testable outside a VS Code host (mocha cannot load `vscode`).
 */

/**
 * Builds CLI args from a template string and binlog paths.
 * Template uses `${binlog}` as placeholder. The template is expanded
 * once per binlog path. E.g. `--binlog ${binlog}` with 2 paths produces
 * `['--binlog', 'a.binlog', '--binlog', 'b.binlog']`.
 */
export function buildMcpArgs(template: string, binlogPaths: string[]): string[] {
    return binlogPaths.flatMap(p =>
        template.replace(/\$\{binlog\}/g, p).split(/\s+/).filter(Boolean)
    );
}
