import * as vscode from 'vscode';
import { BinlogDiagnosticsProvider } from './diagnostics';
import { BinlogChatParticipant } from './chatParticipant';
import { BinlogTreeDataProvider } from './binlogTreeView';
import { McpClient } from './mcpClient';
import { BinlogDocumentProvider, BINLOG_SCHEME, openBinlogDocument } from './binlogDocumentProvider';

let diagnosticsProvider: BinlogDiagnosticsProvider | undefined;
let chatParticipant: BinlogChatParticipant | undefined;
let treeDataProvider: BinlogTreeDataProvider | undefined;
let mcpClient: McpClient | undefined;
let binlogDocProvider: BinlogDocumentProvider | undefined;
let currentBinlogPath: string | undefined;
let allBinlogPaths: string[] = [];
let statusBarItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let openedViaUri = false;

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    diagnosticsProvider = new BinlogDiagnosticsProvider();
    chatParticipant = new BinlogChatParticipant();

    // Virtual document provider for binlog content in editor
    binlogDocProvider = new BinlogDocumentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(BINLOG_SCHEME, binlogDocProvider)
    );

    // Binlog Explorer tree view in sidebar
    treeDataProvider = new BinlogTreeDataProvider();
    const treeView = vscode.window.createTreeView('binlogExplorer', {
        treeDataProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    // Status bar item showing loaded binlog count
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'binlog.manageBinlogs';
    context.subscriptions.push(statusBarItem);

    // URI handler: vscode://binlog-analyzer/open?path={binlogPath}&path={binlogPath2}...
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri: vscode.Uri) {
                if (uri.path === '/open') {
                    openedViaUri = true;
                    const params = new URLSearchParams(uri.query);
                    const binlogPaths = params.getAll('path');
                    if (binlogPaths.length > 0) {
                        handleBinlogOpen(binlogPaths, context);
                    } else {
                        vscode.window.showErrorMessage('Binlog Analyzer: No binlog path provided in URI.');
                    }
                }
            }
        })
    );

    // Command: Load File (file picker) — replaces all loaded binlogs
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.loadFile', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: true,
                filters: { 'Binary Logs': ['binlog'] },
                title: 'Select MSBuild Binary Log(s)'
            });

            if (uris && uris.length > 0) {
                handleBinlogOpen(uris.map(u => u.fsPath), context);
            }
        })
    );

    // Command: Add Binlog — adds more binlogs to the current session
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.addFile', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: true,
                filters: { 'Binary Logs': ['binlog'] },
                title: 'Add MSBuild Binary Log(s) to Current Session'
            });

            if (uris && uris.length > 0) {
                const newPaths = uris.map(u => u.fsPath);
                await addBinlogs(newPaths);
            }
        })
    );

    // Command: Remove Binlog — remove a binlog from the session
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.removeFile', async () => {
            if (allBinlogPaths.length === 0) {
                vscode.window.showWarningMessage('No binlogs loaded.');
                return;
            }

            const items = allBinlogPaths.map((p, i) => ({
                label: `$(file) ${getFileName(p)}`,
                description: p,
                index: i,
                isPrimary: i === 0
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select binlog(s) to remove',
                canPickMany: true,
                title: 'Remove Binlogs'
            });

            if (selected && selected.length > 0) {
                const toRemove = new Set(selected.map(s => s.description));
                await removeBinlogs(toRemove);
            }
        })
    );

    // Command: Manage Binlogs — quick pick showing all loaded binlogs with actions
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.manageBinlogs', async () => {
            if (allBinlogPaths.length === 0) {
                // No binlogs — offer to load
                const action = await vscode.window.showQuickPick(
                    [{ label: '$(add) Load Binlog File...', action: 'load' }],
                    { placeHolder: 'No binlogs loaded' }
                );
                if (action?.action === 'load') {
                    vscode.commands.executeCommand('binlog.loadFile');
                }
                return;
            }

            const items: (vscode.QuickPickItem & { action?: string })[] = [
                ...allBinlogPaths.map((p, i) => ({
                    label: `$(file) ${getFileName(p)}`,
                    description: i === 0 ? '(primary)' : '',
                    detail: p
                })),
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                { label: '$(add) Add More Binlogs...', action: 'add' },
                { label: '$(trash) Remove Binlog...', action: 'remove' },
                { label: '$(folder-opened) Open Project Folder...', action: 'folder' },
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `${allBinlogPaths.length} binlog(s) loaded`,
                title: 'Binlog Analyzer — Manage Binlogs'
            }) as (vscode.QuickPickItem & { action?: string }) | undefined;

            if (selected?.action === 'add') {
                vscode.commands.executeCommand('binlog.addFile');
            } else if (selected?.action === 'remove') {
                vscode.commands.executeCommand('binlog.removeFile');
            } else if (selected?.action === 'folder') {
                vscode.commands.executeCommand('binlog.openProjectFolder');
            }
        })
    );

    // Command: Open Project Folder — for cross-machine binlogs
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.openProjectFolder', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: 'Open the local project folder corresponding to this binlog'
            });

            if (uris && uris.length > 0) {
                // Add the folder to the workspace without reloading the window
                const folderUri = uris[0];
                const folders = vscode.workspace.workspaceFolders || [];
                vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: folderUri });
            }
        })
    );

    // Command: Show Build Summary — opens binlog content in editor
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.showBuildSummary', async () => {
            if (!currentBinlogPath) {
                vscode.window.showWarningMessage('No binlog loaded. Use "Binlog: Load File" first.');
                return;
            }
            await openBinlogDocument('/summary', getFileName(currentBinlogPath));
        })
    );

    // Command: Open binlog section in editor
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.openInEditor', async (section: string, label: string) => {
            await openBinlogDocument(section, label);
        })
    );

    // Command: Open project details in editor
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.openProjectDetails', async (projectId: string, projectFile: string, _targets: unknown) => {
            const section = `/project/${encodeURIComponent(projectId)}`;
            const fileName = projectFile.split(/[/\\]/).pop() || projectFile;
            await openBinlogDocument(section, fileName);
        })
    );

    // Command: Refresh Tree
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.refreshTree', () => {
            treeDataProvider?.refresh();
        })
    );

    // Command: Set Workspace Folder — pick from binlog project paths or browse
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.setWorkspaceFolder', async () => {
            try {
                // Try to find candidate folders from binlog project paths
                const candidates = treeDataProvider?.getProjectRootCandidates() || [];
                const fs = require('fs');
                const existing: string[] = candidates.filter((c: string) => {
                    try { return fs.existsSync(c); } catch { return false; }
                });

                let folderUri: vscode.Uri | undefined;

                if (existing.length > 0) {
                    const items: vscode.QuickPickItem[] = existing.map((p: string) => ({
                        label: p.replace(/\//g, '\\'),
                        description: 'detected from binlog',
                    }));
                    items.push({ label: 'Browse...', description: 'pick a folder manually' });

                    const pick = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select the project source folder',
                        title: 'Set Workspace Folder',
                    });
                    if (!pick) { return; }

                    if (pick.label === 'Browse...') {
                        const result = await vscode.window.showOpenDialog({
                            canSelectFolders: true, canSelectFiles: false,
                            canSelectMany: false, openLabel: 'Select Project Folder',
                        });
                        if (!result || result.length === 0) { return; }
                        folderUri = result[0];
                    } else {
                        folderUri = vscode.Uri.file(pick.label);
                    }
                } else {
                    // No candidates — go straight to folder browser
                    const result = await vscode.window.showOpenDialog({
                        canSelectFolders: true, canSelectFiles: false,
                        canSelectMany: false, openLabel: 'Select Project Folder',
                        title: 'Select the project source folder for this binlog',
                    });
                    if (!result || result.length === 0) { return; }
                    folderUri = result[0];
                }

                if (!folderUri) { return; }

                // Save binlog paths before workspace change so they survive potential reload
                const config = vscode.workspace.getConfiguration('binlogAnalyzer');
                await config.update('activeBinlogs', allBinlogPaths, vscode.ConfigurationTarget.Global);

                // Replace the workspace folder (keeps single-root, no restart needed)
                const existingFolders = vscode.workspace.workspaceFolders || [];
                const alreadyAdded = existingFolders.some(f => f.uri.fsPath === folderUri!.fsPath);
                if (!alreadyAdded) {
                    if (existingFolders.length > 0) {
                        vscode.workspace.updateWorkspaceFolders(0, 1, { uri: folderUri });
                    } else {
                        vscode.workspace.updateWorkspaceFolders(0, 0, { uri: folderUri });
                    }
                }
                treeDataProvider?.refresh();
                vscode.window.showInformationMessage(`Workspace set to: ${folderUri.fsPath}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set workspace folder: ${err?.message || err}`);
            }
        })
    );

    // Command: Fix All Issues — launches Copilot agent to fix all build errors/warnings
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.fixAllIssues', async () => {
            if (!currentBinlogPath) {
                vscode.window.showWarningMessage('No binlog loaded.');
                return;
            }

            const binlogFile = currentBinlogPath;
            const fileName = getFileName(binlogFile);

            // Build a prompt that instructs Copilot to fix all issues in a loop
            const prompt = `@binlog /errors\n\n` +
                `Please fix ALL build errors and warnings reported in the binlog "${fileName}". ` +
                `For each issue:\n` +
                `1. Read the error/warning code, message, file path, and line number\n` +
                `2. Open the source file and fix the issue\n` +
                `3. Move to the next issue\n\n` +
                `After fixing all issues, run the build command to verify the fixes. ` +
                `If new issues appear, fix those too. Continue until the build is clean (0 errors, 0 warnings). ` +
                `When done, show a summary of all changes made.`;

            vscode.commands.executeCommand('workbench.action.chat.open', prompt);
        })
    );

    // Command: Show Errors
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.showErrors', async () => {
            if (!currentBinlogPath) {
                vscode.window.showWarningMessage('No binlog loaded. Use "Binlog: Load File" first.');
                return;
            }
            // Focus the Problems panel
            vscode.commands.executeCommand('workbench.actions.view.problems');
        })
    );

    // Command: Scan for Secrets
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.scanSecrets', async () => {
            const targetPath = currentBinlogPath;
            if (!targetPath) {
                vscode.window.showWarningMessage('No binlog loaded. Use "Binlog: Load File" first.');
                return;
            }
            await scanForSecrets(targetPath);
        })
    );

    // Command: Redact Secrets
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.redactSecrets', async () => {
            let targetPath = currentBinlogPath;
            if (!targetPath) {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectMany: false,
                    filters: { 'Binary Logs': ['binlog'] },
                    title: 'Select binlog to redact'
                });
                if (!uris || uris.length === 0) return;
                targetPath = uris[0].fsPath;
            }
            await redactSecrets(targetPath);
        })
    );

    // Register chat participant
    chatParticipant.register(context);

    // Register diagnostics
    context.subscriptions.push(diagnosticsProvider);

    // Auto-load binlogs from settings (written by Structured Log Viewer or workspace change)
    // Check both workspace and global settings
    const config = vscode.workspace.getConfiguration('binlogAnalyzer');
    const savedBinlogs = config.get<string[]>('activeBinlogs', []);
    if (savedBinlogs.length > 0) {
        setTimeout(() => {
            if (!openedViaUri) {
                handleBinlogOpen(savedBinlogs, context);
            }
            // Clear stale settings so they don't persist across restarts
            config.update('activeBinlogs', undefined, vscode.ConfigurationTarget.Workspace).then(
                () => {},
                () => {}
            );
            config.update('activeBinlogs', undefined, vscode.ConfigurationTarget.Global).then(
                () => {},
                () => {}
            );
        }, 1500);
    }
}

