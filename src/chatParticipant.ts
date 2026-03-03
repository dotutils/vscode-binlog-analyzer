import * as vscode from 'vscode';

const SYSTEM_PROMPT = `You are an MSBuild build analysis expert embedded in VS Code. You help developers understand and fix build issues using MSBuild binary log (binlog) files.

IMPORTANT: The binlog file(s) are ALREADY PRE-LOADED by the MCP server via --binlog command-line arguments.
Do NOT call load_binlog — it is unnecessary and will fail. The data is already available.
Just directly call analysis tools like get_diagnostics, get_expensive_targets, list_projects, search_logs, etc.

You have access to MCP tools from baronfel.binlog.mcp that can:
- Get build diagnostics (errors, warnings) — get_diagnostics
- Analyze build timeline and performance — get_expensive_targets, get_expensive_tasks, get_project_build_times
- List and inspect MSBuild projects — list_projects, find_expensive_projects
- Search build events — search_logs, search_targets
- Examine evaluations — list_evaluations, get_evaluation_global_properties
- Analyze Roslyn analyzers — get_expensive_analyzers
- List source files — list_source_files

When answering questions:
1. NEVER call load_binlog — binlogs are already loaded
2. Use the available binlog MCP tools to get concrete data
3. Reference specific file paths, line numbers, and error codes
4. Explain MSBuild concepts when relevant (targets, properties, items, imports)
5. Suggest actionable fixes for build errors
6. For performance questions, identify the slowest targets and suggest optimizations

Common MSBuild node types: Build, Project, Target, Task, Message, Warning, Error, Property, Item, Import, ProjectEvaluation.`;

const COMMAND_PROMPTS: Record<string, string> = {
    errors: 'Get all build errors and warnings from the binlog. Show error codes, file paths, line numbers, and messages. Group by project. Suggest fixes for each error.',
    timeline: 'Analyze the build timeline and performance. Show the slowest targets and tasks, total build duration, and identify bottlenecks. Suggest optimizations.',
    targets: 'List the MSBuild targets that were executed. Show their execution order, duration, and dependencies. Highlight any targets that failed.',
    summary: 'Provide a comprehensive build summary: overall result, duration, number of projects, error/warning counts, key properties, and configuration. Highlight anything unusual.',
    secrets: 'Scan the binlog for potential secrets, credentials, API keys, tokens, connection strings, and sensitive data that may have been logged during the build. Report any findings.',
    compare: 'Compare the two loaded binlogs side by side. For EACH binlog, call list_projects, get_diagnostics, get_expensive_targets (top 5), and get_expensive_tasks (top 5) using the respective binlog_file path. Then produce a structured comparison highlighting KEY DIFFERENCES across these dimensions:\n' +
        '1. **Build Result**: Did one succeed and the other fail?\n' +
        '2. **Errors & Warnings**: New/removed diagnostics between the two builds\n' +
        '3. **Projects**: Added/removed projects, different target lists\n' +
        '4. **Performance**: Significant duration changes in targets and tasks (>20% change)\n' +
        '5. **Configuration**: Different SDK versions, properties, or task assemblies if visible\n' +
        'Present the comparison as a clear table or structured diff. Highlight anything that could explain a regression.',
};

export class BinlogChatParticipant {
    private binlogPaths: string[] = [];
    private participant: vscode.Disposable | undefined;

    setBinlogPaths(paths: string[]) {
        this.binlogPaths = paths;
    }

    register(context: vscode.ExtensionContext) {
        const participant = vscode.chat.createChatParticipant(
            'binlog-analyzer.binlog',
            this.handleRequest.bind(this)
        );

        participant.iconPath = new vscode.ThemeIcon('tools');

        this.participant = participant;
        context.subscriptions.push(participant);
    }

    private async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Build the user prompt — combine slash command context with user text
        const commandPrompt = request.command ? COMMAND_PROMPTS[request.command] || '' : '';

        // For /compare, require two binlogs and provide both paths explicitly
        if (request.command === 'compare') {
            if (this.binlogPaths.length < 2) {
                stream.markdown(
                    '⚠️ **Two binlogs required for comparison.**\n\n' +
                    'Load a second binlog:\n' +
                    '- Use **Binlog: Add File** (Ctrl+Shift+P)\n' +
                    '- Or attach multiple binlogs from Structured Log Viewer before clicking "Open in VS Code"\n'
                );
                return;
            }
        }

