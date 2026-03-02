import * as vscode from 'vscode';

const SYSTEM_PROMPT = `You are an MSBuild build analysis expert embedded in VS Code. You help developers understand and fix build issues using MSBuild binary log (binlog) files.

You have access to MCP tools from baronfel.binlog.mcp that can:
- Load and parse binlog files
- Get build diagnostics (errors, warnings)
- Analyze build timeline and performance
- List and inspect MSBuild targets
- Search build events and properties
- Examine project evaluations

When answering questions:
1. Use the available binlog MCP tools to get concrete data
2. Reference specific file paths, line numbers, and error codes
3. Explain MSBuild concepts when relevant (targets, properties, items, imports)
4. Suggest actionable fixes for build errors
5. For performance questions, identify the slowest targets and suggest optimizations

Common MSBuild node types: Build, Project, Target, Task, Message, Warning, Error, Property, Item, Import, ProjectEvaluation.`;

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
        const command = request.command;

        // Build context message
        let contextInfo = '';
        if (this.binlogPaths.length > 0) {
            const pathList = this.binlogPaths.map(p => `\`${p}\``).join(', ');
            contextInfo = `\n\nLoaded binlog(s): ${pathList}`;
        }

        const loadedLabel = this.binlogPaths.length > 0
            ? this.binlogPaths.map(p => p.split(/[/\\]/).pop()).join(', ')
            : 'not loaded';

        switch (command) {
            case 'errors':
                stream.markdown('Analyzing build errors and warnings...\n\n');
                stream.markdown(
                    `Use the binlog MCP tools to investigate errors. ` +
                    `Loaded: \`${loadedLabel}\`\n\n` +
                    `Try asking:\n` +
                    `- "What errors are in the build?"\n` +
                    `- "Why did the build fail?"\n` +
                    `- "Show me all CS* compiler errors"\n`
                );
                break;

            case 'timeline':
                stream.markdown('Analyzing build timeline and performance...\n\n');
                stream.markdown(
                    `Use the binlog MCP tools to analyze build performance. ` +
                    `Loaded: \`${loadedLabel}\`\n\n` +
                    `Try asking:\n` +
                    `- "What are the slowest targets?"\n` +
                    `- "Show the build timeline"\n` +
                    `- "Which projects took the longest?"\n`
                );
                break;

            case 'targets':
                stream.markdown('Analyzing MSBuild targets...\n\n');
                stream.markdown(
                    `Use the binlog MCP tools to inspect targets. ` +
                    `Loaded: \`${loadedLabel}\`\n\n` +
                    `Try asking:\n` +
                    `- "List all executed targets"\n` +
                    `- "Why did target X run?"\n` +
                    `- "Show the target dependency graph"\n`
                );
                break;

            case 'summary':
                stream.markdown('Generating build summary...\n\n');
                stream.markdown(
                    `Use the binlog MCP tools for a comprehensive summary. ` +
                    `Loaded: \`${loadedLabel}\`\n\n` +
                    `Ask for:\n` +
                    `- Overall build result and duration\n` +
                    `- Number of projects built\n` +
                    `- Error and warning counts\n` +
                    `- Key properties and configurations\n`
                );
                break;

            case 'secrets':
                stream.markdown('🔐 **Scanning for secrets in binlog...**\n\n');
                stream.markdown(
                    `The binlog may contain sensitive data like API keys, connection strings, tokens, and usernames ` +
                    `that were passed as MSBuild properties or environment variables during the build.\n\n` +
                    `**Detection categories:**\n` +
                    `- **CommonSecrets** — API keys, SAS tokens, connection strings, passwords\n` +
                    `- **ExplicitSecrets** — Values explicitly marked as secrets in MSBuild\n` +
                    `- **Username** — Username/identity information\n\n` +
                    `**What you can do:**\n` +
                    `- Search \`$secret\` in the Structured Log Viewer to find secrets in the tree\n` +
                    `- Search \`$secret not(Username)\` to exclude username detection\n` +
                    `- Use the \`Binlog: Redact Secrets\` command to create a redacted copy\n` +
                    `- Ask me to analyze specific properties for sensitive data\n\n` +
                    `Loaded: \`${loadedLabel}\`\n`
                );
                break;

            default:
                // General question - provide system prompt context
                stream.markdown(
                    `I'm the MSBuild Binlog Analyzer. ${this.binlogPaths.length > 0 ? `Loaded: \`${loadedLabel}\`.` : 'No binlog loaded yet.'}\n\n` +
                    `I can help with:\n` +
                    `- \`/errors\` — Analyze build errors and warnings\n` +
                    `- \`/timeline\` — Build performance analysis\n` +
                    `- \`/targets\` — MSBuild target inspection\n` +
                    `- \`/summary\` — Comprehensive build summary\n` +
                    `- \`/secrets\` — Scan for leaked secrets and credentials\n\n` +
                    `Or just ask any question about your build!${contextInfo}\n`
                );
                break;
        }
    }

    dispose() {
        this.participant?.dispose();
    }
}