async function handleBinlogOpen(binlogPaths: string[], context: vscode.ExtensionContext) {
    allBinlogPaths = [...binlogPaths];
    currentBinlogPath = binlogPaths[0];
    chatParticipant?.setBinlogPaths(binlogPaths);
    treeDataProvider?.setLoading(true);
    treeDataProvider?.setBinlogPaths(binlogPaths);
    updateStatusBar();

    // Reveal the Binlog Explorer sidebar immediately so user sees loading state
    vscode.commands.executeCommand('binlogExplorer.focus');

    const config = vscode.workspace.getConfiguration('binlogAnalyzer');
    const autoLoad = config.get<boolean>('autoLoad', true);

    const fileName = getFileName(binlogPaths[0]);
    const multi = binlogPaths.length > 1 ? ` (+${binlogPaths.length - 1} more)` : '';

    // Configure MCP server for Copilot Chat (fast — just writes config)
    await configureMcpServer(allBinlogPaths, config);
    await writeCopilotInstructions(allBinlogPaths);

    // Start the private MCP client for tree view in the background (non-blocking)
    // This way Copilot Chat is usable immediately while the tree loads
    startMcpClientForTree(allBinlogPaths).then(() => {
        treeDataProvider?.setLoading(false);
    }).catch(() => {
        treeDataProvider?.setLoading(false);
    });

    // Load diagnostics to Problems panel in the background
    if (autoLoad && diagnosticsProvider) {
        diagnosticsProvider.loadFromBinlog(binlogPaths[0], config).catch(() => {});
    }
    vscode.commands.executeCommand(
        'workbench.action.chat.open',
        `@binlog Binlog "${fileName}"${multi} is loaded. What would you like to analyze?`
    );

    // Check if binlog likely came from a different machine
    const crossMachineHint = detectCrossMachineBinlog(binlogPaths[0]);

    if (crossMachineHint) {
        const action = await vscode.window.showWarningMessage(
            `⚠️ This binlog appears to be from a different machine. ` +
            `Open your local project folder so Copilot can navigate source files.`,
            'Open Project Folder',
            'Dismiss'
        );
        if (action === 'Open Project Folder') {
            vscode.commands.executeCommand('binlog.openProjectFolder');
        }
    }

    const isFirstUse = !context.globalState.get<boolean>('binlog.hasSeenWelcome');
    if (isFirstUse) {
        context.globalState.update('binlog.hasSeenWelcome', true);
        showGettingStarted();
    }
}

