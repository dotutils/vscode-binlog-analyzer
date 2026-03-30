import * as vscode from 'vscode';

import * as telemetry from './telemetry';
import { McpClient } from './mcpClient';

const SYSTEM_PROMPT = `You are an MSBuild build analysis expert embedded in VS Code. You help developers understand and fix build issues using MSBuild binary log (binlog) files.

IMPORTANT WORKFLOW:
1. Start with binlog_overview to understand the build status.
2. If the build failed, use binlog_errors to see what went wrong.
3. Drill deeper based on error type. Every tool call MUST include the binlog_file parameter with the FULL ABSOLUTE PATH.

You have access to MCP tools from BinlogInsights that can:
- Build overview — binlog_overview (start here)
- Get errors and warnings — binlog_errors, binlog_warnings
- Inspect MSBuild properties — binlog_properties
- Trace import chains — binlog_imports
- Check items (PackageReference, Compile, etc.) — binlog_items, binlog_item_types
- NuGet restore diagnostics — binlog_nuget
- Compiler command line — binlog_compiler
- Free-text search — binlog_search
- List projects — binlog_projects
- Effective project XML — binlog_preprocess
- Compare two builds — binlog_compare
- Performance: expensive projects — binlog_expensive_projects, binlog_project_target_times
- Performance: expensive targets — binlog_expensive_targets, binlog_search_targets, binlog_project_targets
- Performance: expensive tasks — binlog_expensive_tasks, binlog_search_tasks, binlog_tasks_in_target, binlog_task_details
- Roslyn analyzer performance — binlog_expensive_analyzers
- Evaluations — binlog_evaluations, binlog_evaluation_global_properties, binlog_evaluation_properties
- Embedded source files — binlog_list_files, binlog_get_file

When answering questions:
1. Use binlog_overview first to understand the build status
2. Use the available BinlogInsights MCP tools to get concrete data
3. Reference specific file paths, line numbers, and error codes
4. Explain MSBuild concepts when relevant (targets, properties, items, imports)
5. Suggest actionable fixes for build errors
6. For performance questions, provide SPECIFIC ACTIONABLE suggestions based on the actual targets/tasks found:

PERFORMANCE OPTIMIZATION PLAYBOOK (based on MSBuild team practices from dotnet/msbuild issues/PRs and dotnet/skills):

SEVERITY THRESHOLDS (use these to classify findings):
- RAR (ResolveAssemblyReferences): >5s is concerning, >15s is pathological
- Analyzers: should be <30% of Csc task time. If higher, disable non-essential ones
- Node utilization: ideal is >80% active time. Low = serialization bottleneck
- Single target domination: if one target is >50% of total build time, investigate
- Build duration benchmarks: small project <10s, medium <60s, large <5min

BOTTLENECK FIXES:
- ResolveAssemblyReferences is slow → Reduce transitive references, set ReferenceOutputAssembly="false" on non-API deps, consider <DisableTransitiveProjectReferences>true</DisableTransitiveProjectReferences>. RAR runs unconditionally even on incremental builds (MSBuild #2015). Trim unused PackageReferences.
- Csc/CoreCompile is slow → Check analyzer load with get_expensive_analyzers. IMPORTANT: disable analyzers conditionally, not globally: <RunAnalyzers Condition="'$(ContinuousIntegrationBuild)' != 'true'">false</RunAnalyzers>. Also consider <RunAnalyzersDuringBuild>false</RunAnalyzersDuringBuild> for VS startup perf. Enable <ProduceReferenceAssembly>true</ProduceReferenceAssembly> (especially important for older non-SDK-style projects). For code-style: <EnforceCodeStyleInBuild Condition="'$(ContinuousIntegrationBuild)' == 'true'">true</EnforceCodeStyleInBuild>.
- CopyFilesToOutputDirectory is slow → Enable hardlinks: <CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>true</CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>. Also set <UseCommonOutputDirectory>true</UseCommonOutputDirectory> or <CopyLocalLockFileAssemblies>false</CopyLocalLockFileAssemblies>. Use <SkipCopyUnchangedFiles>true</SkipCopyUnchangedFiles>. Consider --artifacts-path on .NET 8+. IMPORTANT: recommend Dev Drive (ReFS) on Windows — copy-on-write filesystem with less aggressive Defender scans dramatically reduces I/O overhead (https://aka.ms/devdrive).
- ResolvePackageAssets is slow → Use <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile> AND <RestoreUseStaticGraphEvaluation>true</RestoreUseStaticGraphEvaluation> in Directory.Build.props (can save 20s+ in large solutions). Separate restore from build: \`dotnet restore\` then \`dotnet build --no-restore\`.
- NuGetSdkResolver overhead → Adds 180-400ms per project evaluation even when restored (MSBuild #4025). Avoid NuGet-based SDK resolvers if possible.
- GenerateNuspec/Pack targets → Disable with <IsPackable>false</IsPackable> if project doesn't produce a package
- Analyzers via GlobalPackageReference → Analyzers in Directory.Packages.props apply to ALL projects. Consider if test projects need the same analyzer set as production code.
- Many projects rebuilding → Check if incremental build is broken. Verify custom targets have Inputs/Outputs. Register generated files in <FileWrites> for clean support. Verify <Deterministic>true</Deterministic>.
- High evaluation time → Reduce Directory.Build.props complexity, check for wildcard globs scanning large directories. Use <EnableDefaultItems>false</EnableDefaultItems> for legacy projects.
- Overall build is slow → Suggest /maxcpucount, /graph mode, BuildInParallel=true, check if projects can be built concurrently. Enable MSBuild Server for CLI builds: set environment variable MSBUILDUSESERVER=1 for better caching in incremental builds.
- Project graph shape → Avoid deep chains of project dependencies (a wide graph builds much faster than a deep one — 40% faster clean, 20% faster incremental). Consider splitting bottleneck projects or merging small projects to reduce dependency depth.
- Duplicate/redundant work → Look for targets running multiple times (×N count), suggest build deduplication. Check for inline tasks with high overhead (can add >1s vs 3ms for compiled tasks).
- ResolveProjectReferences shows huge time → MISLEADING — includes time waiting for dependent projects (MSBuild #3135). Focus on self-time of actual tasks.
- Incrementality anti-pattern → Targets with Inputs/Outputs that generate Items via Tasks: when skipped, Items disappear (MSBuild #13206). Separate computation targets (always-run, no Inputs/Outputs) from execution targets. Use Returns instead of Outputs when you only need to pass items without incremental checking.
- Copy task batching → Avoid accidentally batching Copy tasks — runs once per item instead of batch (MSBuild #12884). Use batch-friendly patterns.
- Build output layout → Use --artifacts-path (.NET 8+) for centralized output, reducing redundant file copies across projects
- bin/obj clashes → Multiple projects or multi-targeting writing to same OutputPath/IntermediateOutputPath causes intermittent failures. Ensure AppendTargetFrameworkToOutputPath=true and unique BaseIntermediateOutputPath per project.
- First-time analysis → Run \`dotnet build /check\` for built-in BuildCheck diagnostics before diving into binlog analysis.

Always provide the EXACT MSBuild property or command-line flag to use, and WHERE to add it (Directory.Build.props, .csproj, or CLI)

Common MSBuild node types: Build, Project, Target, Task, Message, Warning, Error, Property, Item, Import, ProjectEvaluation.`;

