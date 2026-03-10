import * as vscode from 'vscode';
import * as telemetry from './telemetry';

const SYSTEM_PROMPT = `You are an MSBuild build analysis expert embedded in VS Code. You help developers understand and fix build issues using MSBuild binary log (binlog) files.

IMPORTANT WORKFLOW:
1. FIRST call load_binlog with the binlog_file path provided in the context below. Do this ONLY ONCE at the start of the conversation.
2. THEN call analysis tools like get_diagnostics, get_expensive_targets, list_projects, search_logs, etc.
3. Every tool call MUST include the binlog_file parameter with the FULL ABSOLUTE PATH.

You have access to MCP tools from baronfel.binlog.mcp that can:
- Load a binlog — load_binlog (call once, then use other tools)
- Get build diagnostics (errors, warnings) — get_diagnostics
- Analyze build timeline and performance — get_expensive_targets, get_expensive_tasks, get_project_build_time
- List and inspect MSBuild projects — list_projects, get_expensive_projects
- Search build events — search_binlog, search_targets_by_name, search_tasks_by_name
- Inspect targets/tasks — get_target_info_by_name, get_task_info, list_tasks_in_target, get_project_target_list
- Examine evaluations — list_evaluations, get_evaluation_global_properties, get_evaluation_properties_by_name
- Analyze Roslyn analyzers — get_expensive_analyzers, get_task_analyzers
- List source files — list_files_from_binlog

When answering questions:
1. Call load_binlog ONCE at the start with the full binlog path
2. Use the available binlog MCP tools to get concrete data
3. Reference specific file paths, line numbers, and error codes
4. Explain MSBuild concepts when relevant (targets, properties, items, imports)
5. Suggest actionable fixes for build errors
6. For performance questions, provide SPECIFIC ACTIONABLE suggestions based on the actual targets/tasks found:

PERFORMANCE OPTIMIZATION PLAYBOOK (based on MSBuild team practices from dotnet/msbuild issues/PRs):
- ResolveAssemblyReferences is slow → Reduce transitive references, set ReferenceOutputAssembly="false" on non-API deps, consider <DisableTransitiveProjectReferences>true</DisableTransitiveProjectReferences>. RAR runs unconditionally even on incremental builds (MSBuild #2015). Trim unused PackageReferences.
- Csc/CoreCompile is slow → Check analyzer load with get_expensive_analyzers, consider <EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild> in CI, split large projects, enable <ProduceReferenceAssembly>true</ProduceReferenceAssembly>
- CopyFilesToOutputDirectory is slow → Set <UseCommonOutputDirectory>true</UseCommonOutputDirectory> or <CopyLocalLockFileAssemblies>false</CopyLocalLockFileAssemblies>. Use <SkipCopyUnchangedFiles>true</SkipCopyUnchangedFiles>. Consider --artifacts-path on .NET 8+.
- ResolvePackageAssets is slow → Use <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile> and check NuGet cache. Use --no-restore in CI after explicit restore step.
- NuGetSdkResolver overhead → Adds 180-400ms per project evaluation even when restored (MSBuild #4025). Avoid NuGet-based SDK resolvers if possible.
- GenerateNuspec/Pack targets → Disable with <IsPackable>false</IsPackable> if project doesn't produce a package
- Analyzers are slow → Move expensive analyzers to <EnforceCodeStyleInBuild> or suppress in CI with /p:RunAnalyzers=false, or set <AnalysisLevel>none</AnalysisLevel>
- Many projects rebuilding → Check if incremental build is broken (look for missing inputs/outputs on targets), verify <Deterministic>true</Deterministic>
- High evaluation time → Reduce Directory.Build.props complexity, check for wildcard globs scanning large directories. Use <EnableDefaultItems>false</EnableDefaultItems> for legacy projects.
- Overall build is slow → Suggest /maxcpucount, /graph mode, BuildInParallel=true, check if projects can be built concurrently
- Duplicate/redundant work → Look for targets running multiple times (×N count), suggest build deduplication
- ResolveProjectReferences shows huge time → MISLEADING — includes time waiting for dependent projects (MSBuild #3135). Focus on self-time of actual tasks.
- Incrementality anti-pattern → Targets with Inputs/Outputs that generate Items via Tasks: when skipped, Items disappear (MSBuild #13206). Separate computation targets from execution targets.
- Copy task batching → Avoid accidentally batching Copy tasks — runs once per item instead of batch (MSBuild #12884). Use batch-friendly patterns.
- Build output layout → Use --artifacts-path (.NET 8+) for centralized output, reducing redundant file copies across projects

Always provide the EXACT MSBuild property or command-line flag to use, and WHERE to add it (Directory.Build.props, .csproj, or CLI)

Common MSBuild node types: Build, Project, Target, Task, Message, Warning, Error, Property, Item, Import, ProjectEvaluation.`;