/**
 * Detects if a binlog likely came from a different machine by checking
 * whether the binlog's parent directory matches the current workspace.
 */
function detectCrossMachineBinlog(binlogPath: string): boolean {
    const fs = require('fs');
    const path = require('path');

    // Check if the binlog file itself exists locally
    if (!fs.existsSync(binlogPath)) {
        return true; // Path doesn't exist locally — definitely cross-machine
    }

    // If no workspace is open, hint to open one
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return true;
    }

    // Check if the binlog is within the current workspace
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const binlogDir = path.dirname(binlogPath);

    // If binlog dir is a parent/child/sibling of workspace, it's likely the right machine
    const normalizedBinlog = binlogDir.toLowerCase();
    const normalizedWorkspace = workspaceRoot.toLowerCase();

    if (normalizedBinlog.startsWith(normalizedWorkspace) || normalizedWorkspace.startsWith(normalizedBinlog)) {
        return false;
    }

    // Different drive or unrelated path — might be from another machine
    // but file exists, so we give a soft hint only if the workspace looks unrelated
    return true;
}

async function addBinlogs(newPaths: string[]) {
    // Deduplicate
    const existing = new Set(allBinlogPaths.map(p => p.toLowerCase()));
    const added: string[] = [];
    for (const p of newPaths) {
        if (!existing.has(p.toLowerCase())) {
            allBinlogPaths.push(p);
            existing.add(p.toLowerCase());
            added.push(p);
        }
    }

    if (added.length === 0) {
        vscode.window.showInformationMessage('All selected binlogs are already loaded.');
        return;
    }

    if (!currentBinlogPath) {
        currentBinlogPath = allBinlogPaths[0];
    }

    chatParticipant?.setBinlogPaths(allBinlogPaths);
    treeDataProvider?.setBinlogPaths(allBinlogPaths);
    updateStatusBar();

    // Reconfigure MCP server with all paths
    const config = vscode.workspace.getConfiguration('binlogAnalyzer');
    await configureMcpServer(allBinlogPaths, config);

    const names = added.map(getFileName).join(', ');
    vscode.window.showInformationMessage(
        `📎 Added ${added.length} binlog(s): ${names}. Total: ${allBinlogPaths.length} loaded.\n` +
        `MCP server reconfigured. Restart Copilot Chat to pick up new binlogs.`
    );
}