const COMMAND_PROMPTS: Record<string, string> = {
    errors: 'Get all build errors and warnings from the binlog. Use binlog_errors and binlog_warnings. Show error codes, file paths, line numbers, and messages. Group by project. Suggest fixes for each error.',
    timeline: 'Analyze the build timeline and performance. Follow these steps:\n' +
        '1. Call binlog_expensive_targets and binlog_expensive_tasks to find bottlenecks\n' +
        '2. Call binlog_expensive_projects to see per-project breakdown\n' +
        '3. Call binlog_expensive_analyzers to check if Roslyn analyzers are a bottleneck\n' +
        '4. For EACH slow item, provide a SPECIFIC actionable fix with the exact MSBuild property/flag to use and where to add it\n' +
        '5. Categorize suggestions by impact: 🔴 High Impact (>10% of build time), 🟡 Medium Impact (2-10%), 🟢 Low Impact (<2%)\n' +
        '6. End with a prioritized action plan: "Do X first for biggest improvement, then Y, then Z"\n' +
        '7. If parallel build is not fully utilized, suggest /maxcpucount and /graph mode',
    targets: 'List the MSBuild targets that were executed using binlog_expensive_targets. Show their execution order, duration, and dependencies. Highlight any targets that failed.',
    summary: 'Provide a comprehensive build summary using binlog_overview: overall result, duration, number of projects, error/warning counts, key properties, and configuration. Highlight anything unusual.',

    compare: 'Compare ALL loaded binlogs using binlog_compare. For EACH binlog, also call binlog_expensive_targets and binlog_errors. Then produce a comparison:\n' +
        '1. **Build Result**: Success/failure for each\n' +
        '2. **Errors & Warnings**: New/removed diagnostics\n' +
        '3. **Performance**: Duration changes in top targets across all binlogs\n' +
        'If there are cold/warm pairs (e.g. optimized_1_cold + optimized_1_warm), highlight the incremental improvement.\n' +
        'Present as a structured table. Keep response concise.',
    perf: 'Perform a DEEP performance analysis of this build. Follow these steps:\n' +
        '1. Call binlog_expensive_targets, binlog_expensive_tasks, binlog_expensive_projects, and binlog_expensive_analyzers\n' +
        '2. Calculate what percentage of total build time each item represents\n' +
        '3. Apply these SEVERITY THRESHOLDS:\n' +
        '   - RAR >5s is concerning, >15s is pathological\n' +
        '   - Analyzers should be <30% of Csc task time\n' +
        '   - Any single target >50% of total build time is a red flag\n' +
        '4. For EACH bottleneck, provide a SPECIFIC fix:\n' +
        '   - The exact MSBuild property or CLI flag to set\n' +
        '   - WHERE to add it (Directory.Build.props for repo-wide, specific .csproj, or CLI arg)\n' +
        '   - Expected impact (e.g., "typically saves 20-40% on this target")\n' +
        '   - Any trade-offs or caveats\n' +
        '5. Check for these common issues:\n' +
        '   - Targets running multiple times (×N) — may indicate redundant work\n' +
        '   - Expensive analyzers — disable conditionally: <RunAnalyzers Condition="\'$(ContinuousIntegrationBuild)\' != \'true\'">false</RunAnalyzers>\n' +
        '   - Projects that could build in parallel but are serialized\n' +
        '   - Copy-heavy builds — suggest hardlinks: <CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>true</CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>\n' +
        '   - ResolveProjectReferences time is misleading (includes wait time) — focus on actual task self-time\n' +
        '6. Output a prioritized action plan as a numbered list:\n' +
        '   🔴 HIGH IMPACT (do first): Items consuming >10% of build time\n' +
        '   🟡 MEDIUM IMPACT: Items consuming 2-10% of build time\n' +
        '   🟢 QUICK WINS: Easy changes with modest impact\n' +
        '7. End with concrete next steps the developer can copy-paste into their build files',
    incremental: 'Analyze build INCREMENTALITY — determine if this build is doing unnecessary work that could be skipped on rebuild. Follow these steps:\n' +
        '\n' +
        'STEP 1: Get target execution data\n' +
        'Call binlog_expensive_targets with limit=20. Look at the skippedCount vs executionCount for each target:\n' +
        '  - skippedCount=0 with high executionCount → target NEVER skips, likely not incremental\n' +
        '  - skippedCount > 0 → target has some incrementality\n' +
        '  - skippedCount = executionCount → target is fully incremental (always skips when up-to-date)\n' +
        '\n' +
        'STEP 2: Search for skip/rebuild messages\n' +
        'Call binlog_search with these queries (one at a time):\n' +
        '  - "skipping" — finds "Skipping target X because all output files are up-to-date"\n' +
        '  - "up-to-date" — finds up-to-date check messages\n' +
        '  - "out of date" — finds targets that rebuilt because outputs were stale\n' +
        '  - "Building target" — finds explicit rebuild-reason messages\n' +
        '\n' +
        'STEP 3: Drill into specific targets\n' +
        'For each expensive target with skippedCount=0, call binlog_search_targets to see which projects ran it and which skipped it.\n' +
        'Call binlog_project_targets for specific project+target to see its Inputs/Outputs configuration.\n' +
        '\n' +
        'STEP 4: Produce an INCREMENTALITY REPORT with these sections:\n' +
        '\n' +
        '📊 **Incrementality Score**: Calculate = (total skipped target executions / total target executions) × 100%\n' +
        'Use actual skippedCount and executionCount from binlog_expensive_targets data.\n' +
        '\n' +
        '🔴 **Never Skips** (targets with skippedCount=0 and high duration):\n' +
        'For each, explain likely reasons and provide the EXACT fix:\n' +
        '  - SDK targets (CoreCompile, ResolveAssemblyReferences) → These are expected to run on clean builds. On no-op rebuilds they should skip. Suggest user build twice and check.\n' +
        '  - Custom targets missing Inputs/Outputs → Show the Target element with correct Inputs="@(Compile)" Outputs="$(IntermediateOutputPath)..." attributes. Register generated files in <FileWrites> for clean support.\n' +
        '  - Glob picking up generated files → Add <DefaultItemExcludes> or move output to $(IntermediateOutputPath)\n' +
        '  - Targets that pass items without needing incrementality → Use Returns instead of Outputs\n' +
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
    search: 'Search across ALL build events in the binlog. The user\'s query follows. ' +
        'Use binlog_search with the user\'s search terms. ' +
        'Present results grouped by category (errors, warnings, messages, targets, tasks). ' +
        'For each result, show the file path and line number if available. ' +
        'Highlight the most relevant matches first.',
    properties:'Show the MSBuild PROPERTIES from the build. ' +
        'Use binlog_properties to get all evaluated properties. ' +
        'Group them by category: Configuration (Configuration, Platform, TargetFramework), ' +
        'Output (OutputPath, IntermediateOutputPath, BaseOutputPath), ' +
        'NuGet (NuGetPackageRoot, RestorePackagesPath), ' +
        'SDK (MSBuildToolsVersion, NETCoreSdkVersion), ' +
        'and Other. Show values and explain any unusual or misconfigured properties.',
    items: 'Show the MSBuild ITEMS from the build. ' +
        'First use binlog_item_types to list all available item types. ' +
        'Then show the most important ones: PackageReference, ProjectReference, Compile, Content, None, Reference. ' +
        'For each type, use binlog_items to get the actual items and their metadata. ' +
        'Highlight any issues (duplicate references, version conflicts, unnecessary includes).',
};