const COMMAND_PROMPTS: Record<string, string> = {
    errors: 'Get all build errors and warnings from the binlog. Show error codes, file paths, line numbers, and messages. Group by project. Suggest fixes for each error.',
    timeline: 'Analyze the build timeline and performance. Follow these steps:\n' +
        '1. Call get_expensive_targets (top 10) and get_expensive_tasks (top 10) to find bottlenecks\n' +
        '2. Call get_project_build_times to see per-project breakdown\n' +
        '3. Call get_expensive_analyzers to check if Roslyn analyzers are a bottleneck\n' +
        '4. For EACH slow item, provide a SPECIFIC actionable fix with the exact MSBuild property/flag to use and where to add it\n' +
        '5. Categorize suggestions by impact: 🔴 High Impact (>10% of build time), 🟡 Medium Impact (2-10%), 🟢 Low Impact (<2%)\n' +
        '6. End with a prioritized action plan: "Do X first for biggest improvement, then Y, then Z"\n' +
        '7. If parallel build is not fully utilized, suggest /maxcpucount and /graph mode',
    targets: 'List the MSBuild targets that were executed. Show their execution order, duration, and dependencies. Highlight any targets that failed.',
    summary: 'Provide a comprehensive build summary: overall result, duration, number of projects, error/warning counts, key properties, and configuration. Highlight anything unusual.',
    secrets: 'Scan the binlog for potential secrets, credentials, API keys, tokens, connection strings, and sensitive data that may have been logged during the build. Report any findings.',
    compare: 'Compare the two loaded binlogs. For EACH binlog, call get_expensive_targets (top 3) and get_diagnostics. Then produce a comparison:\n' +
        '1. **Build Result**: Success/failure for each\n' +
        '2. **Errors & Warnings**: New/removed diagnostics\n' +
        '3. **Performance**: Duration changes in top targets (>20% change)\n' +
        'Present as a structured diff. Keep response concise.',
    perf: 'Perform a DEEP performance analysis of this build. Follow these steps:\n' +
        '1. Call get_expensive_targets (top 15), get_expensive_tasks (top 15), get_project_build_times, and get_expensive_analyzers\n' +
        '2. Calculate what percentage of total build time each item represents\n' +
        '3. For EACH bottleneck, provide a SPECIFIC fix:\n' +
        '   - The exact MSBuild property or CLI flag to set\n' +
        '   - WHERE to add it (Directory.Build.props for repo-wide, specific .csproj, or CLI arg)\n' +
        '   - Expected impact (e.g., "typically saves 20-40% on this target")\n' +
        '   - Any trade-offs or caveats\n' +
        '4. Check for these common issues:\n' +
        '   - Targets running multiple times (×N) — may indicate redundant work\n' +
        '   - Expensive analyzers that could be disabled in CI (/p:RunAnalyzers=false)\n' +
        '   - Projects that could build in parallel but are serialized\n' +
        '   - Copy-heavy builds that waste I/O\n' +
        '5. Output a prioritized action plan as a numbered list:\n' +
        '   🔴 HIGH IMPACT (do first): Items consuming >10% of build time\n' +
        '   🟡 MEDIUM IMPACT: Items consuming 2-10% of build time\n' +
        '   🟢 QUICK WINS: Easy changes with modest impact\n' +
        '6. End with concrete next steps the developer can copy-paste into their build files',
    incremental: 'Analyze build INCREMENTALITY — determine if this build is doing unnecessary work that could be skipped on rebuild. Follow these steps:\n' +
        '\n' +
        'STEP 1: Get target execution data\n' +
        'Call get_expensive_targets with top_number=20. Look at the skippedCount vs executionCount for each target:\n' +
        '  - skippedCount=0 with high executionCount → target NEVER skips, likely not incremental\n' +
        '  - skippedCount > 0 → target has some incrementality\n' +
        '  - skippedCount = executionCount → target is fully incremental (always skips when up-to-date)\n' +
        '\n' +
        'STEP 2: Search for skip/rebuild messages\n' +
        'Call search_binlog with these queries (one at a time):\n' +
        '  - "skipping" — finds "Skipping target X because all output files are up-to-date"\n' +
        '  - "up-to-date" — finds up-to-date check messages\n' +
        '  - "out of date" — finds targets that rebuilt because outputs were stale\n' +
        '  - "Building target" — finds explicit rebuild-reason messages\n' +
        '\n' +
        'STEP 3: Drill into specific targets\n' +
        'For each expensive target with skippedCount=0, call search_targets_by_name to see which projects ran it and which skipped it.\n' +
        'Call get_target_info_by_name for specific project+target to see its Inputs/Outputs configuration.\n' +
        '\n' +
        'STEP 4: Produce an INCREMENTALITY REPORT with these sections:\n' +
        '\n' +
        '📊 **Incrementality Score**: Calculate = (total skipped target executions / total target executions) × 100%\n' +
        'Use actual skippedCount and executionCount from get_expensive_targets data.\n' +
        '\n' +
        '🔴 **Never Skips** (targets with skippedCount=0 and high duration):\n' +
        'For each, explain likely reasons and provide the EXACT fix:\n' +
        '  - SDK targets (CoreCompile, ResolveAssemblyReferences) → These are expected to run on clean builds. On no-op rebuilds they should skip. Suggest user build twice and check.\n' +
        '  - Custom targets missing Inputs/Outputs → Show the Target element with correct Inputs="@(Compile)" Outputs="$(IntermediateOutputPath)..." attributes\n' +
        '  - Glob picking up generated files → Add <DefaultItemExcludes> or move output to $(IntermediateOutputPath)\n' +
        '\n' +
        '🟡 **Sometimes Skips** (targets with 0 < skippedCount < executionCount):\n' +
        'These run in some projects but skip in others — investigate why\n' +
        '\n' +
        '✅ **Always Skips**: Targets that properly skip every time (skippedCount = executionCount)\n' +
        '\n' +
        '🔧 **Action Plan**:\n' +
        'Numbered list of changes to make, ordered by impact. For each fix, provide:\n' +
        '  1. The exact MSBuild XML to add/modify\n' +
        '  2. Which file to edit (Directory.Build.props, specific .csproj, or custom .targets)\n' +
        '  3. How to verify: "Run `dotnet build -bl:first.binlog && dotnet build -bl:second.binlog` — second build should be <2s"\n' +
        '\n' +
        'End with: "To verify incrementality is fixed, build twice and compare: the second build should complete in under 2 seconds with most targets showing as skipped."',
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

        // Track slash command usage
        if (request.command) {
            telemetry.trackSlashCommand(request.command);
        }

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
                  `Call load_binlog ONCE for each binlog_file, then call each analysis tool TWICE — once with each binlog_file path.`
                : `The binlog file path is: ${this.binlogPaths[0]}\n` +
                  `FIRST call load_binlog with binlog_file="${this.binlogPaths[0]}". ` +
                  `Then call analysis tools with binlog_file="${this.binlogPaths[0]}" (the full absolute path). ` +
                  `Do NOT use a relative filename.` +
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
        // For /compare, skip history to avoid token overflow (two binlogs = lots of tool data)
        const includeHistory = request.command !== 'compare';
        const messages = [
            vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
            // Include conversation history — only text-based turns (skip for /compare)
            ...(includeHistory ? context.history.flatMap(turn => {
                if (turn instanceof vscode.ChatResponseTurn) {
                    const textParts = turn.response
                        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                        .map(p => p.value.value);
                    const text = textParts.join('');
                    // Skip empty responses (likely tool-only turns)
                    if (!text.trim()) { return []; }
                    return [vscode.LanguageModelChatMessage.Assistant(text)];
                } else {
                    const prompt = (turn as vscode.ChatRequestTurn).prompt;
                    if (!prompt.trim()) { return []; }
                    return [vscode.LanguageModelChatMessage.User(prompt)];
                }
            }) : []),
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
            const errMsg = err instanceof Error ? err.message : String(err);
            telemetry.trackError('chatParticipant', err);
            // Handle corrupted tool history — retry without conversation history
            if (errMsg.includes('invalid_request_body') || errMsg.includes('tool_calls') || errMsg.includes("role 'tool'")) {
                const freshMessages = [
                    vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
                    vscode.LanguageModelChatMessage.User(userMessage),
                ];
                try {
                    const retryRequest = await model.sendRequest(
                        freshMessages,
                        {
                            tools: tools as unknown as vscode.LanguageModelChatTool[],
                            toolMode: vscode.LanguageModelChatToolMode.Auto,
                        },
                        token
                    );
                    await this.processResponse(retryRequest, freshMessages, model, tools, stream, token);
                } catch (retryErr) {
                    const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    stream.markdown(`⚠️ Error: ${retryMsg}\n\nTry starting a **new chat** or use the **Build Analysis** chat mode instead.`);
                }
            } else if (err instanceof vscode.LanguageModelError) {
                stream.markdown(`⚠️ Model error: ${errMsg}\n\nTry using the **Build Analysis** chat mode instead — it has MCP tools pre-configured.`);
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
            try {
                const nextRequest = await model.sendRequest(
                    messages,
                    {
                        tools: tools as unknown as vscode.LanguageModelChatTool[],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                    },
                    token
                );

                await this.processResponse(nextRequest, messages, model, tools, stream, token, depth + 1);
            } catch (err) {
                // Handle invalid_request_body errors from malformed tool message history
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('invalid_request_body') || msg.includes('tool_calls')) {
                    // Retry without tools — just get a text response
                    const retryRequest = await model.sendRequest(messages, {}, token);
                    for await (const part of retryRequest.stream) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            stream.markdown(part.value);
                        }
                    }
                } else {
                    throw err;
                }
            }
        }
    }

    dispose() {
        this.participant?.dispose();
    }
}