async function removeBinlogs(toRemove: Set<string | undefined>) {
    allBinlogPaths = allBinlogPaths.filter(p => !toRemove.has(p));

    if (allBinlogPaths.length === 0) {
        currentBinlogPath = undefined;
    } else {
        currentBinlogPath = allBinlogPaths[0];
    }

    chatParticipant?.setBinlogPaths(allBinlogPaths);
    treeDataProvider?.setBinlogPaths(allBinlogPaths);
    updateStatusBar();

    if (allBinlogPaths.length > 0) {
        const config = vscode.workspace.getConfiguration('binlogAnalyzer');
        await configureMcpServer(allBinlogPaths, config);
    }

    vscode.window.showInformationMessage(
        `Removed ${toRemove.size} binlog(s). ${allBinlogPaths.length} remaining.`
    );
}

function updateStatusBar() {
    if (!statusBarItem) return;

    if (allBinlogPaths.length === 0) {
        statusBarItem.hide();
        return;
    }

    const count = allBinlogPaths.length;
    statusBarItem.text = `$(file-binary) ${count} binlog${count > 1 ? 's' : ''}`;
    statusBarItem.tooltip = new vscode.MarkdownString(
        `**Loaded Binlogs (${count})**\n\n` +
        allBinlogPaths.map((p, i) => `${i === 0 ? '🔹' : '📎'} \`${getFileName(p)}\`  \n_${p}_`).join('\n\n') +
        `\n\n---\nClick to manage binlogs`
    );
    statusBarItem.show();
}