export class BinlogChatParticipant {
    private binlogPaths: string[] = [];
    private mcpClient: McpClient | null = null;
    private participant: vscode.Disposable | undefined;

    setBinlogPaths(paths: string[]) {
        this.binlogPaths = paths;
    }

    setMcpClient(client: McpClient | null) {
        this.mcpClient = client;
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

        const binlogContext= this.binlogPaths.length > 0
            ? (request.command === 'compare' && this.binlogPaths.length >= 2
                ? this.binlogPaths.map((p, i) => {
                    const name = p.split(/[/\\]/).pop() || `binlog ${i + 1}`;
                    const label = name.includes('_cold') ? '(cold build)' :
                                  name.includes('_warm') ? '(warm/incremental build)' :
                                  i === 0 ? '(baseline)' : `(build ${i + 1})`;
                    return `Binlog ${String.fromCharCode(65 + i)} ${label}: binlog_file="${p}"`;
                  }).join('\n') + '\n' +
                  `Use binlog_compare, binlog_expensive_targets, and binlog_errors for EACH binlog_file path.`
                : `The binlog file path is: ${this.binlogPaths[0]}\n` +
                  `Use BinlogInsights tools with binlog_file="${this.binlogPaths[0]}" (the full absolute path). ` +
                  `Start with binlog_overview.` +
                  (this.binlogPaths.length > 1
                      ? `\nAdditional binlogs: ${this.binlogPaths.slice(1).join(', ')}`
                      : ''))
            : 'No binlog loaded yet.';

        const userMessage = [
            commandPrompt,
            request.prompt,
            binlogContext
        ].filter(Boolean).join('\n\n') || 'Analyze the binlog.';

        // Find available tools based on configuration
        const config = vscode.workspace.getConfiguration('binlogAnalyzer');
        const includeAllTools = config.get<boolean>('chat.includeAllTools', false);
        const additionalPatterns = config.get<string[]>('chat.additionalToolPatterns', []);

        let tools: readonly vscode.LanguageModelToolInformation[];
        if (includeAllTools) {
            tools = vscode.lm.tools;
        } else {
            tools = vscode.lm.tools.filter(tool =>
                tool.name.includes('binlog') ||
                tool.name.includes('binlog_insights') ||
                tool.name.startsWith('binlog_insights_mcp') ||
                additionalPatterns.some(pattern => tool.name.includes(pattern))
            );
        }

        if (tools.length === 0) {
            stream.markdown(
                '⚠️ No binlog MCP tools found. The MCP server may not be running.\n\n' +
                '**To fix:**\n' +
                '1. Check that `BinlogInsights.Mcp` is installed: `dotnet tool list -g`\n' +
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
        // For data-heavy commands, skip history and use minimal system prompt to avoid token overflow
        const heavyCommands = new Set(['compare', 'incremental', 'perf']);
        const useMinimalPrompt = heavyCommands.has(request.command || '');
        const systemPrompt = request.command === 'compare'
            ? `You are an MSBuild build analysis expert. Compare binlog files using BinlogInsights MCP tools. Use binlog_compare, binlog_expensive_targets, and binlog_errors for each binlog. Keep response concise.`
            : useMinimalPrompt
            ? `You are an MSBuild build analysis expert. Use BinlogInsights MCP tools to analyze binlog files. Start with binlog_overview, then use analysis tools. Every tool call MUST include the binlog_file parameter with the FULL ABSOLUTE PATH. Provide specific actionable fixes with exact MSBuild properties.`
            : SYSTEM_PROMPT;
        const includeHistory = !useMinimalPrompt;
        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt || ' '),
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
                    if (!prompt || !prompt.trim()) { return []; }
                    return [vscode.LanguageModelChatMessage.User(prompt)];
                }
            }) : []),
            vscode.LanguageModelChatMessage.User(userMessage || 'Analyze the binlog.'),
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
                    vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT || ' '),
                    vscode.LanguageModelChatMessage.User(userMessage || 'Analyze the binlog.'),
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
            if (toolCalls.length > 0) {
                messages.push(
                    vscode.LanguageModelChatMessage.Assistant([
                        new vscode.LanguageModelTextPart(''),
                        ...toolCalls,
                    ]),
                );
                messages.push(
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelTextPart('Tool results:'),
                        ...toolResults,
                    ]),
                );
            }

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