        const binlogContext = this.binlogPaths.length > 0
            ? (request.command === 'compare' && this.binlogPaths.length >= 2
                ? `Binlog A (first build): binlog_file="${this.binlogPaths[0]}"\n` +
                  `Binlog B (second build): binlog_file="${this.binlogPaths[1]}"\n` +
                  `Call each tool TWICE — once with each binlog_file path. Do NOT call load_binlog.`
                : `The binlog file is already loaded at: ${this.binlogPaths[0]}\n` +
                  `When calling MCP tools, use binlog_file="${this.binlogPaths[0]}" (the full absolute path). ` +
                  `Do NOT use a relative filename. Do NOT call load_binlog.` +
                  (this.binlogPaths.length > 1
                      ? `\nAdditional binlogs: ${this.binlogPaths.slice(1).join(', ')}`
                      : ''))
            : 'No binlog loaded yet.';

        const userMessage = [
            commandPrompt,
            request.prompt,
            binlogContext
        ].filter(Boolean).join('\n\n');

        // Find available MCP tools from the binlog MCP server
        const tools = vscode.lm.tools.filter(tool =>
            tool.name.includes('binlog') ||
            tool.name.includes('baronfel') ||
            tool.name.startsWith('baronfel_binlog_mcp')
        );

        if (tools.length === 0) {
            stream.markdown(
                '⚠️ No binlog MCP tools found. The MCP server may not be running.\n\n' +
                '**To fix:**\n' +
                '1. Check that `baronfel.binlog.mcp` is installed: `dotnet tool list -g`\n' +
                '2. Restart VS Code to reload MCP servers\n' +
                '3. Or try the **Build Analysis** chat mode instead\n'
            );
            return;
        }

        // Select a chat model
        const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
        const model = models[0] ?? (await vscode.lm.selectChatModels())[0];

        if (!model) {
            stream.markdown('⚠️ No language model available. Make sure GitHub Copilot is active.\n');
            return;
        }

        // Build messages
        const messages = [
            vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
            // Include conversation history for context
            ...context.history.map(turn => {
                if (turn instanceof vscode.ChatResponseTurn) {
                    const parts = turn.response
                        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                        .map(p => p.value.value);
                    return vscode.LanguageModelChatMessage.Assistant(parts.join(''));
                } else {
                    return vscode.LanguageModelChatMessage.User(
                        (turn as vscode.ChatRequestTurn).prompt
                    );
                }
            }),
            vscode.LanguageModelChatMessage.User(userMessage),
        ];

        // Send request with tools
        const toolReferences = tools.map(t => ({ name: t.name, toolReferenceName: t.name }));
        try {
            const chatRequest = await model.sendRequest(
                messages,
                {
                    tools: tools as unknown as vscode.LanguageModelChatTool[],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                },
                token
            );

            // Process the response — handle tool calls in a loop
            await this.processResponse(chatRequest, messages, model, tools, stream, token);

        } catch (err) {
            if (err instanceof vscode.LanguageModelError) {
                stream.markdown(`⚠️ Model error: ${err.message}\n\nTry using the **Build Analysis** chat mode instead — it has MCP tools pre-configured.`);
            } else {
                throw err;
            }
        }
    }

    private async processResponse(
        chatRequest: vscode.LanguageModelChatResponse,
        messages: vscode.LanguageModelChatMessage[],
        model: vscode.LanguageModelChat,
        tools: readonly vscode.LanguageModelToolInformation[],
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        depth: number = 0
    ): Promise<void> {
        // Prevent infinite tool call loops
        if (depth > 10) {
            stream.markdown('\n\n⚠️ Too many tool calls — stopping here.\n');
            return;
        }

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let hasText = false;

        for await (const part of chatRequest.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                stream.markdown(part.value);
                hasText = true;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        // If there were tool calls, invoke them and continue
        if (toolCalls.length > 0) {
            // Show tool activity
            for (const call of toolCalls) {
                stream.progress(`Calling ${call.name}...`);
            }

            // Execute tool calls
            const toolResults: vscode.LanguageModelToolResultPart[] = [];
            for (const call of toolCalls) {
                try {
                    const result = await vscode.lm.invokeTool(
                        call.name,
                        { input: call.input, toolInvocationToken: undefined },
                        token
                    );
                    toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    toolResults.push(
                        new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(`Error: ${errorMsg}`)
                        ])
                    );
                }
            }

            // Add assistant tool calls and results to messages
            messages.push(
                vscode.LanguageModelChatMessage.Assistant(toolCalls.map(tc => tc)),
            );
            messages.push(
                vscode.LanguageModelChatMessage.User(toolResults.map(tr => tr)),
            );

            // Continue conversation with tool results
            const nextRequest = await model.sendRequest(
                messages,
                {
                    tools: tools as unknown as vscode.LanguageModelChatTool[],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                },
                token
            );

            await this.processResponse(nextRequest, messages, model, tools, stream, token, depth + 1);
        }
    }

    dispose() {
        this.participant?.dispose();
    }
}