function showGettingStarted() {
    const panel = vscode.window.createOutputChannel('Binlog Analyzer');
    panel.appendLine('═══════════════════════════════════════════');
    panel.appendLine('  MSBuild Binlog Analyzer — Getting Started');
    panel.appendLine('═══════════════════════════════════════════');
    panel.appendLine('');
    panel.appendLine('Your binlog is loaded and the MCP server is configured.');
    panel.appendLine('Here\'s how to use it:');
    panel.appendLine('');
    panel.appendLine('1. COPILOT CHAT (@binlog)');
    panel.appendLine('   Open Copilot Chat and type @binlog followed by your question:');
    panel.appendLine('   • @binlog why did the build fail?');
    panel.appendLine('   • @binlog what are the slowest targets?');
    panel.appendLine('   • @binlog /errors    — show all build errors');
    panel.appendLine('   • @binlog /timeline  — analyze build performance');
    panel.appendLine('   • @binlog /targets   — inspect MSBuild targets');
    panel.appendLine('   • @binlog /summary   — comprehensive build summary');
    panel.appendLine('   • @binlog /secrets   — scan for leaked credentials');
    panel.appendLine('');
    panel.appendLine('2. BUILD ANALYSIS MODE');
    panel.appendLine('   Switch to "Build Analysis" mode in the Copilot Chat mode picker');
    panel.appendLine('   for a pre-configured investigation experience.');
    panel.appendLine('');
    panel.appendLine('3. PROBLEMS PANEL');
    panel.appendLine('   Build errors/warnings appear in the Problems panel (Ctrl+Shift+M).');
    panel.appendLine('   Click any error to navigate to the source file and line.');
    panel.appendLine('');
    panel.appendLine('4. COMMANDS (Ctrl+Shift+P)');
    panel.appendLine('   • Binlog: Load File       — open a different binlog');
    panel.appendLine('   • Binlog: Scan for Secrets — detect leaked credentials');
    panel.appendLine('   • Binlog: Redact Secrets   — create a redacted copy');
    panel.appendLine('   • Binlog: Show Errors      — focus the Problems panel');
    panel.appendLine('');
    panel.appendLine('5. MULTIPLE BINLOGS');
    panel.appendLine('   • Use 📎 in the Structured Log Viewer to attach extra binlogs');
    panel.appendLine('     before clicking "Open in VS Code".');
    panel.appendLine('   • Inside VS Code: Ctrl+Shift+P → "Binlog: Add File" to add more.');
    panel.appendLine('   • Click the status bar item (bottom-left) to manage loaded binlogs.');
    panel.appendLine('   • All binlogs are passed to the MCP server for cross-build comparison.');
    panel.appendLine('');
    panel.appendLine('6. CROSS-MACHINE BINLOGS');
    panel.appendLine('   Binlogs often come from CI/CD or other machines. The source paths');
    panel.appendLine('   inside won\'t match your local filesystem. To navigate source files:');
    panel.appendLine('   • Use "Binlog: Open Project Folder" (Ctrl+Shift+P) to point VS Code');
    panel.appendLine('     at your local checkout of the same repository.');
    panel.appendLine('   • Copilot can still analyze the binlog even without matching local paths.');
    panel.appendLine('');
    panel.appendLine('═══════════════════════════════════════════');
    panel.show();
}

