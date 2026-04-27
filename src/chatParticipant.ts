import * as vscode from 'vscode';

import * as telemetry from './telemetry';
import { McpClient } from './mcpClient';
import { PlaybookLoader } from './playbooks';
import {
    runBuildCheck, detectSdkVersion, formatBuildCheckForChat,
    initBuildCheckDiagnostics, pushBuildCheckToProblemsPanel
} from './buildCheck';

/**
 * Slash commands whose responses are entirely derived from a single round
 * of tool data — they don't benefit from prior chat history and we save
 * many tokens by dropping it.
 */
const STATELESS_COMMANDS = new Set([
    'errors', 'summary', 'targets', 'compare', 'perf', 'incremental',
    'search', 'properties', 'items', 'buildcheck', 'propertyhistory',
]);

/**
 * Slash commands that benefit from the heavy domain playbooks injected
 * alongside the per-command prompt.
 */
const PLAYBOOK_FOR_COMMAND: Record<string, 'perf' | 'incremental' | undefined> = {
    perf: 'perf',
    timeline: 'perf',
    incremental: 'incremental',
};

export class BinlogChatParticipant {
    private binlogPaths: string[] = [];
    private participant: vscode.Disposable | undefined;
    private playbooks!: PlaybookLoader;

    setBinlogPaths(paths: string[]) {
        this.binlogPaths = paths;
    }

    /**
     * Kept for binary compat with existing call sites in extension.ts.
     * The chat participant routes through `vscode.lm.tools` (the
     * BinlogInsights MCP tools are surfaced via the platform), so it does
     * not need a direct reference to the McpClient.
     */
    setMcpClient(_client: McpClient | null) {
        // intentionally a no-op
    }

    register(context: vscode.ExtensionContext) {
        this.playbooks = new PlaybookLoader(context.extensionUri);
        const participant = vscode.chat.createChatParticipant(
            'binlog-analyzer.binlog',
            this.handleRequest.bind(this),
        );
        participant.iconPath = new vscode.ThemeIcon('tools');
        this.participant = participant;
        context.subscriptions.push(participant);
    }

