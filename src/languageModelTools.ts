import * as vscode from 'vscode';
import { McpClient } from './mcpClient';

/**
 * Bridges BinlogInsights MCP tools into VS Code's `vscode.lm.tools` registry.
 *
 * Why this exists
 * ---------------
 * Without this bridge, only the `@binlog` chat participant can analyze a
 * loaded binlog. Other agents (`@workspace`, custom chat modes, the agent
 * mode, the test agent, etc.) have no idea a binlog is loaded.
 *
 * By contributing `languageModelTools` and registering them with
 * `vscode.lm.registerTool`, any model anywhere in the IDE can call
 * `binlog_lm_overview`, `binlog_lm_errors`, `binlog_lm_search`,
 * `binlog_lm_perf` and `binlog_lm_compare` against the binlog(s) the
 * user has loaded — closing the
 * "knowledge gap between customers, builds and AI assistance" gap that
 * motivated this extension.
 *
 * Each tool here is a thin facade that forwards to a single underlying
 * BinlogInsights MCP tool (or, in the case of `binlog_lm_perf`, a small
 * fan-out of MCP tools). When a single binlog is loaded, `binlog_file`
 * is auto-injected; when multiple are loaded the model must pass
 * `binlog` explicitly, matching the behaviour of `McpClient.callTool`.
 */
export interface BinlogToolContext {
    /** Returns the live MCP client, or null if no binlog is loaded. */
    getClient(): McpClient | null;
    /** All currently loaded binlog paths. */
    getBinlogPaths(): readonly string[];
}

interface BinlogToolInput {
    /** Optional explicit binlog path. Required when >1 binlog is loaded. */
    binlog?: string;
    /** Free-text query — used by `binlog_search` only. */
    query?: string;
    /** Optional second binlog path for `binlog_compare`. */
    binlog_other?: string;
}

const TOOL_DEFS: Array<{
    name: string;
    mcpTool: string | null; // null = composed tool (handled specially)
    description: string;
}> = [
    {
        name: 'binlog_lm_overview',
        mcpTool: 'binlog_overview',
        description: 'Summarise the loaded MSBuild binary log: build result, duration, project count, top-level errors and warnings.',
    },
    {
        name: 'binlog_lm_errors',
        mcpTool: 'binlog_errors',
        description: 'List build errors and warnings from the loaded MSBuild binary log with file paths, line numbers and error codes.',
    },
    {
        name: 'binlog_lm_search',
        mcpTool: 'binlog_search',
        description: 'Free-text search across all build events in the loaded MSBuild binary log (targets, tasks, messages, properties).',
    },
    {
        name: 'binlog_lm_perf',
        mcpTool: null,
        description: 'Performance analysis: returns expensive targets, tasks, projects and Roslyn analyzers from the loaded MSBuild binary log.',
    },
    {
        name: 'binlog_lm_compare',
        mcpTool: 'binlog_compare',
        description: 'Compare two loaded MSBuild binary logs and report differences in result, errors, properties and target durations.',
    },
];

class BinlogLmTool implements vscode.LanguageModelTool<BinlogToolInput> {
    constructor(
        private readonly ctx: BinlogToolContext,
        private readonly mcpToolName: string | null,
        private readonly toolName: string,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<BinlogToolInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        // The MCP client may still be initializing (especially right after
        // binlog load when /summary fires immediately). Wait up to 10 s
        // for it to become ready before giving up.
        let client = this.ctx.getClient();
        if (client && !client.isReady) {
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 500));
                client = this.ctx.getClient();
                if (!client || client.isReady) break;
            }
        }
        const loaded = this.ctx.getBinlogPaths();

        if (!client || !client.isReady) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'No binlog is currently loaded. Ask the user to load one via "Binlog: Load File" or "Binlog: Build & Collect Binlog".',
                ),
            ]);
        }

        const input = options.input ?? {};
        const args: Record<string, unknown> = {};

        // Resolve which binlog path to target.
        if (input.binlog) {
            args.binlog_file = input.binlog;
        } else if (loaded.length === 1) {
            args.binlog_file = loaded[0];
        } else if (loaded.length > 1) {
            const list = loaded.map((p, i) => `  ${String.fromCharCode(65 + i)}: ${p}`).join('\n');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Multiple binlogs are loaded — please call ${this.toolName} again with an explicit \`binlog\` argument set to one of:\n${list}`,
                ),
            ]);
        }

        if (this.toolName === 'binlog_lm_search') {
            if (!input.query) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('binlog_lm_search requires a `query` argument.'),
                ]);
            }
            args.query = input.query;
        }

        if (this.toolName === 'binlog_lm_compare') {
            if (!input.binlog_other && loaded.length < 2) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        'binlog_lm_compare needs two binlogs. Pass `binlog` and `binlog_other`, or load a second binlog first.',
                    ),
                ]);
            }
            // binlog_compare uses binlog_file_a / binlog_file_b (not binlog_file)
            args.binlog_file_a = args.binlog_file || loaded[0];
            args.binlog_file_b = input.binlog_other ?? loaded[1];
            delete args.binlog_file;
        }

        try {
            if (this.mcpToolName) {
                const result = await client.callTool(this.mcpToolName, args);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(result.text || '(empty result)'),
                ]);
            }

            // Composed tool: binlog_perf fans out to four MCP tools.
            const parts: string[] = [];
            for (const sub of [
                'binlog_expensive_projects',
                'binlog_expensive_targets',
                'binlog_expensive_tasks',
                'binlog_expensive_analyzers',
            ]) {
                try {
                    const r = await client.callTool(sub, args);
                    parts.push(`## ${sub}\n${r.text}`);
                } catch (err) {
                    parts.push(`## ${sub}\nError: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(parts.join('\n\n')),
            ]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Tool ${this.toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
                ),
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<BinlogToolInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const target = options.input?.binlog ?? this.ctx.getBinlogPaths()[0];
        const suffix = target ? ` on ${target.split(/[/\\]/).pop()}` : '';
        return {
            invocationMessage: `Running ${this.toolName}${suffix}…`,
        };
    }
}

/**
 * Register every binlog LM tool with VS Code. Returns a Disposable that
 * unregisters them all.
 */
export function registerBinlogLanguageModelTools(
    context: vscode.ExtensionContext,
    toolCtx: BinlogToolContext,
): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    for (const def of TOOL_DEFS) {
        const tool = new BinlogLmTool(toolCtx, def.mcpTool, def.name);
        disposables.push(vscode.lm.registerTool(def.name, tool));
    }
    const composite = vscode.Disposable.from(...disposables);
    context.subscriptions.push(composite);
    return composite;
}