/**
 * Writes .github/copilot-instructions.md in the workspace so that
 * Copilot Chat knows the binlog paths and never calls load_binlog.
 */
async function writeCopilotInstructions(binlogPaths: string[]) {
    const fs = require('fs');
    const pathMod = require('path');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) { return; }

    const githubDir = pathMod.join(workspaceFolder, '.github');
    const instructionsPath = pathMod.join(githubDir, 'copilot-instructions.md');

    const pathsList = binlogPaths.map(p => `- \`${p}\``).join('\n');
    const primaryPath = binlogPaths[0];

    const content = `# Binlog Analyzer Instructions

## Loaded Binlogs
${pathsList}

## CRITICAL Rules for MCP Tool Calls
- Call \`load_binlog\` with \`path\` set to \`${primaryPath}\` ONLY ONCE at the start of the conversation. If you already called load_binlog earlier in this conversation, do NOT call it again — the data persists.
- All analysis tools require \`binlog_file\` parameter — always use the full absolute path: \`${primaryPath}\`
- **NEVER use relative filenames** — always use the full path above
- Available analysis tools: \`get_diagnostics\`, \`list_projects\`, \`get_expensive_targets\`, \`get_expensive_tasks\`, \`get_expensive_projects\`, \`search_binlog\`, \`get_project_build_time\`, \`search_targets_by_name\`, \`search_tasks_by_name\`
`;

    try {
        if (!fs.existsSync(githubDir)) {
            fs.mkdirSync(githubDir, { recursive: true });
        }
        fs.writeFileSync(instructionsPath, content, 'utf8');
    } catch {
        // Non-fatal
    }
}

/**
 * Starts a private MCP client subprocess for populating the tree view.
 * This is separate from the VS Code MCP integration used by Copilot Chat.
 */
async function startMcpClientForTree(binlogPaths: string[]) {
    // Dispose previous client
    if (mcpClient) {
        mcpClient.dispose();
        mcpClient = undefined;
        treeDataProvider?.setMcpClient(null);
        binlogDocProvider?.setMcpClient(null);
    }

    const toolExe = findBinlogMcpTool();
    if (!toolExe) {
        // Tree will show without content sections
        return;
    }

    try {
        const client = new McpClient(toolExe, binlogPaths);
        await client.start();
        mcpClient = client;
        treeDataProvider?.setMcpClient(client);
        binlogDocProvider?.setMcpClient(client);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to start MCP client for tree view:', msg);
    }
}