    private async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<void> {
        if (request.command) {
            telemetry.trackSlashCommand(request.command);
        }

        // --- Guard: /compare needs two binlogs ---------------------------------
        if (request.command === 'compare' && this.binlogPaths.length < 2) {
            stream.markdown(
                '⚠️ **Two binlogs required for comparison.**\n\n' +
                'Use **Binlog: Add File** (Ctrl+Shift+P) to load a second one, ' +
                'or attach multiple binlogs from Structured Log Viewer before ' +
                'clicking "Open in VS Code".\n',
            );
            return;
        }

        // --- /buildcheck: run analysis locally, suppress tools ------------------
        let buildCheckBlock = '';
        const isBuildCheck = request.command === 'buildcheck';
        if (isBuildCheck) {
            if (this.binlogPaths.length === 0) {
                stream.markdown('⚠️ No binlog loaded. Load a binlog first.\n');
                return;
            }
            const { supported, sdkVersion } = await detectSdkVersion();
            if (!supported) {
                stream.markdown(
                    `⚠️ **BuildCheck requires .NET SDK 9.0.100+.** Your version: ${sdkVersion}\n\n` +
                    'Install .NET SDK 9.0.100+ or rebuild with `-check`: ' +
                    '`dotnet build -check -bl:build.binlog`\n',
                );
                return;
            }
            stream.progress('Running BuildCheck (dotnet build <binlog> /check)…');
            const summary = await runBuildCheck(this.binlogPaths[0]);
            buildCheckBlock = formatBuildCheckForChat(summary);
            const collection = initBuildCheckDiagnostics();
            pushBuildCheckToProblemsPanel(summary, collection);
        }

        // --- Tools selection ----------------------------------------------------
        const config = vscode.workspace.getConfiguration('binlogAnalyzer');
        const includeAllTools = config.get<boolean>('chat.includeAllTools', false);
        const additionalPatterns = config.get<string[]>('chat.additionalToolPatterns', []);

        let tools: readonly vscode.LanguageModelToolInformation[];
        if (isBuildCheck) {
            tools = []; // buildcheck data is injected verbatim — no tool calls needed
        } else if (includeAllTools) {
            tools = vscode.lm.tools;
        } else {
            // Match both the in-process LM-tool wrappers (binlog_lm_*) and the
            // MCP-server tools when VS Code has registered them. The wrappers
            // are the reliable path: they go through the tree's already-running
            // McpClient and don't depend on VS Code's mcp.json startup timing.
            tools = vscode.lm.tools.filter(t =>
                t.name.startsWith('binlog_') ||
                t.name.includes('binlog_insights') ||
                additionalPatterns.some(p => t.name.includes(p)),
            );
        }

        if (tools.length === 0 && !isBuildCheck) {
            stream.markdown(
                '⚠️ No binlog MCP tools found. The MCP server may not be running.\n\n' +
                '1. Check `dotnet tool list -g` for `BinlogInsights.Mcp`\n' +
                '2. Restart VS Code to reload MCP servers\n',
            );
            return;
        }

        // --- Model selection ----------------------------------------------------
        const model =
            (await vscode.lm.selectChatModels({ family: 'gpt-4o' }))[0] ??
            (await vscode.lm.selectChatModels())[0];
        if (!model) {
            stream.markdown('⚠️ No language model available. Make sure GitHub Copilot is active.\n');
            return;
        }

        // --- Build prompts (lazy) ----------------------------------------------
        const systemPrompt = this.buildSystemPrompt(request.command);
        const userMessage = this.buildUserMessage(request, buildCheckBlock);

        // --- History gating ----------------------------------------------------
        const includeHistory = !STATELESS_COMMANDS.has(request.command || '');
        const historyMessages = includeHistory ? this.buildHistory(context) : [];

        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt),
            ...historyMessages,
            vscode.LanguageModelChatMessage.User(userMessage),
        ];

        try {
            const chatRequest = await model.sendRequest(
                messages,
                {
                    tools: tools as unknown as vscode.LanguageModelChatTool[],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                },
                token,
            );
            await this.processResponse(chatRequest, messages, model, tools, stream, token);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            telemetry.trackError('chatParticipant', err);

            // Corrupted tool history → retry without history
            if (
                errMsg.includes('invalid_request_body') ||
                errMsg.includes('tool_calls') ||
                errMsg.includes("role 'tool'") ||
                errMsg.includes('tool_call_id') ||
                errMsg.includes('400')
            ) {
                try {
                    const fresh = [
                        vscode.LanguageModelChatMessage.User(systemPrompt),
                        vscode.LanguageModelChatMessage.User(userMessage),
                    ];
                    const retry = await model.sendRequest(
                        fresh,
                        {
                            tools: tools as unknown as vscode.LanguageModelChatTool[],
                            toolMode: vscode.LanguageModelChatToolMode.Auto,
                        },
                        token,
                    );
                    await this.processResponse(retry, fresh, model, tools, stream, token);
                } catch (retryErr) {
                    const m = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    stream.markdown(`⚠️ Error: ${m}\n\nTry starting a **new chat**.`);
                }
            } else if (err instanceof vscode.LanguageModelError) {
                stream.markdown(`⚠️ Model error: ${errMsg}`);
            } else {
                throw err;
            }
        }
    }

    /**
     * System prompt = always-on `core` playbook + the per-command instruction
     * + an optional heavy domain playbook (perf/incremental). Total budget
     * is typically ~250 tokens vs the prior ~1500 baseline.
     */
    private buildSystemPrompt(command: string | undefined): string {
        const parts: string[] = [this.playbooks.get('core')];

        if (command) {
            const cmd = this.playbooks.getCommand(command);
            if (cmd) parts.push(`# /${command}\n${cmd}`);
        }

        const playbookKey = command ? PLAYBOOK_FOR_COMMAND[command] : undefined;
        if (playbookKey) {
            parts.push(`# Playbook: ${playbookKey}\n${this.playbooks.get(playbookKey)}`);
        }

        return parts.filter(Boolean).join('\n\n');
    }

    /**
     * The user message wraps the user's free text in <user_request> tags
     * (so the model can tell user input apart from system context) plus a
     * small machine-generated context block describing which binlog(s) are
     * loaded. Per-command instructions have already been folded into the
     * system prompt.
     */
    private buildUserMessage(request: vscode.ChatRequest, buildCheckBlock: string): string {
        const parts: string[] = [];

        if (this.binlogPaths.length === 0) {
            parts.push('<binlogs>none loaded</binlogs>');
        } else if (this.binlogPaths.length === 1) {
            // Single binlog: surface the absolute path. The MCP client
            // auto-injects when binlog_file is omitted, but if the model
            // *does* pass a value (e.g. echoing the filename it sees here)
            // it must be the absolute path or the MCP server can't resolve it.
            parts.push(
                `<binlogs count="1">\n  <binlog path="${escapeAttr(this.binlogPaths[0])}"/>\n</binlogs>\n` +
                `When calling tools you may omit binlog_file (the extension fills it in) ` +
                `or pass the full path verbatim — never a bare filename.`,
            );
        } else {
            // Multi-binlog → MCP throws if binlog_file is omitted, so the
            // model MUST learn the absolute paths and labels.
            const labels = this.binlogPaths.map((p, i) => {
                const name = p.split(/[/\\]/).pop() || `binlog ${i + 1}`;
                const tag = name.includes('_cold') ? 'cold' :
                            name.includes('_warm') ? 'warm' :
                            i === 0 ? 'a' : String.fromCharCode(97 + i);
                return `  <binlog tag="${tag}" path="${escapeAttr(p)}"/>`;
            }).join('\n');
            parts.push(
                `<binlogs count="${this.binlogPaths.length}">\n${labels}\n</binlogs>\n` +
                `Pass binlog_file=PATH explicitly on every tool call.`,
            );
        }

        if (buildCheckBlock) {
            parts.push(`<buildcheck>\n${buildCheckBlock}\n</buildcheck>`);
        }

        const userText = (request.prompt || '').trim();
        parts.push(`<user_request>\n${userText || '(no user text — apply the slash command)'}\n</user_request>`);

        return parts.join('\n\n');
    }

    private buildHistory(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
        return context.history.flatMap(turn => {
            if (turn instanceof vscode.ChatResponseTurn) {
                const text = turn.response
                    .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                    .map(p => p.value.value)
                    .join('');
                if (!text.trim()) return [];
                // Skip turns containing tool calls — they cause 400 errors when
                // serialized back into a fresh request without tool_call_ids.
                const hasToolCalls = turn.response.some(p => !(p instanceof vscode.ChatResponseMarkdownPart));
                if (hasToolCalls) return [];
                return [vscode.LanguageModelChatMessage.Assistant(text)];
            }
            const prompt = (turn as vscode.ChatRequestTurn).prompt;
            if (!prompt || !prompt.trim()) return [];
            return [vscode.LanguageModelChatMessage.User(prompt)];
        });
    }

    private async processResponse(
        chatRequest: vscode.LanguageModelChatResponse,
        messages: vscode.LanguageModelChatMessage[],
        model: vscode.LanguageModelChat,
        tools: readonly vscode.LanguageModelToolInformation[],
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        depth: number = 0,
    ): Promise<void> {
        if (depth > 10) {
            stream.markdown('\n\n⚠️ Too many tool calls — stopping here.\n');
            return;
        }

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const part of chatRequest.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                stream.markdown(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        if (toolCalls.length === 0) return;

        for (const call of toolCalls) {
            stream.progress(`Calling ${call.name}…`);
        }

        const toolResultTexts: string[] = [];
        for (const call of toolCalls) {
            try {
                const result = await vscode.lm.invokeTool(
                    call.name,
                    { input: call.input, toolInvocationToken: undefined },
                    token,
                );
                const text = result.content
                    .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
                    .map(p => p.value)
                    .join('\n');
                toolResultTexts.push(`<tool_result name="${call.name}">\n${text || '(empty)'}\n</tool_result>`);
            } catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                toolResultTexts.push(`<tool_result name="${call.name}" error="true">${m}</tool_result>`);
            }
        }

        // Flatten tool calls into a user turn — the LM API surface for
        // round-tripping LanguageModelToolResultPart varies between VS Code
        // versions, so we keep the textual fallback that already worked.
        // The XML wrapping makes the boundary explicit for the model.
        messages.push(
            vscode.LanguageModelChatMessage.User(toolResultTexts.join('\n\n')),
        );

        try {
            const nextRequest = await model.sendRequest(
                messages,
                {
                    tools: tools as unknown as vscode.LanguageModelChatTool[],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                },
                token,
            );
            await this.processResponse(nextRequest, messages, model, tools, stream, token, depth + 1);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('invalid_request_body') || msg.includes('tool_calls')) {
                const retry = await model.sendRequest(messages, {}, token);
                for await (const part of retry.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        stream.markdown(part.value);
                    }
                }
            } else {
                throw err;
            }
        }
    }

    dispose() {
        this.participant?.dispose();
    }
}

function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