async function configureMcpServer(binlogPaths: string[], config: vscode.WorkspaceConfiguration) {
    const customPath = config.get<string>('mcpServerPath', '');

    // Build args with all binlog paths
    const binlogArgs = binlogPaths.flatMap(p => ['--binlog', p]);

    let serverConfig: Record<string, unknown>;
    let toolExePath: string | null = null;

    if (customPath) {
        serverConfig = {
            type: 'stdio',
            command: customPath,
            args: binlogArgs
        };
    } else {
        // Auto-detect the global dotnet tool executable
        toolExePath = findBinlogMcpTool();

        if (!toolExePath) {
            // Auto-install the dotnet tool
            toolExePath = await installBinlogMcpTool();
        }

        if (toolExePath) {
            serverConfig = {
                type: 'stdio',
                command: toolExePath,
                args: binlogArgs
            };
        } else {
            // Last resort
            serverConfig = {
                type: 'stdio',
                command: 'dotnet',
                args: ['tool', 'run', 'binlog.mcp', '--', ...binlogArgs]
            };
            vscode.window.showWarningMessage(
                'Could not find or install binlog.mcp. Install it manually: `dotnet tool install -g baronfel.binlog.mcp`',
                'Copy Command'
            ).then(sel => {
                if (sel === 'Copy Command') {
                    vscode.env.clipboard.writeText('dotnet tool install -g baronfel.binlog.mcp');
                }
            });
        }
    }

    // Write to workspace settings
    const mcpConfig = vscode.workspace.getConfiguration('mcp');
    const servers = mcpConfig.get<Record<string, unknown>>('servers', {});
    servers['baronfel_binlog_mcp'] = serverConfig;

    try {
        await mcpConfig.update('servers', servers, vscode.ConfigurationTarget.Workspace);
    } catch {
        await mcpConfig.update('servers', servers, vscode.ConfigurationTarget.Global);
    }

    // Also update user-level mcp.json if it exists (VS Code reads from both)
    await updateUserMcpJson(serverConfig);
}

/**
 * Updates the user-level mcp.json (~/.config/Code/User/mcp.json or %APPDATA%/Code/User/mcp.json)
 * to fix any broken binlog-mcp entries and add our properly configured one.
 */
async function updateUserMcpJson(serverConfig: Record<string, unknown>) {
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    // VS Code user mcp.json location
    const isWindows = process.platform === 'win32';
    const mcpJsonPath = isWindows
        ? path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json')
        : path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');

    try {
        let mcpData: { servers?: Record<string, unknown> } = { servers: {} };

        if (fs.existsSync(mcpJsonPath)) {
            const content = fs.readFileSync(mcpJsonPath, 'utf8');
            mcpData = JSON.parse(content);
        }

        if (!mcpData.servers) {
            mcpData.servers = {};
        }

        // Remove any broken bare-command binlog-mcp entries
        if (mcpData.servers['binlog-mcp']) {
            const existing = mcpData.servers['binlog-mcp'] as Record<string, unknown>;
            if (existing.command === 'binlog.mcp') {
                delete mcpData.servers['binlog-mcp'];
            }
        }

        // Write our properly configured entry
        mcpData.servers['baronfel_binlog_mcp'] = serverConfig;

        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData, null, 2), 'utf8');
    } catch {
        // Non-fatal
    }
}

async function installBinlogMcpTool(): Promise<string | null> {
    const cp = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing binlog MCP server (dotnet tool)...' },
        () => new Promise<string | null>((resolve) => {
            cp.exec('dotnet tool install -g baronfel.binlog.mcp', { timeout: 60000 }, (err: Error | null, stdout: string, stderr: string) => {
                if (err) {
                    // Maybe already installed — try update
                    cp.exec('dotnet tool update -g baronfel.binlog.mcp', { timeout: 60000 }, (err2: Error | null) => {
                        // Check if exe exists now regardless of exit code
                        const exe = findBinlogMcpTool();
                        resolve(exe);
                    });
                } else {
                    const exe = findBinlogMcpTool();
                    if (exe) {
                        vscode.window.showInformationMessage('✅ binlog.mcp MCP server installed successfully.');
                    }
                    resolve(exe);
                }
            });
        })
    );

    return result;
}

function findBinlogMcpTool(): string | null {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    const homeDir = os.homedir();
    const isWindows = process.platform === 'win32';
    const exeName = isWindows ? 'binlog.mcp.exe' : 'binlog.mcp';

    // Global dotnet tools are installed in ~/.dotnet/tools/
    const globalToolPath = path.join(homeDir, '.dotnet', 'tools', exeName);
    if (fs.existsSync(globalToolPath)) {
        return globalToolPath;
    }

    // Also check PATH
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        const candidate = path.join(dir, exeName);
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // ignore permission errors
        }
    }

    return null;
}

function getFileName(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
}

async function scanForSecrets(binlogPath: string) {
    // Use the BinlogTool CLI to scan for secrets.
    // The StructuredLogger.Utils SecretsSearch scans the binlog's StringTable
    // for common secrets, explicit secrets, and usernames.
    const { exec } = require('child_process');
    const path = require('path');

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning binlog for secrets...' },
        () => new Promise<void>((resolve) => {
            // Use the MCP server's search capability via $secret keyword
            // For now, show guidance to use Copilot Chat with the MCP tools
            vscode.window.showInformationMessage(
                'To scan for secrets, ask Copilot Chat: "@binlog /secrets" or search "$secret" in the Structured Log Viewer.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
            resolve();
        })
    );
}

async function redactSecrets(binlogPath: string) {
    const config = vscode.workspace.getConfiguration('binlogAnalyzer');
    const autodetectCommon = config.get<boolean>('redaction.autodetectCommonPatterns', true);
    const autodetectUsername = config.get<boolean>('redaction.autodetectUsername', true);
    const processEmbedded = config.get<boolean>('redaction.processEmbeddedFiles', true);

    // Ask for additional tokens to redact
    const extraTokens = await vscode.window.showInputBox({
        prompt: 'Enter additional secrets to redact (comma-separated), or leave empty for auto-detection only',
        placeHolder: 'my-api-key, secret-token, ...',
    });

    if (extraTokens === undefined) return; // Cancelled

    // Ask for output path
    const inputFileName = getFileName(binlogPath);
    const defaultOutput = binlogPath.replace(/\.binlog$/i, '.redacted.binlog');

    const outputUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultOutput),
        filters: { 'Binary Logs': ['binlog'] },
        title: 'Save redacted binlog as'
    });

    if (!outputUri) return;

    // Build the BinlogTool redact command
    const args = ['tool', 'run', 'binlogtool', '--', 'redact'];
    args.push('--input', binlogPath);
    args.push('--output', outputUri.fsPath);

    if (!processEmbedded) {
        args.push('--skip-embedded-files');
    }

    if (extraTokens.trim()) {
        for (const token of extraTokens.split(',').map(t => t.trim()).filter(Boolean)) {
            args.push('--token', token);
        }
    }

    if (!autodetectCommon) {
        args.push('--no-autodetect-common');
    }
    if (!autodetectUsername) {
        args.push('--no-autodetect-username');
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Redacting secrets from binlog...', cancellable: false },
        () => new Promise<void>((resolve, reject) => {
            const cp = require('child_process');
            const proc = cp.spawn('dotnet', args, { shell: true });

            let stderr = '';
            proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

            proc.on('close', (code: number) => {
                if (code === 0) {
                    vscode.window.showInformationMessage(
                        `Secrets redacted successfully: ${getFileName(outputUri.fsPath)}`,
                        'Open Redacted'
                    ).then(selection => {
                        if (selection === 'Open Redacted') {
                            handleBinlogOpen([outputUri.fsPath], {} as vscode.ExtensionContext);
                        }
                    });
                    resolve();
                } else {
                    vscode.window.showErrorMessage(
                        `Redaction failed (exit code ${code}). Make sure 'binlogtool' is installed: dotnet tool install -g BinlogTool\n\n${stderr}`
                    );
                    reject(new Error(stderr));
                }
            });

            proc.on('error', (err: Error) => {
                vscode.window.showErrorMessage(
                    `Failed to run redaction. Make sure 'dotnet' is in PATH.\n\n${err.message}`
                );
                reject(err);
            });
        })
    );
}

export function deactivate() {
    diagnosticsProvider?.dispose();
    mcpClient?.dispose();
}
