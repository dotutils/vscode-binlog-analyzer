import * as vscode from 'vscode';
import { BinlogDiagnosticsProvider } from './diagnostics';
import { BinlogChatParticipant } from './chatParticipant';
import { BinlogTreeDataProvider, BinlogTreeItem, AboutInfo } from './binlogTreeView';
import { McpClient, buildMcpArgs } from './mcpClient';
import { BinlogDocumentProvider, BINLOG_SCHEME, openBinlogDocument } from './binlogDocumentProvider';
import { downloadCiBinlog, setCiContext } from './ciIntegration';
import {
    initBuildCheckDiagnostics, runBuildCheck, pushBuildCheckToProblemsPanel,
    formatBuildCheckForChat, detectSdkVersion, buildWithPropertyTracking,
    BuildCheckSummary
} from './buildCheck';
import * as telemetry from './telemetry';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let diagnosticsProvider: BinlogDiagnosticsProvider | undefined;
let chatParticipant: BinlogChatParticipant | undefined;
let treeDataProvider: BinlogTreeDataProvider | undefined;
let binlogTreeView: vscode.TreeView<BinlogTreeItem> | undefined;
let mcpClient: McpClient | undefined;
let binlogDocProvider: BinlogDocumentProvider | undefined;
let currentBinlogPath: string | undefined;
let allBinlogPaths: string[] = [];
let statusBarItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let openedViaUri = false;
let optimizeInProgress = false;
let cachedInsightsExePath: string | null | undefined; // undefined = not searched yet
let codeLensRegistered = false;

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Returns a globalState key scoped to the current workspace folder, or a fallback for no-workspace. */
function binlogStateKey(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    return ws ? `binlog.loadedPaths:${ws}` : 'binlog.loadedPaths:__noworkspace__';
}

export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    telemetry.initTelemetry(context);
    telemetry.trackActivation();
    setCiContext(context);

    // Set updating context immediately so the welcome view never flickers to "No binlog loaded"
    const hasPendingUpdate = !!context.globalState.get<boolean>('binlog.pendingToolUpdate');
    if (hasPendingUpdate) {
        vscode.commands.executeCommand('setContext', 'binlog.updatingMcp', true);
    }

    // Check if we have saved binlogs to restore — set flag before tree view is created
    const savedBinlogState = context.globalState.get<string[]>(binlogStateKey(), []);
    const hasBinlogsToRestore = !hasPendingUpdate && savedBinlogState.length > 0;

    // Apply any pending tool update BEFORE MCP servers start
    await applyPendingToolUpdate();

    diagnosticsProvider = new BinlogDiagnosticsProvider();
    chatParticipant = new BinlogChatParticipant();

    // Virtual document provider for binlog content in editor
    binlogDocProvider = new BinlogDocumentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(BINLOG_SCHEME, binlogDocProvider)
    );

    // Binlog Explorer tree view in sidebar
    treeDataProvider = new BinlogTreeDataProvider();
    if (hasBinlogsToRestore) {
        treeDataProvider.setRestoring(true);
    }
    const treeView = vscode.window.createTreeView('binlogExplorer', {
        treeDataProvider,
        showCollapseAll: true
    });
    binlogTreeView = treeView;
    context.subscriptions.push(treeView);

    // Track tree item clicks
    context.subscriptions.push(
        treeView.onDidChangeSelection(e => {
            if (e.selection.length > 0) {
                const item = e.selection[0];
                telemetry.trackTreeClick(item.nodeKind || 'unknown');
            }
        })
    );

    // Status bar item showing loaded binlog count
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'binlog.manageBinlogs';
    context.subscriptions.push(statusBarItem);

    // Custom editor for .binlog files — opens the file and triggers the analysis flow
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'binlog-analyzer.binlogViewer',
            new BinlogEditorProvider(context),
            { supportsMultipleEditorsPerDocument: false }
        )
    );

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
            telemetry.trackCommand('loadFile');
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
            telemetry.trackCommand('addFile');
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

    // Command: Download Binlog from CI — fetch from Azure DevOps or GitHub Actions
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.downloadFromCi', async () => {
            telemetry.trackCommand('downloadFromCi');
            const binlogFiles = await downloadCiBinlog();
            if (binlogFiles && binlogFiles.length > 0) {
                // Ask user whether to load or add to existing
                if (allBinlogPaths.length > 0) {
                    const action = await vscode.window.showQuickPick([
                        { label: '$(add) Add to current session', value: 'add' },
                        { label: '$(replace-all) Replace current binlogs', value: 'replace' },
                    ], { placeHolder: 'How to load the CI binlog?' });
                    if (!action) { return; }
                    if (action.value === 'add') {
                        await addBinlogs(binlogFiles);
                    } else {
                        await handleBinlogOpen(binlogFiles, context);
                    }
                } else {
                    await handleBinlogOpen(binlogFiles, context);
                }
            }
        })
    );

    // Command: Remove Binlog — remove a binlog from the session
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.removeFile', async (treeItem?: any) => {
            telemetry.trackCommand('removeFile');
            // If called from tree item inline button, remove that specific binlog
            if (treeItem && treeItem.tooltip) {
                const path = String(treeItem.tooltip).split('\n')[0];
                if (path && allBinlogPaths.includes(path)) {
                    await removeBinlogs(new Set([path]));
                    return;
                }
            }

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
            telemetry.trackCommand('manageBinlogs');
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
            telemetry.trackCommand('openProjectFolder');
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: 'Open the local project folder corresponding to this binlog'
            });

            if (uris && uris.length > 0) {
                const folderUri = uris[0];
                await vscode.commands.executeCommand('vscode.openFolder', folderUri, false);
            }
        })
    );

    // Command: Show Build Summary — opens binlog content in editor
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.showBuildSummary', async () => {
            telemetry.trackCommand('showBuildSummary');
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
            telemetry.trackCommand('openInEditor');
            await openBinlogDocument(section, label);
        })
    );

    // Command: Open project details in editor
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.openProjectDetails', async (_projectId: string, projectFile: string, _targets: unknown) => {
            telemetry.trackCommand('openProjectDetails');
            const projectName = projectFile.split(/[/\\]/).pop() || projectFile;
            const section = `/project/${encodeURIComponent(projectName)}`;
            await openBinlogDocument(section, projectFile);
        })
    );

    // Command: Reload Binlog — re-reads the binlog from disk (like F5 in Structured Log Viewer)
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.refreshTree', async () => {
            telemetry.trackCommand('refreshTree');
            if (allBinlogPaths.length > 0 && extensionContext) {
                await handleBinlogOpen(allBinlogPaths, extensionContext, false);
                vscode.window.setStatusBarMessage('$(check) Binlog reloaded', 3000);
            } else {
                treeDataProvider?.refresh();
            }
        })
    );

    // Command: Set Workspace Folder — pick from binlog project paths or browse
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.setWorkspaceFolder', async () => {
            telemetry.trackCommand('setWorkspaceFolder');
            telemetry.trackWorkspaceChange();
            try {
                // Try to find candidate folders from binlog project paths
                const candidates = treeDataProvider?.getProjectRootCandidates() || [];
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

                // Open the folder — this reloads the window but binlog paths
                // are persisted in globalState and will auto-load on re-activation
                const folders = vscode.workspace.workspaceFolders || [];
                const alreadyOnly = folders.length === 1 &&
                    folders[0].uri.fsPath.toLowerCase() === folderUri.fsPath.toLowerCase();
                if (!alreadyOnly) {
                    // Pre-save binlog paths under the NEW workspace key so they survive the reload
                    const targetKey = `binlog.loadedPaths:${folderUri.toString()}`;
                    context.globalState.update(targetKey, allBinlogPaths);
                    // Also write to activeBinlogs Global setting — the auto-load on
                    // activation (line ~944) reads this and opens the binlog automatically
                    const cfg = vscode.workspace.getConfiguration('binlogAnalyzer');
                    await cfg.update('activeBinlogs', [...allBinlogPaths], vscode.ConfigurationTarget.Global);
                    await vscode.commands.executeCommand('vscode.openFolder', folderUri, false);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set workspace folder: ${err?.message || err}`);
            }
        })
    );

    // Command: Fix All Issues — launches Copilot agent to fix all build errors/warnings
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.fixAllIssues', async () => {
            telemetry.trackCommand('fixAllIssues');
            if (!currentBinlogPath) {
                vscode.window.showWarningMessage('No binlog loaded.');
                return;
            }

            // Get concrete diagnostics from the tree cache
            const diag = treeDataProvider?.getDiagnosticsSummary();
            if (!diag || (diag.errorCount === 0 && diag.warningCount === 0)) {
                vscode.window.showInformationMessage('No errors or warnings to fix.');
                return;
            }

            // Get project files for build command reconstruction
            const projectFiles = treeDataProvider?.getProjectFiles() || [];
            const binlogPath = currentBinlogPath.replace(/\\/g, '/');

            // Infer the build command from binlog + project info
            // Try to find a solution file or the root project
            const slnFiles = projectFiles.filter(f => /\.sln$/i.test(f));
            const buildTarget = slnFiles.length > 0
                ? slnFiles[0].replace(/\\/g, '/')
                : (projectFiles.length === 1 ? projectFiles[0].replace(/\\/g, '/') : '');

            const buildCmd = buildTarget
                ? `dotnet build "${buildTarget}" -bl:"${binlogPath}"`
                : `dotnet build -bl:"${binlogPath}"`;

            // Build a detailed prompt with actual issues for agent mode
            const issueLines: string[] = [];
            if (diag.errors.length > 0) {
                issueLines.push('**ERRORS:**');
                issueLines.push(...diag.errors.slice(0, 50));
            }
            if (diag.warnings.length > 0) {
                issueLines.push('**WARNINGS:**');
                issueLines.push(...diag.warnings.slice(0, 50));
            }

            const prompt =
                `Fix the following ${diag.errorCount} errors and ${diag.warningCount} warnings from the MSBuild binary log.\n\n` +
                issueLines.join('\n') + '\n\n' +
                `BUILD COMMAND: \`${buildCmd}\`\n` +
                `BINLOG PATH: \`${binlogPath}\`\n\n` +
                `INSTRUCTIONS — FIX-BUILD-VERIFY LOOP:\n` +
                `You MUST follow this iterative cycle until the build is clean:\n\n` +
                `**STEP 1 — FIX:** For each issue listed above:\n` +
                `  - Open the source file and apply the fix\n` +
                `  - If an issue CANNOT be fixed (e.g. external dependency, SDK limitation, third-party code),\n` +
                `    suppress it with a pragma/NoWarn and add a comment: // Suppressed: <reason>\n\n` +
                `**STEP 2 — REBUILD:** Run the build command in the terminal:\n` +
                `  \`${buildCmd}\`\n` +
                `  This will regenerate the binlog at the same path.\n\n` +
                `**STEP 3 — VERIFY:** Check the build output for remaining errors/warnings.\n` +
                `  - If the build output still shows errors or warnings, go back to STEP 1 and fix them.\n` +
                `  - Repeat this cycle (max 5 iterations) until the build succeeds with 0 errors and 0 warnings.\n` +
                `  - If after 5 iterations issues remain, list the unfixable ones with reasons.\n\n` +
                `**STEP 4 — SUMMARY:** When done, provide:\n` +
                `  - List of all files changed and what was fixed\n` +
                `  - List of suppressed warnings with justification\n` +
                `  - Final build result (pass/fail, remaining issues if any)`;

            // Open in agent mode (not @binlog — agent mode can edit files and run terminal)
            vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prompt,
                isPartialQuery: false,
            });
        })
    );

    // Command: Show Errors
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.showErrors', async () => {
            telemetry.trackCommand('showErrors');
            if (!currentBinlogPath) {
                vscode.window.showWarningMessage('No binlog loaded. Use "Binlog: Load File" first.');
                return;
            }
            // Focus the Problems panel
            vscode.commands.executeCommand('workbench.actions.view.problems');
        })
    );

    // Command: Open in Structured Log Viewer (reverse bridge)
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.openInStructuredLogViewer', async (treeItem?: any) => {
            telemetry.trackCommand('openInStructuredLogViewer');
            let targetPath = currentBinlogPath;
            if (treeItem?.tooltip) {
                const tip = String(treeItem.tooltip).split('\n')[0];
                if (tip && tip.endsWith('.binlog')) { targetPath = tip; }
            }
            if (!targetPath) {
                vscode.window.showWarningMessage('No binlog loaded.');
                return;
            }
            // Launch with OS default app (Structured Log Viewer registers .binlog)
            const { execFile } = require('child_process');
            execFile('cmd', ['/c', 'start', '', targetPath], { shell: false }, (err: Error | null) => {
                if (err) {
                    // No app registered for .binlog — offer to reveal in Explorer or install SLV
                    vscode.window.showWarningMessage(
                        'No application is registered for .binlog files. Install MSBuild Structured Log Viewer to open binlogs.',
                        'Download Viewer',
                        'Reveal in Explorer'
                    ).then(choice => {
                        if (choice === 'Download Viewer') {
                            vscode.env.openExternal(vscode.Uri.parse('https://msbuildlog.com/'));
                        } else if (choice === 'Reveal in Explorer') {
                            execFile('explorer', ['/select,', targetPath], { shell: false });
                        }
                    });
                }
            });
        })
    );

    // Command: Show Build Timeline (webview)
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.showTimeline', async () => {
            telemetry.trackCommand('showTimeline');
            if (!mcpClient) {
                vscode.window.showWarningMessage('MCP client not ready. Wait for binlog to finish loading.');
                return;
            }
            await showTimelineWebview(context);
        })
    );

    // Command: Compare Build Timelines (webview with two binlogs side-by-side)
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.compareTimelines', async () => {
            telemetry.trackCommand('compareTimelines');
            if (!mcpClient) {
                vscode.window.showWarningMessage('MCP client not ready. Wait for binlog to finish loading.');
                return;
            }
            if (allBinlogPaths.length < 2) {
                vscode.window.showWarningMessage('Two binlogs required for comparison. Use "Binlog: Add File" to load a second one.');
                return;
            }
            await showComparisonTimelineWebview(context);
        })
    );

    // Command: Optimize Build — apply perf recommendations, rebuild, compare
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.optimizeBuild', async () => {
            telemetry.trackCommand('optimizeBuild');
            if (!currentBinlogPath) {
                vscode.window.showWarningMessage('No binlog loaded.');
                return;
            }
            if (!mcpClient) {
                vscode.window.showWarningMessage('MCP client not ready. Wait for binlog to finish loading.');
                return;
            }
            await optimizeBuildFlow(context);
        })
    );

    // Command: Build & Collect Binlog
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.buildAndCollect', async () => {
            telemetry.trackCommand('buildAndCollect');
            const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsFolder) {
                vscode.window.showWarningMessage('No workspace folder open. Open a project folder first.');
                return;
            }

            // Look for .sln or .csproj to build
            const slnFiles = await vscode.workspace.findFiles('*.sln', null, 5);
            const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', '**/node_modules/**', 20);

            let buildTarget: string | undefined;
            if (slnFiles.length === 1) {
                buildTarget = slnFiles[0].fsPath;
            } else if (slnFiles.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    slnFiles.map(f => ({ label: getFileName(f.fsPath), detail: f.fsPath, uri: f })),
                    { placeHolder: 'Select a solution to build' }
                );
                if (!picked) { return; }
                buildTarget = picked.uri.fsPath;
            } else if (csprojFiles.length === 1) {
                buildTarget = csprojFiles[0].fsPath;
            } else if (csprojFiles.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    csprojFiles.map(f => ({ label: getFileName(f.fsPath), detail: f.fsPath, uri: f })),
                    { placeHolder: 'Select a project to build' }
                );
                if (!picked) { return; }
                buildTarget = picked.uri.fsPath;
            }

            const binlogName = await vscode.window.showInputBox({
                prompt: 'Binlog file name',
                value: 'msbuild.binlog',
                valueSelection: [0, 7], // select "msbuild" part for easy renaming
            });
            if (!binlogName) { return; }
            const safeName = binlogName.endsWith('.binlog') ? binlogName : `${binlogName}.binlog`;

            const skipRestore = await vscode.window.showQuickPick(
                [
                    { label: 'Build with Restore (default)', value: false, description: 'Runs NuGet restore before building' },
                    { label: 'Build without Restore', value: true, description: 'Skips restore — produces a cleaner binlog focused on compilation' },
                ],
                { placeHolder: 'Skip NuGet restore? (Restore adds noise to the binlog; skip it if packages are already restored)' },
            );
            if (!skipRestore) { return; }

            // Enhanced diagnostics options
            interface DiagnosticOption extends vscode.QuickPickItem {
                flag?: string;
                envVar?: { key: string; value: string };
                blOption?: string;
            }
            const diagnosticOptions: DiagnosticOption[] = [
                {
                    label: '$(symbol-property) Property Tracking',
                    description: 'MsBuildLogPropertyTracking=15',
                    detail: 'Records full property lifecycle: initial value assignments, every reassignment with old→new values and source location, environment variable reads, and uninitialized property reads. Essential for answering "why is this property set to X?" questions.',
                    picked: false,
                    envVar: { key: 'MsBuildLogPropertyTracking', value: '15' },
                },
                {
                    label: '$(checklist) BuildCheck Analysis',
                    description: 'dotnet build -check',
                    detail: 'Runs MSBuild BuildCheck rules during the build (SDK 9.0.100+). Detects: BC0102 double writes (two tasks writing same file), BC0101 shared output paths, BC0201 undefined property usage, BC0202 property used before declared, BC0104 Reference instead of ProjectReference, and more.',
                    picked: false,
                    flag: '-check',
                },
                {
                    label: '$(pulse) Analyzer Performance',
                    description: '/p:ReportAnalyzer=true',
                    detail: 'Reports per-analyzer and per-source-generator execution time in the binlog. Shows exactly which Roslyn analyzers are slow and how much time each one adds to compilation. Useful when Csc/CoreCompile is a bottleneck.',
                    picked: false,
                    flag: '/p:ReportAnalyzer=true',
                },
                {
                    label: '$(file-code) Embed Project Imports',
                    description: 'ProjectImports=Embed',
                    detail: 'Embeds all .csproj, .props, and .targets file contents into the binlog. This is the default for dotnet build -bl, but explicitly setting it ensures the binlog contains source files for property provenance tracing and the Preprocess view.',
                    picked: false,
                    blOption: 'ProjectImports=Embed',
                },
            ];

            const selectedDiagnostics = await vscode.window.showQuickPick(diagnosticOptions, {
                placeHolder: 'Enhanced diagnostics (optional — press OK to skip)',
                canPickMany: true,
                title: 'Select Enhanced Diagnostics',
            });
            // selectedDiagnostics is undefined if user presses Escape; [] if they press OK with nothing selected
            if (selectedDiagnostics === undefined) { return; }

            if (selectedDiagnostics.length > 0) {
                telemetry.trackEnhancedDiagnostics(selectedDiagnostics.map(d =>
                    (typeof d.label === 'string' ? d.label : '').replace(/\$\([^)]+\)\s*/g, '').trim()
                ));
            }

            const binlogPath = path.join(wsFolder, safeName);
            const buildArg = buildTarget ? `"${buildTarget}"` : '';
            const noRestoreFlag = skipRestore.value ? ' --no-restore' : '';

            // Collect extra flags from selected diagnostics
            const extraFlags: string[] = [];
            const envVars: Record<string, string> = {};
            let blOptions = '';
            for (const opt of selectedDiagnostics) {
                if (opt.flag) { extraFlags.push(opt.flag); }
                if (opt.envVar) { envVars[opt.envVar.key] = opt.envVar.value; }
                if (opt.blOption) { blOptions = opt.blOption; }
            }

            const blArg = blOptions
                ? `/bl:"${binlogPath};${blOptions}"`
                : `/bl:"${binlogPath}"`;
            const extraStr = extraFlags.length > 0 ? ' ' + extraFlags.join(' ') : '';
            const cmd = `dotnet build ${buildArg}${noRestoreFlag}${extraStr} ${blArg}`;

            const terminalOptions: vscode.TerminalOptions = {
                name: 'Build & Collect Binlog',
                cwd: wsFolder,
            };
            if (Object.keys(envVars).length > 0) {
                terminalOptions.env = envVars;
            }
            const terminal = vscode.window.createTerminal(terminalOptions);
            terminal.show();
            terminal.sendText(cmd);

            // Wait for the terminal/build to finish, then auto-load the binlog
            let loaded = false;
            const startTime = Date.now();
            let lastSize = -1;
            let stableCount = 0;
            const STABLE_NEEDED = 2; // 2 consecutive same-size readings (4s stable)
            const pollInterval = setInterval(() => {
                if (Date.now() - startTime > 600000) { clearInterval(pollInterval); return; }
                try {
                    const stat = fs.statSync(binlogPath);
                    if (stat.size > 0 && stat.size === lastSize) {
                        stableCount++;
                        if (stableCount >= STABLE_NEEDED) {
                            clearInterval(pollInterval);
                            disposable.dispose();
                            if (loaded) { return; }
                            loaded = true;
                            handleBinlogOpen([binlogPath], context);
                        }
                    } else {
                        lastSize = stat.size;
                        stableCount = 0;
                    }
                } catch { /* file doesn't exist yet */ }
            }, 2000);
            const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
                if (closedTerminal === terminal) {
                    disposable.dispose();
                    clearInterval(pollInterval);
                    setTimeout(() => {
                        if (loaded) { return; }
                        loaded = true;
                        if (fs.existsSync(binlogPath)) {
                            handleBinlogOpen([binlogPath], context);
                        } else {
                            vscode.window.showWarningMessage(`Binlog not found at ${binlogPath}. The build may have failed.`);
                        }
                    }, 500);
                }
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.copyItem', async (treeItem?: BinlogTreeItem) => {
            telemetry.trackCommand('copyItem');
            // Context menu passes treeItem; keybinding doesn't — fall back to selection
            const item = treeItem || binlogTreeView?.selection?.[0];
            if (!item) { return; }
            const text = item.fullText
                || (typeof item.tooltip === 'string' ? item.tooltip : '')
                || (typeof item.label === 'string' ? item.label : '');
            if (text) {
                await vscode.env.clipboard.writeText(text);
                vscode.window.setStatusBarMessage('$(clippy) Copied to clipboard', 2000);
            }
        }),
        vscode.commands.registerCommand('binlog.copyAllErrors', async () => {
            telemetry.trackCommand('copyAllErrors');
            const items = treeDataProvider?.getCachedDiagnostics('error') || [];
            if (items.length === 0) {
                vscode.window.showInformationMessage('No errors to copy.');
                return;
            }
            const text = items.map(d => d.fullText || d.label).join('\n');
            await vscode.env.clipboard.writeText(text as string);
            vscode.window.setStatusBarMessage(`$(clippy) Copied ${items.length} errors`, 2000);
        }),
        vscode.commands.registerCommand('binlog.copyAllWarnings', async () => {
            telemetry.trackCommand('copyAllWarnings');
            const items = treeDataProvider?.getCachedDiagnostics('warning') || [];
            if (items.length === 0) {
                vscode.window.showInformationMessage('No warnings to copy.');
                return;
            }
            const text = items.map(d => d.fullText || d.label).join('\n');
            await vscode.env.clipboard.writeText(text as string);
            vscode.window.setStatusBarMessage(`$(clippy) Copied ${items.length} warnings`, 2000);
        })
    );

    // Command: Analyze in Chat — opens @binlog chat with context-specific prompt
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.analyzeInChat', async (nameOrItem?: string | BinlogTreeItem, detail?: string, count?: number, category?: string) => {
            telemetry.trackCommand('analyzeInChat');
            let name: string | undefined;

            // Context menu passes the TreeItem as first arg
            if (nameOrItem && typeof nameOrItem === 'object' && 'nodeKind' in nameOrItem) {
                const item = nameOrItem as BinlogTreeItem;
                name = typeof item.label === 'string' ? item.label : (item.label as any)?.label || '';
                detail = typeof item.description === 'string' ? item.description : '';
                category = item.nodeKind;
            } else if (typeof nameOrItem === 'string') {
                name = nameOrItem;
            }

            // Fallback to selected tree item
            if (!name) {
                const selected = binlogTreeView?.selection?.[0];
                if (selected) {
                    name = typeof selected.label === 'string' ? selected.label : (selected.label as any)?.label || '';
                    detail = typeof selected.description === 'string' ? selected.description : '';
                    category = selected.nodeKind;
                }
            }
            if (!name) { return; }
            telemetry.trackAnalyzeInChat(category || 'unknown');

            // Build a context-specific prompt based on what was clicked
            let prompt: string;
            const itemCtx = `"${name}" (${detail || ''}${count && count > 1 ? `, ×${count}` : ''})`;
            const binlogPath = currentBinlogPath ? ` The binlog_file is "${currentBinlogPath}".` : '';

            if (category === 'perf-item' && name.toLowerCase().includes('analyzer')) {
                prompt = `@binlog The Roslyn analyzer ${itemCtx} is consuming build time. ` +
                    `What diagnostics does it produce? Is it worth keeping? ` +
                    `Show how to disable it conditionally (e.g. only in CI) or replace it with a lighter alternative.${binlogPath}`;
            } else if (category === 'perf-item' || category === 'target') {
                // These are MSBuild TARGETS from the performance timeline
                const isKnown = /^(ResolveAssemblyReferences|CoreCompile|Csc|Copy|RAR|Restore|ResolvePackageAssets|GenerateNuspec)/i.test(name);
                if (isKnown) {
                    prompt = `@binlog The MSBuild target ${itemCtx} is a known build bottleneck. ` +
                        `First use binlog_expensive_targets to confirm its timing, then explain what specific MSBuild properties ` +
                        `can reduce its time. Show the exact XML to add to Directory.Build.props and any trade-offs.${binlogPath}`;
                } else {
                    prompt = `@binlog Investigate the MSBuild target ${itemCtx}. ` +
                        `Use binlog_search_targets to find where it runs and which projects invoke it. ` +
                        `Is it running too many times? Can it be skipped with proper Inputs/Outputs?${binlogPath}`;
                }
            } else if (category === 'task') {
                prompt = `@binlog Investigate the MSBuild task ${itemCtx}. ` +
                    `Use binlog_search_tasks to find it, then binlog_task_details for its parameters and output. ` +
                    `What does it do and can it be optimized?${binlogPath}`;
            } else if (category === 'property-item') {
                prompt = `@binlog Explain the MSBuild property ${name} = "${detail}". ` +
                    `What does it control? Is this value typical? ` +
                    `What happens if I change it?${binlogPath}`;
            } else if (category === 'item-entry') {
                prompt = `@binlog Explain the MSBuild item ${itemCtx}. ` +
                    `Which project references it? Is it needed? ` +
                    `Are there any version conflicts or redundancies?${binlogPath}`;
            } else if (category === 'project') {
                prompt = `@binlog Analyze the project ${itemCtx}. ` +
                    `Use binlog_project_targets to show target breakdown and timing. ` +
                    `What are its slowest targets? Does it have unnecessary dependencies?${binlogPath}`;
            } else {
                prompt = `@binlog Analyze the MSBuild target ${itemCtx}. ` +
                    `Use binlog_search_targets to find where it runs and binlog_expensive_targets for timing. ` +
                    `What does it do and how does it affect the build?${binlogPath}`;
            }

            vscode.commands.executeCommand('workbench.action.chat.open', prompt);
        })
    );

    // Command: Search Build Events — search across binlog and show in tree
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.searchBinlog', async () => {
            telemetry.trackCommand('searchBinlog');
            if (!mcpClient) {
                vscode.window.showWarningMessage('No binlog loaded. Use "Binlog: Load File" first.');
                return;
            }

            const query = await vscode.window.showInputBox({
                prompt: 'Search across all build events (targets, tasks, messages, properties)',
                placeHolder: 'e.g. "PackageReference", "error CS", "ResolveAssembly"',
                title: 'Search Binlog',
            });

            if (!query) { return; }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Searching binlog for "${query}"...` },
                async () => {
                    try {
                        const result = await mcpClient!.callTool('binlog_search', {
                            query: query.trim(),
                            limit: 200,
                        });

                        let results: any[] = [];
                        try {
                            const data = JSON.parse(result.text);
                            results = Array.isArray(data) ? data : [];
                        } catch {
                            results = [];
                        }

                        if (results.length === 0) {
                            vscode.window.showInformationMessage(`No results found for "${query}".`);
                            return;
                        }

                        treeDataProvider?.setSearchResults(query, results, results.length >= 200);
                        vscode.commands.executeCommand('binlogExplorer.focus');
                        if (results.length >= 200) {
                            vscode.window.showInformationMessage(`Found ${results.length}+ results for "${query}". Click "Load all results..." to fetch everything.`);
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Search failed: ${msg}`);
                    }
                }
            );
        })
    );

    // Command: Clear Search Results
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.clearSearch', () => {
            treeDataProvider?.clearSearchResults();
        })
    );

    // Command: Load All Search Results (paginate beyond initial 200)
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.searchLoadAll', async () => {
            if (!mcpClient || !treeDataProvider) { return; }
            const query = treeDataProvider.getSearchQuery();
            if (!query) { return; }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Loading all results for "${query}"...` },
                async () => {
                    const allResults: any[] = [];
                    let offset = 0;
                    const pageSize = 500;
                    const maxTotal = 10000;
                    while (offset < maxTotal) {
                        const result = await mcpClient!.callTool('binlog_search', {
                            query: query.trim(),
                            limit: pageSize,
                            offset,
                        });
                        let page: any[] = [];
                        try {
                            const data = JSON.parse(result.text);
                            page = Array.isArray(data) ? data : [];
                        } catch { break; }
                        allResults.push(...page);
                        if (page.length < pageSize) { break; }
                        offset += pageSize;
                    }
                    treeDataProvider!.setSearchResults(query, allResults, false);
                    vscode.commands.executeCommand('binlogExplorer.focus');
                }
            );
        })
    );

    // Command: Export as Text Log — generate text log at various verbosity levels
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.exportTextLog', async () => {
            telemetry.trackCommand('exportTextLog');
            if (!mcpClient || !currentBinlogPath) {
                vscode.window.showWarningMessage('No binlog loaded. Use "Binlog: Load File" first.');
                return;
            }

            const verbosity = await vscode.window.showQuickPick(
                [
                    { label: 'Minimal', description: 'Errors and warnings only', value: 'minimal' },
                    { label: 'Normal', description: 'Errors, warnings, and key build information', value: 'normal' },
                    { label: 'Detailed', description: 'Comprehensive log with targets and tasks', value: 'detailed' },
                    { label: 'Diagnostic', description: 'Full verbose output — everything', value: 'diagnostic' },
                ],
                {
                    placeHolder: 'Select log verbosity level',
                    title: 'Export Binlog as Text Log',
                }
            );
            if (!verbosity) { return; }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Generating ${verbosity.label} text log...` },
                async () => {
                    try {
                        const sections: string[] = [];
                        const binlogName = getFileName(currentBinlogPath || '');
                        sections.push(`MSBuild Text Log — ${binlogName}`);
                        sections.push(`Verbosity: ${verbosity.label}`);
                        sections.push(`Generated: ${new Date().toISOString()}`);
                        sections.push('═'.repeat(60));
                        sections.push('');

                        // Always include overview
                        try {
                            const overview = await mcpClient!.callTool('binlog_overview', {});
                            sections.push('BUILD OVERVIEW');
                            sections.push('─'.repeat(40));
                            sections.push(overview.text);
                            sections.push('');
                        } catch { /* non-fatal */ }

                        // Always include errors
                        try {
                            const errors = await mcpClient!.callTool('binlog_errors', {});
                            sections.push('ERRORS');
                            sections.push('─'.repeat(40));
                            sections.push(errors.text || 'None');
                            sections.push('');
                        } catch { /* non-fatal */ }

                        // Always include warnings
                        try {
                            const warnings = await mcpClient!.callTool('binlog_warnings', {});
                            sections.push('WARNINGS');
                            sections.push('─'.repeat(40));
                            sections.push(warnings.text || 'None');
                            sections.push('');
                        } catch { /* non-fatal */ }

                        if (verbosity.value !== 'minimal') {
                            // Normal+: include projects and properties
                            try {
                                const projects = await mcpClient!.callTool('binlog_projects', {});
                                sections.push('PROJECTS');
                                sections.push('─'.repeat(40));
                                sections.push(projects.text);
                                sections.push('');
                            } catch { /* non-fatal */ }

                            try {
                                const props = await mcpClient!.callTool('binlog_properties', {});
                                sections.push('PROPERTIES');
                                sections.push('─'.repeat(40));
                                sections.push(props.text);
                                sections.push('');
                            } catch { /* non-fatal */ }
                        }

                        if (verbosity.value === 'detailed' || verbosity.value === 'diagnostic') {
                            // Detailed+: include targets and tasks
                            try {
                                const targets = await mcpClient!.callTool('binlog_expensive_targets', { top_number: 30 });
                                sections.push('TARGETS (by duration)');
                                sections.push('─'.repeat(40));
                                sections.push(targets.text);
                                sections.push('');
                            } catch { /* non-fatal */ }

                            try {
                                const tasks = await mcpClient!.callTool('binlog_expensive_tasks', { top_number: 30 });
                                sections.push('TASKS (by duration)');
                                sections.push('─'.repeat(40));
                                sections.push(tasks.text);
                                sections.push('');
                            } catch { /* non-fatal */ }

                            try {
                                const itemTypes = await mcpClient!.callTool('binlog_item_types', {});
                                sections.push('ITEM TYPES');
                                sections.push('─'.repeat(40));
                                sections.push(itemTypes.text);
                                sections.push('');
                            } catch { /* non-fatal */ }
                        }

                        if (verbosity.value === 'diagnostic') {
                            // Diagnostic: include imports, NuGet, compiler, analyzers
                            try {
                                const imports = await mcpClient!.callTool('binlog_imports', {});
                                sections.push('IMPORTS');
                                sections.push('─'.repeat(40));
                                sections.push(imports.text);
                                sections.push('');
                            } catch { /* non-fatal */ }

                            try {
                                const nuget = await mcpClient!.callTool('binlog_nuget', {});
                                sections.push('NUGET');
                                sections.push('─'.repeat(40));
                                sections.push(nuget.text);
                                sections.push('');
                            } catch { /* non-fatal */ }

                            try {
                                const analyzers = await mcpClient!.callTool('binlog_expensive_analyzers', { limit: 20 });
                                sections.push('ANALYZERS (by duration)');
                                sections.push('─'.repeat(40));
                                sections.push(analyzers.text);
                                sections.push('');
                            } catch { /* non-fatal */ }

                            try {
                                const compiler = await mcpClient!.callTool('binlog_compiler', {});
                                sections.push('COMPILER COMMAND LINE');
                                sections.push('─'.repeat(40));
                                sections.push(compiler.text);
                                sections.push('');
                            } catch { /* non-fatal */ }
                        }

                        const content = sections.join('\n');

                        // Offer to save or open as untitled
                        const action = await vscode.window.showQuickPick(
                            [
                                { label: 'Open in Editor', description: 'View the text log in a new tab', value: 'editor' },
                                { label: 'Save to File', description: 'Save as .log file next to the binlog', value: 'save' },
                            ],
                            { placeHolder: 'What to do with the generated log?' }
                        );

                        if (action?.value === 'save') {
                            const logPath = currentBinlogPath!.replace(/\.binlog$/, `.${verbosity.value}.log`);
                            fs.writeFileSync(logPath, content, 'utf8');
                            const doc = await vscode.workspace.openTextDocument(logPath);
                            await vscode.window.showTextDocument(doc, { preview: true });
                            vscode.window.showInformationMessage(`Text log saved to ${getFileName(logPath)}`);
                        } else {
                            const doc = await vscode.workspace.openTextDocument({
                                content,
                                language: 'log',
                            });
                            await vscode.window.showTextDocument(doc, { preview: true });
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Export failed: ${msg}`);
                    }
                }
            );
        })
    );

    // Command: Run BuildCheck Analysis — replay binlog with /check
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.runBuildCheck', async () => {
            telemetry.trackCommand('runBuildCheck');
            if (allBinlogPaths.length === 0) {
                vscode.window.showWarningMessage('No binlog loaded. Load a binlog first.');
                return;
            }

            const { supported, sdkVersion } = await detectSdkVersion();
            if (!supported) {
                const msg = sdkVersion === 'unknown'
                    ? 'Could not detect .NET SDK. Make sure `dotnet` is in your PATH.'
                    : `BuildCheck requires .NET SDK 9.0.100+. Your version: ${sdkVersion}`;
                const action = await vscode.window.showWarningMessage(msg, 'Rebuild with -check');
                if (action === 'Rebuild with -check') {
                    vscode.commands.executeCommand('binlog.buildAndCollect');
                }
                return;
            }

            // Pick binlog if multiple
            let binlogPath = allBinlogPaths[0];
            if (allBinlogPaths.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    allBinlogPaths.map(p => ({ label: path.basename(p), detail: p })),
                    { placeHolder: 'Select binlog to analyze with BuildCheck' }
                );
                if (!picked) { return; }
                binlogPath = picked.detail;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Running BuildCheck analysis...', cancellable: false },
                async () => {
                    const summary = await runBuildCheck(binlogPath);
                    const collection = initBuildCheckDiagnostics();
                    pushBuildCheckToProblemsPanel(summary, collection);

                    telemetry.trackBuildCheck(summary.results.length, summary.sdkVersion, summary.durationMs);

                    if (summary.results.length === 0) {
                        vscode.window.showInformationMessage(
                            `✅ BuildCheck passed — no issues found. (SDK ${summary.sdkVersion}, ${summary.durationMs}ms)`
                        );
                    } else {
                        const errorCount = summary.results.filter(r => r.severity === 'error').length;
                        const warnCount = summary.results.filter(r => r.severity === 'warning').length;
                        const suggCount = summary.results.filter(r => r.severity === 'suggestion').length;
                        const parts: string[] = [];
                        if (errorCount > 0) { parts.push(`${errorCount} error(s)`); }
                        if (warnCount > 0) { parts.push(`${warnCount} warning(s)`); }
                        if (suggCount > 0) { parts.push(`${suggCount} suggestion(s)`); }
                        const action = await vscode.window.showWarningMessage(
                            `BuildCheck found ${parts.join(', ')}. Results in Problems panel.`,
                            'Show Problems'
                        );
                        if (action === 'Show Problems') {
                            vscode.commands.executeCommand('workbench.actions.view.problems');
                        }
                    }
                }
            );
        })
    );

    // Command: Rebuild with Property Tracking
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.rebuildWithPropertyTracking', async () => {
            telemetry.trackCommand('rebuildWithPropertyTracking');
            const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsFolder) {
                vscode.window.showWarningMessage('No workspace folder open. Open a project folder first.');
                return;
            }

            const config = vscode.workspace.getConfiguration('binlogAnalyzer');
            const trackingLevel = config.get<number>('diagnostics.propertyTrackingLevel', 15);

            // Find build target
            const slnFiles = await vscode.workspace.findFiles('*.sln', null, 5);
            const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', '**/node_modules/**', 20);

            let buildTarget: string | undefined;
            if (slnFiles.length === 1) {
                buildTarget = slnFiles[0].fsPath;
            } else if (slnFiles.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    slnFiles.map(f => ({ label: getFileName(f.fsPath), detail: f.fsPath, uri: f })),
                    { placeHolder: 'Select a solution to build' }
                );
                if (!picked) { return; }
                buildTarget = picked.uri.fsPath;
            } else if (csprojFiles.length === 1) {
                buildTarget = csprojFiles[0].fsPath;
            } else if (csprojFiles.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    csprojFiles.map(f => ({ label: getFileName(f.fsPath), detail: f.fsPath, uri: f })),
                    { placeHolder: 'Select a project to build' }
                );
                if (!picked) { return; }
                buildTarget = picked.uri.fsPath;
            }

            const binlogPath = await buildWithPropertyTracking(
                wsFolder, buildTarget, 'build-tracked.binlog', trackingLevel
            );

            vscode.window.showInformationMessage(
                `Building with MsBuildLogPropertyTracking=${trackingLevel}. ` +
                `The binlog will auto-load when the build completes.`
            );

            // Poll for binlog completion, reuse the same stabilization logic
            let lastSize = -1;
            let stableCount = 0;
            const STABLE_NEEDED = 3;
            const startTime = Date.now();
            const pollInterval = setInterval(() => {
                if (Date.now() - startTime > 600000) { clearInterval(pollInterval); return; }
                try {
                    const stat = fs.statSync(binlogPath);
                    if (stat.size > 0 && stat.size === lastSize) {
                        stableCount++;
                        if (stableCount >= STABLE_NEEDED) {
                            clearInterval(pollInterval);
                            handleBinlogOpen([binlogPath], context);
                        }
                    } else {
                        stableCount = 0;
                        lastSize = stat.size;
                    }
                } catch {
                    // File doesn't exist yet
                }
            }, 5000);
        })
    );

    // About / update commands
    context.subscriptions.push(
        vscode.commands.registerCommand('binlog.checkForUpdates', async () => {
            telemetry.trackCommand('checkForUpdates');
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Checking for MCP updates...' },
                () => fetchAboutInfo('interactive')
            );
        }),
        vscode.commands.registerCommand('binlog.updateMcpServer', async () => {
            telemetry.trackCommand('updateMcpServer');
            await updateMcpServer();
        }),
        vscode.commands.registerCommand('binlog.refreshMcpInfo', async () => {
            telemetry.trackCommand('refreshMcpInfo');
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Refreshing MCP info...' },
                () => fetchAboutInfo('silent')
            );
        })
    );

    // Fetch about info on activation — show update popup if available
    fetchAboutInfo('auto').catch(() => {});

    // Register chat participant
    chatParticipant.register(context);

    // Register diagnostics
    context.subscriptions.push(diagnosticsProvider);

    // Register CodeLens for .csproj files
    registerCodeLensProvider(context);

    // Auto-load binlogs from activeBinlogs setting (written by Structured Log Viewer)
    const config = vscode.workspace.getConfiguration('binlogAnalyzer');
    const savedBinlogs = config.get<string[]>('activeBinlogs', []);

    // Migration: clear old un-keyed globalState to prevent cross-workspace bleed
    if (context.globalState.get<string[]>('binlog.loadedPaths')) {
        context.globalState.update('binlog.loadedPaths', undefined);
    }

    if (savedBinlogs.length > 0) {
        // Clear activeBinlogs immediately after reading to prevent stale loads in other projects
        config.update('activeBinlogs', undefined, vscode.ConfigurationTarget.Workspace).then(() => {}, () => {});
        config.update('activeBinlogs', undefined, vscode.ConfigurationTarget.Global).then(() => {}, () => {});

        // Verify files still exist
        const validBinlogs = savedBinlogs.filter((p: string) => {
            try { return fs.existsSync(p); } catch { return false; }
        });
        if (validBinlogs.length > 0) {
            // Short delay to let URI handler claim priority if both fire
            setTimeout(() => {
                if (!openedViaUri) {
                    handleBinlogOpen(validBinlogs, context, true);
                }
            }, 500);
        }
    }

    // Auto-restore binlogs from previous session (globalState) if nothing else loaded them
    if (savedBinlogs.length === 0 && !openedViaUri) {
        const restored = context.globalState.get<string[]>(binlogStateKey(), []);
        const validRestored = restored.filter(p => {
            try { return fs.existsSync(p); } catch { return false; }
        });
        if (validRestored.length > 0) {
            // Restoring flag was already set on the tree provider at the top of activate()
            // Short delay to let URI handler claim priority
            setTimeout(() => {
                if (!openedViaUri && allBinlogPaths.length === 0) {
                    handleBinlogOpen(validRestored, context, false);
                } else {
                    treeDataProvider?.setRestoring(false);
                }
            }, 500);
        } else {
            // Saved paths no longer exist on disk — clear restoring indicator
            treeDataProvider?.setRestoring(false);
            if (hasPendingUpdate) {
                vscode.commands.executeCommand('setContext', 'binlog.updatingMcp', false);
            }
        }
    }

    // Listen for workspace folder changes — re-apply MCP config and refresh UI
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            if (allBinlogPaths.length > 0) {
                const cfg = vscode.workspace.getConfiguration('binlogAnalyzer');
                await configureMcpServer(allBinlogPaths, cfg);
                await cleanupBinlogInstructions();
                // Refresh tree so workspace label updates
                treeDataProvider?.fireChanged();
                // Re-focus the Binlog Explorer so it's visible after workspace change
                vscode.commands.executeCommand('binlogExplorer.focus');
            }
        })
    );
}

async function handleBinlogOpen(binlogPaths: string[], context: vscode.ExtensionContext, interactive: boolean = true) {
    // Clear any loading/updating states now that binlogs are loading
    vscode.commands.executeCommand('setContext', 'binlog.updatingMcp', false);
    treeDataProvider?.setRestoring(false);
    telemetry.trackBinlogLoad(binlogPaths.length, openedViaUri ? 'uri' : 'file');
    allBinlogPaths = [...binlogPaths];
    currentBinlogPath = binlogPaths[0];
    // Persist binlog paths in globalState keyed by workspace URI (survives workspace changes)
    context.globalState.update(binlogStateKey(), allBinlogPaths);
    chatParticipant?.setBinlogPaths(binlogPaths);
    treeDataProvider?.setLoading(true);
    treeDataProvider?.setBinlogPaths(binlogPaths);
    updateStatusBar();

    // Subscribe to tree's diagnostics data to populate Problems panel (zero extra MCP calls)
    if (treeDataProvider && diagnosticsProvider) {
        const sub = treeDataProvider.onDiagnosticsRaw((data) => {
            const config = vscode.workspace.getConfiguration('binlogAnalyzer');
            diagnosticsProvider!.loadFromRawData(data, config);
            updateStatusBar();
            sub.dispose();
        });
    }

    // Reveal the Binlog Explorer sidebar immediately so user sees loading state
    if (interactive) {
        vscode.commands.executeCommand('binlogExplorer.focus');
    }

    const config = vscode.workspace.getConfiguration('binlogAnalyzer');
    const autoLoad = config.get<boolean>('autoLoad', true);

    const fileName = getFileName(binlogPaths[0]);
    const multi = binlogPaths.length > 1 ? ` (+${binlogPaths.length - 1} more)` : '';

    // Configure MCP server for Copilot Chat and start tree client in parallel
    // cleanupBinlogInstructions is fire-and-forget (non-critical cleanup of old files)
    cleanupBinlogInstructions().catch(() => {});

    // Start MCP config and tree client concurrently — configureMcpServer writes settings
    // for Copilot Chat while startMcpClientForTree spawns the private MCP subprocess
    const mcpConfigPromise = configureMcpServer(allBinlogPaths, config);
    const treeClientPromise = startMcpClientForTree(allBinlogPaths).then(() => {
        treeDataProvider?.setLoading(false);
        updateStatusBar(); // Switch from spinning to final state

        // Auto-run BuildCheck if setting is enabled
        const diagConfig = vscode.workspace.getConfiguration('binlogAnalyzer');
        if (diagConfig.get<boolean>('diagnostics.autoRunBuildCheck', false)) {
            runBuildCheck(allBinlogPaths[0]).then(summary => {
                if (summary.results.length > 0) {
                    const collection = initBuildCheckDiagnostics();
                    pushBuildCheckToProblemsPanel(summary, collection);
                    const count = summary.results.length;
                    vscode.window.showInformationMessage(
                        `BuildCheck found ${count} issue(s). Results in Problems panel.`,
                        'Show Problems'
                    ).then(action => {
                        if (action === 'Show Problems') {
                            vscode.commands.executeCommand('workbench.actions.view.problems');
                        }
                    });
                }
            }).catch(() => {});
        }
    }).catch((err) => {
        treeDataProvider?.setLoading(false);
        updateStatusBar();
        telemetry.trackMcpError('startMcpClient', String(err));
    });

    // Wait for MCP config (needed before Copilot Chat works) but don't block forever
    await Promise.race([
        mcpConfigPromise,
        new Promise(resolve => setTimeout(resolve, 10000)),
    ]);

    // Only open chat and steal focus when user explicitly loaded a binlog
    if (interactive) {
        const chatMessage = `@binlog Binlog "${fileName}"${multi} is loaded. What would you like to analyze?`;
        setTimeout(() => {
            // Use chat.new to avoid reusing a previous chat session with stale tool-call history
            vscode.commands.executeCommand('workbench.action.chat.new', chatMessage)
                .then(undefined, () => {
                    // Fallback: older VS Code versions may not support chat.new
                    vscode.commands.executeCommand('workbench.action.chat.open', chatMessage);
                });
        }, 1500);
    }

    // If workspace doesn't match binlog location, suggest updating it
    if (interactive) {
        const binlogDir = path.dirname(binlogPaths[0]);
        const folders = vscode.workspace.workspaceFolders || [];
        const currentWs = folders[0]?.uri.fsPath?.toLowerCase();
        const normalizedBinlogDir = binlogDir.toLowerCase();

        const wsMatchesBinlog = currentWs &&
            (normalizedBinlogDir.startsWith(currentWs) || currentWs.startsWith(normalizedBinlogDir));

        if (!wsMatchesBinlog) {
            const binlogName = getFileName(binlogPaths[0]);
            const action = await vscode.window.showWarningMessage(
                `"${binlogName}" appears to be from a different project than the current workspace. ` +
                `Update workspace folder so Copilot can navigate source files.`,
                'Set Workspace Folder',
                'Dismiss'
            );
            if (action === 'Set Workspace Folder') {
                vscode.commands.executeCommand('binlog.setWorkspaceFolder');
            }
        }

        const isFirstUse = !context.globalState.get<boolean>('binlog.hasSeenWelcome');
        if (isFirstUse) {
            context.globalState.update('binlog.hasSeenWelcome', true);
            showGettingStarted();
        }
    }
}

/**
 * Detects if a binlog likely came from a different machine by checking
 * whether the binlog's parent directory matches the current workspace.
 */
function detectCrossMachineBinlog(binlogPath: string): boolean {
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

    // Restart the MCP client with the updated binlog paths
    startMcpClientForTree(allBinlogPaths).then(() => {
        treeDataProvider?.setLoading(false);
        updateStatusBar();
    }).catch(() => {
        treeDataProvider?.setLoading(false);
        updateStatusBar();
    });

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

    // Update persisted state
    extensionContext?.globalState.update(binlogStateKey(), allBinlogPaths);

    chatParticipant?.setBinlogPaths(allBinlogPaths);
    treeDataProvider?.setBinlogPaths(allBinlogPaths);
    updateStatusBar();

    if (allBinlogPaths.length > 0) {
        const config = vscode.workspace.getConfiguration('binlogAnalyzer');
        await configureMcpServer(allBinlogPaths, config);
    } else {
        // Dispose MCP client when all binlogs are removed
        mcpClient?.dispose();
        mcpClient = undefined;
        treeDataProvider?.setMcpClient(null);
        binlogDocProvider?.setMcpClient(null);
        chatParticipant?.setMcpClient(null);
        // Clean up MCP server config
        const config = vscode.workspace.getConfiguration('binlogAnalyzer');
        await configureMcpServer([], config);
    }

    vscode.window.showInformationMessage(
        `Removed ${toRemove.size} binlog(s). ${allBinlogPaths.length} remaining.`
    );
}

function updateStatusBar() {
    if (!statusBarItem) return;

    // Update context for menu visibility
    vscode.commands.executeCommand('setContext', 'binlog.hasLoadedBinlogs', allBinlogPaths.length > 0);
    vscode.commands.executeCommand('setContext', 'binlog.hasMultipleBinlogs', allBinlogPaths.length >= 2);

    if (allBinlogPaths.length === 0) {
        statusBarItem.hide();
        return;
    }

    const count = allBinlogPaths.length;
    const isLoading = treeDataProvider?.isLoading?.() ?? false;
    const diag = diagnosticsProvider?.getDiagnosticCounts();
    const errorCount = diag?.errorCount || 0;
    const warningCount = diag?.warningCount || 0;

    let text: string;
    if (isLoading) {
        text = `$(loading~spin) Loading ${count} binlog${count > 1 ? 's' : ''}...`;
    } else {
        text = `$(file-binary) ${count} binlog${count > 1 ? 's' : ''}`;
        if (errorCount > 0 || warningCount > 0) {
            const parts: string[] = [];
            if (errorCount > 0) { parts.push(`$(error) ${errorCount}`); }
            if (warningCount > 0) { parts.push(`$(warning) ${warningCount}`); }
            text += ` · ${parts.join(' ')}`;
        }
    }
    statusBarItem.text = text;

    statusBarItem.tooltip = new vscode.MarkdownString(
        `**Loaded Binlogs (${count})**\n\n` +
        allBinlogPaths.map((p, i) => `${i === 0 ? '🔹' : '📎'} \`${getFileName(p)}\`  \n_${p}_`).join('\n\n') +
        (errorCount > 0 || warningCount > 0
            ? `\n\n---\n❌ ${errorCount} error(s) · ⚠️ ${warningCount} warning(s)`
            : '') +
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
    panel.appendLine('   • @binlog /perf      — deep performance analysis');
    panel.appendLine('   • @binlog /targets   — inspect MSBuild targets');
    panel.appendLine('   • @binlog /summary   — comprehensive build summary');
    panel.appendLine('   • @binlog /incremental — analyze build incrementality');
    panel.appendLine('   • @binlog /secrets   — secrets guidance (use Structured Log Viewer)');
    panel.appendLine('   • @binlog /compare   — compare loaded binlogs');
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
    panel.appendLine('   • Binlog: Load File            — open a different binlog');
    panel.appendLine('   • Binlog: Build & Collect      — build a project and capture binlog');
    panel.appendLine('   • Binlog: Show Errors          — focus the Problems panel');
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
 * Cleans up any binlog-instructions.md files that were previously written by the extension.
 */
async function cleanupBinlogInstructions() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) { return; }

    const githubDir = path.join(workspaceFolder, '.github');
    for (const filename of ['binlog-instructions.md', 'copilot-instructions.md']) {
        const filePath = path.join(githubDir, filename);
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                if (content.startsWith('# Binlog Analyzer Instructions')) {
                    fs.unlinkSync(filePath);
                }
            }
        } catch { /* Non-fatal */ }
    }
}

/**
 * Starts a private MCP client subprocess for populating the tree view.
 * This is separate from the VS Code MCP integration used by Copilot Chat.
 * Automatically restarts on unexpected exit with exponential backoff.
 */
let mcpRestartAttempts = 0;
const MCP_MAX_RESTART_ATTEMPTS = 5;
const MCP_BACKOFF_BASE_MS = 1000;

async function startMcpClientForTree(binlogPaths: string[]) {
    // Dispose previous client
    if (mcpClient) {
        mcpClient.dispose();
        mcpClient = undefined;
        treeDataProvider?.setMcpClient(null);
        binlogDocProvider?.setMcpClient(null);
    }

    const config = vscode.workspace.getConfiguration('binlogAnalyzer');
    const customPath = config.get<string>('mcpServerPath', '');
    let toolExe = customPath || findBinlogInsightsTool();
    if (!toolExe) {
        // Don't block tree loading with install — configureMcpServer handles install
        return;
    }

    try {
        const argTemplate = config.get<string>('mcpServerArgs', '--binlog ${binlog}');
        const client = new McpClient(toolExe, binlogPaths, argTemplate);
        await client.start();
        mcpClient = client;
        mcpRestartAttempts = 0; // Reset on successful start
        treeDataProvider?.setMcpClient(client);
        binlogDocProvider?.setMcpClient(client);
        chatParticipant?.setMcpClient(client);

        // Auto-restart on unexpected exit
        client.on('unexpected-exit', () => {
            if (client.isDisposed) { return; }
            mcpRestartAttempts++;
            if (mcpRestartAttempts > MCP_MAX_RESTART_ATTEMPTS) {
                vscode.window.showErrorMessage(
                    `Binlog MCP server crashed ${MCP_MAX_RESTART_ATTEMPTS} times. ` +
                    `Reload the window or use "Binlog: Reload" to retry.`
                );
                treeDataProvider?.setMcpClient(null);
                binlogDocProvider?.setMcpClient(null);
                chatParticipant?.setMcpClient(null);
                updateStatusBar();
                return;
            }

            const delay = Math.min(MCP_BACKOFF_BASE_MS * Math.pow(2, mcpRestartAttempts - 1), 30000);
            vscode.window.setStatusBarMessage(
                `$(sync~spin) MCP server crashed — restarting in ${(delay / 1000).toFixed(0)}s (attempt ${mcpRestartAttempts}/${MCP_MAX_RESTART_ATTEMPTS})...`,
                delay + 5000
            );

            setTimeout(async () => {
                try {
                    await startMcpClientForTree(binlogPaths);
                    vscode.window.setStatusBarMessage('$(check) MCP server reconnected', 3000);
                    updateStatusBar();
                } catch (err) {
                    telemetry.trackMcpError('autoRestart', String(err));
                }
            }, delay);
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to start MCP client for tree view:', msg);
        telemetry.trackError('startMcpClientForTree', err);
    }
}

async function configureMcpServer(binlogPaths: string[], config: vscode.WorkspaceConfiguration) {
    const customPath = config.get<string>('mcpServerPath', '');
    const argTemplate = config.get<string>('mcpServerArgs', '--binlog ${binlog}');
    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Configure MCP server for Copilot Chat
    let insightsConfig: Record<string, unknown>;

    if (customPath) {
        insightsConfig = {
            type: 'stdio',
            command: customPath,
            args: buildMcpArgs(argTemplate, binlogPaths),
            ...(workspaceCwd && { cwd: workspaceCwd }),
        };
    } else {
        let insightsExe = findBinlogInsightsTool();
        if (!insightsExe) {
            insightsExe = await installBinlogInsightsTool();
            // After install, start the tree client (it skipped earlier because tool wasn't found)
            if (insightsExe) {
                cachedInsightsExePath = insightsExe;
                startMcpClientForTree(binlogPaths).then(() => {
                    treeDataProvider?.setLoading(false);
                    updateStatusBar();
                }).catch(() => {
                    treeDataProvider?.setLoading(false);
                    updateStatusBar();
                });
            }
        }

        const binlogArgs = buildMcpArgs(argTemplate, binlogPaths);
        if (insightsExe) {
            insightsConfig = {
                type: 'stdio',
                command: insightsExe,
                args: binlogArgs,
                ...(workspaceCwd && { cwd: workspaceCwd }),
            };
        } else {
            insightsConfig = {
                type: 'stdio',
                command: 'dotnet',
                args: ['tool', 'run', 'binlog-insights-mcp', '--', ...binlogArgs],
                ...(workspaceCwd && { cwd: workspaceCwd }),
            };
            vscode.window.showWarningMessage(
                'Could not find or install BinlogInsights.Mcp. Install it manually: `dotnet tool install -g BinlogInsights.Mcp`',
                'Copy Command'
            ).then(sel => {
                if (sel === 'Copy Command') {
                    vscode.env.clipboard.writeText('dotnet tool install -g BinlogInsights.Mcp');
                }
            });
        }
    }

    // Write to user-level mcp.json first (sync file write, never hangs)
    writeUserMcpJson(insightsConfig).catch(() => {});

    // Write to VS Code settings (can hang on cold start — don't block on it)
    try {
        const mcpConfig = vscode.workspace.getConfiguration('mcp');
        const servers = mcpConfig.get<Record<string, unknown>>('servers', {});
        for (const [key, val] of Object.entries(servers)) {
            const srv = val as Record<string, unknown>;
            if (srv.command === 'binlog.mcp' || srv.command === 'binlog-mcp') {
                delete servers[key];
            }
        }
        delete servers['baronfel_binlog_mcp'];
        servers['binlog_insights_mcp'] = insightsConfig;
        // Don't await — fire and forget to avoid hanging on cold start
        mcpConfig.update('servers', servers, vscode.ConfigurationTarget.Global).then(() => {}, () => {});
    } catch {
        // non-fatal
    }
}

/**
 * Writes our binlog_insights_mcp entry to user-level mcp.json.
 * VS Code reads MCP servers from both settings.json and mcp.json.
 */
async function writeUserMcpJson(serverConfig: Record<string, unknown>) {
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

        if (!mcpData.servers) { mcpData.servers = {}; }

        // Remove old/broken entries
        for (const key of ['binlog-mcp', 'baronfel_binlog_mcp']) {
            delete mcpData.servers[key];
        }

        mcpData.servers['binlog_insights_mcp'] = serverConfig;
        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpData, null, 2), 'utf8');
    } catch { /* non-fatal */ }
}

const NUGET_PACKAGE_ID = 'BinlogInsights.Mcp';

/** Checks whether a server config entry refers to the BinlogInsights MCP server. */
function serverMatchesBinlogInsights(s: any): boolean {
    const cmd = typeof s?.command === 'string' ? s.command : '';
    const args: string[] = Array.isArray(s?.args) ? s.args : [];
    const combined = [cmd, ...args].join(' ').toLowerCase();
    return combined.includes('binlog-insights-mcp') || combined.includes('binloginsights.mcp');
}

/** Returns paths to mcp.json files that define the binlog-insights server. */
function getMcpConfigPaths(): string[] {
    const paths: string[] = [];

    // Workspace .vscode/mcp.json
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        const wsMcp = path.join(ws, '.vscode', 'mcp.json');
        if (fs.existsSync(wsMcp)) {
            try {
                const content = JSON.parse(fs.readFileSync(wsMcp, 'utf8'));
                const servers = content.servers || {};
                if (Object.values(servers).some((s: any) => serverMatchesBinlogInsights(s))) {
                    paths.push(wsMcp);
                }
            } catch { /* ignore parse errors */ }
        }
    }

    // User-level mcp.json
    const isWindows = process.platform === 'win32';
    const userMcp = isWindows
        ? path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json')
        : path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
    if (fs.existsSync(userMcp)) {
        try {
            const content = JSON.parse(fs.readFileSync(userMcp, 'utf8'));
            const servers = content.servers || {};
            if (Object.values(servers).some((s: any) =>
                typeof s?.command === 'string' && s.command.includes('binlog'))) {
                paths.push(userMcp);
            }
        } catch { /* ignore parse errors */ }
    }

    return paths;
}

async function fetchAboutInfo(mode: 'interactive' | 'auto' | 'silent') {
    const toolPath = findBinlogInsightsTool();
    const version = toolPath ? await getInstalledMcpVersion(toolPath) : null;
    const latestVersion = await getLatestNuGetVersion();

    const updateAvailable = !!(version && latestVersion && compareVersions(latestVersion, version) > 0);

    const ext = vscode.extensions.getExtension('dotutils.binlog-analyzer');
    const extensionVersion = ext?.packageJSON?.version || '';

    // Find mcp.json config files
    const configPaths = getMcpConfigPaths();

    const info: AboutInfo = { extensionVersion, mcpVersion: version, mcpToolPath: toolPath, mcpLatestVersion: latestVersion, mcpUpdateAvailable: updateAvailable, mcpConfigPaths: configPaths };
    treeDataProvider?.setAboutInfo(info);

    if ((mode === 'interactive' || mode === 'auto') && updateAvailable) {
        const choice = await vscode.window.showInformationMessage(
            `BinlogInsights.Mcp update available: v${version} → v${latestVersion}`,
            'Update Now'
        );
        if (choice === 'Update Now') {
            await updateMcpServer();
        }
    } else if (mode === 'interactive' && !updateAvailable && version) {
        vscode.window.showInformationMessage(`BinlogInsights.Mcp v${version} is up to date.`);
    }
}

async function getInstalledMcpVersion(toolPath: string): Promise<string | null> {
    // Primary: read version from the .store directory (works for all versions, even old ones without --version)
    try {
        const storeDir = path.join(os.homedir(), '.dotnet', 'tools', '.store', 'binloginsights.mcp');
        if (fs.existsSync(storeDir)) {
            const versions = fs.readdirSync(storeDir).filter(d => /^\d+\.\d+\.\d+$/.test(d));
            if (versions.length > 0) {
                // Sort and pick the highest (there should only be one for a global tool)
                versions.sort(compareVersions);
                return versions[versions.length - 1];
            }
        }
    } catch { /* fall through */ }

    // Fallback: try --version (added in v0.3.x)
    const cp = require('child_process');
    return new Promise<string | null>((resolve) => {
        cp.execFile(toolPath, ['--version'], { timeout: 10000, encoding: 'utf8' },
            (error: any, stdout: string) => {
                if (error) { resolve(null); return; }
                const match = stdout.trim().match(/^(\d+\.\d+\.\d+)/);
                resolve(match ? match[1] : null);
            }
        );
    });
}

async function getLatestNuGetVersion(): Promise<string | null> {
    const cp = require('child_process');

    return new Promise<string | null>((resolve) => {
        // Use dotnet CLI which respects all configured NuGet sources (including local feeds)
        cp.execFile('dotnet', ['package', 'search', NUGET_PACKAGE_ID, '--exact-match', '--format', 'json'],
            { timeout: 30000, encoding: 'utf8' },
            (error: any, stdout: string) => {
                if (error) {
                    resolve(null);
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    const results: Array<{ packages: Array<{ id: string; version: string }> }> = parsed.searchResult || [];
                    // Collect all versions across all sources
                    const allVersions: string[] = [];
                    for (const source of results) {
                        for (const pkg of source.packages || []) {
                            if (pkg.id.toLowerCase() === NUGET_PACKAGE_ID.toLowerCase() && pkg.version) {
                                allVersions.push(pkg.version);
                            }
                        }
                    }
                    // Filter out prereleases and find the highest version
                    const stable = allVersions.filter(v => !v.includes('-'));
                    if (stable.length === 0) { resolve(null); return; }
                    stable.sort(compareVersions);
                    resolve(stable[stable.length - 1]);
                } catch {
                    resolve(null);
                }
            }
        );
    });
}

/** Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) { return na - nb; }
    }
    return 0;
}

async function updateMcpServer() {
    if (allBinlogPaths.length === 0) {
        // No binlog loaded — no MCP server running from our extension, try direct update
        const cp = require('child_process');
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Updating BinlogInsights MCP server...' },
            () => new Promise<{ success: boolean; output: string }>((resolve) => {
                cp.execFile('dotnet', ['tool', 'update', '-g', 'BinlogInsights.Mcp'], { timeout: 60000 }, (err: Error | null, stdout: string, stderr: string) => {
                    resolve({ success: !err, output: (stderr || stdout || '').toString() });
                });
            })
        );
        cachedInsightsExePath = undefined;
        if (result.success) {
            vscode.window.showInformationMessage('BinlogInsights MCP server updated successfully.');
            await fetchAboutInfo('silent');
        } else {
            vscode.window.showErrorMessage(`Failed to update: ${result.output.substring(0, 200)}`);
        }
        return;
    }

    // Binlog loaded — MCP server likely running, defer update to next activation
    extensionContext?.globalState.update('binlog.pendingToolUpdate', true);
    const action = await vscode.window.showInformationMessage(
        'The update will be applied on next reload (before the MCP server starts).',
        'Reload Now'
    );
    if (action === 'Reload Now') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/** Runs a pending tool update if one was scheduled. Must be called early in activate(), before any MCP server is started. */
async function applyPendingToolUpdate(): Promise<void> {
    if (!extensionContext?.globalState.get<boolean>('binlog.pendingToolUpdate')) {
        return;
    }
    // Clear the flag first so a failed update doesn't loop on every reload
    await extensionContext.globalState.update('binlog.pendingToolUpdate', undefined);

    // binlog.updatingMcp context is already set in activate() above

    const cp = require('child_process');
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Updating BinlogInsights MCP server...' },
        () => new Promise<{ success: boolean; output: string }>((resolve) => {
            cp.execFile('dotnet', ['tool', 'update', '-g', 'BinlogInsights.Mcp'], { timeout: 60000 }, (err: Error | null, stdout: string, stderr: string) => {
                resolve({ success: !err, output: (stderr || stdout || '').toString() });
            });
        })
    );

    // Don't clear binlog.updatingMcp here — the auto-restore will clear it after loading binlogs,
    // or we clear it below if there are no binlogs to restore.
    cachedInsightsExePath = undefined;
    if (result.success) {
        vscode.window.showInformationMessage('BinlogInsights MCP server updated successfully.');
    } else {
        vscode.window.showErrorMessage(`Failed to update BinlogInsights.Mcp: ${result.output.substring(0, 200)}`);
    }
}

function findBinlogInsightsTool(): string | null {
    if (cachedInsightsExePath !== undefined) { return cachedInsightsExePath; }

    const homeDir = os.homedir();
    const isWindows = process.platform === 'win32';
    const exeName = isWindows ? 'binlog-insights-mcp.exe' : 'binlog-insights-mcp';

    // Global dotnet tools are installed in ~/.dotnet/tools/
    const globalToolPath = path.join(homeDir, '.dotnet', 'tools', exeName);
    if (fs.existsSync(globalToolPath)) {
        cachedInsightsExePath = globalToolPath;
        return globalToolPath;
    }

    // Also check PATH
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        const candidate = path.join(dir, exeName);
        try {
            if (fs.existsSync(candidate)) {
                cachedInsightsExePath = candidate;
                return candidate;
            }
        } catch {
            // ignore permission errors
        }
    }

    cachedInsightsExePath = null;
    return null;
}

async function installBinlogInsightsTool(): Promise<string | null> {
    cachedInsightsExePath = undefined; // Reset cache so findBinlogInsightsTool re-scans after install
    const cp = require('child_process');
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing BinlogInsights MCP server (dotnet tool)...' },
        () => new Promise<string | null>((resolve) => {
            cp.execFile('dotnet', ['tool', 'install', '-g', 'BinlogInsights.Mcp'], { timeout: 60000 }, (err: Error | null) => {
                if (err) {
                    cp.execFile('dotnet', ['tool', 'update', '-g', 'BinlogInsights.Mcp'], { timeout: 60000 }, () => {
                        const exe = findBinlogInsightsTool();
                        telemetry.trackToolInstall(!!exe);
                        resolve(exe);
                    });
                } else {
                    const exe = findBinlogInsightsTool();
                    telemetry.trackToolInstall(!!exe);
                    if (exe) {
                        vscode.window.showInformationMessage('✅ BinlogInsights MCP server installed successfully.');
                    }
                    resolve(exe);
                }
            });
        })
    );

    return result;
}

function getFileName(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
}

export function deactivate() {
    diagnosticsProvider?.dispose();
    mcpClient?.dispose();
    codeLensProvider?.dispose();
}

/**
 * Optimize Build Flow — analyzes perf, lets user pick optimizations,
 * applies changes via Copilot, rebuilds, and compares the new binlog.
 */
async function optimizeBuildFlow(context: vscode.ExtensionContext) {
    if (!mcpClient || !currentBinlogPath) { return; }
    const baselineBinlog = currentBinlogPath;

    // Suppress rebuild notifications during the optimize flow
    optimizeInProgress = true;

    // Step 1: Get perf data from MCP
    const [targetsResult, tasksResult] = await Promise.allSettled([
        mcpClient.callTool('binlog_expensive_targets', { top_number: 10 }),
        mcpClient.callTool('binlog_expensive_tasks', { top_number: 10 }),
    ]);

    const targetsText = targetsResult.status === 'fulfilled' ? targetsResult.value.text : '';
    const tasksText = tasksResult.status === 'fulfilled' ? tasksResult.value.text : '';

    if (!targetsText && !tasksText) {
        vscode.window.showWarningMessage('Could not retrieve performance data from binlog.');
        optimizeInProgress = false;
        return;
    }

    // Step 2: Build optimization suggestions (based on MSBuild team best practices + dotnet/skills + Mayorova/Provaznik talk)
    const suggestions: vscode.QuickPickItem[] = [
        { label: '$(zap) Enable Parallel Builds', description: 'Use /maxcpucount, /graph mode, and MSBUILDUSESERVER=1', picked: true },
        { label: '$(beaker) Optimize CoreCompile', description: 'ProduceReferenceAssembly + conditionally disable analyzers (preserve CI enforcement)', picked: true },
        { label: '$(file-symlink-directory) Reduce File Copy Overhead', description: 'Enable hardlinks, UseCommonOutputDirectory, Dev Drive (ReFS) recommendation', picked: true },
        { label: '$(history) Improve Incrementality', description: 'Add Inputs/Outputs to custom targets, register FileWrites, separate computation from execution', picked: true },
        { label: '$(search) Optimize RAR (ResolveAssemblyReferences)', description: 'Reduce transitive refs, DisableTransitiveProjectReferences, trim unused PackageReferences', picked: false },
        { label: '$(package) Optimize NuGet Restore', description: 'RestoreUseStaticGraphEvaluation + RestorePackagesWithLockFile + --no-restore', picked: false },
        { label: '$(folder) Use Artifacts Output Layout', description: '--artifacts-path for centralized output (.NET 8+), reduces redundant copies', picked: false },
        { label: '$(symbol-property) Enable Build Caching', description: 'Use /graph isolation for safe caching, Deterministic=true', picked: false },
    ];

    // Step 3: Let user pick which optimizations to apply
    const selected = await vscode.window.showQuickPick(suggestions, {
        canPickMany: true,
        title: 'Select Optimizations to Apply',
        placeHolder: 'Pick the optimizations you want to apply, then Copilot will implement them',
    });

    if (!selected || selected.length === 0) { optimizeInProgress = false; return; }

    // Step 4: Choose build verification mode
    const buildModes: (vscode.QuickPickItem & { mode: string })[] = [
        { label: '$(run-all) Quick — single build after changes', description: 'Fastest: apply optimizations → rebuild once', mode: 'quick', picked: true },
        { label: '$(split-horizontal) Cold + Warm — two builds after changes', description: 'Measures both compilation and incrementality improvement', mode: 'cold-warm' },
        { label: '$(diff) Full A/B — clean+warm before, clean+warm after', description: 'Most thorough: clean cold & warm builds before AND after changes', mode: 'full-ab' },
    ];

    const modeSelection = await vscode.window.showQuickPick(buildModes, {
        title: 'Build Verification Mode',
        placeHolder: 'How many verification builds should run?',
    }) as (vscode.QuickPickItem & { mode: string }) | undefined;

    if (!modeSelection) { optimizeInProgress = false; return; }
    const buildMode = modeSelection.mode;

    // Step 5: Infer build command from the binlog
    const projectFiles = treeDataProvider?.getProjectFiles() || [];
    const slnFiles = projectFiles.filter(f => /\.sln$/i.test(f));
    const buildTarget = slnFiles.length > 0
        ? slnFiles[0] : (projectFiles.length === 1 ? projectFiles[0] : '');
    const binlogDir = path.dirname(baselineBinlog);
    const buildTarget_ = buildTarget ? `"${buildTarget}"` : '';

    // Generate unique names based on mode
    let optimizeIndex = 1;
    while (fs.existsSync(path.join(binlogDir, `optimized_${optimizeIndex}_after_cold.binlog`))
        || fs.existsSync(path.join(binlogDir, `optimized_${optimizeIndex}.binlog`))) {
        optimizeIndex++;
    }

    const afterColdPath = path.join(binlogDir, `optimized_${optimizeIndex}_after_cold.binlog`);
    const afterWarmPath = path.join(binlogDir, `optimized_${optimizeIndex}_after_warm.binlog`);
    const beforeColdPath = path.join(binlogDir, `optimized_${optimizeIndex}_before_cold.binlog`);
    const beforeWarmPath = path.join(binlogDir, `optimized_${optimizeIndex}_before_warm.binlog`);
    const quickPath = path.join(binlogDir, `optimized_${optimizeIndex}.binlog`);

    // Determine which binlog is the final one to poll for
    const optimizedBinlogPath = buildMode === 'quick' ? quickPath
        : buildMode === 'cold-warm' ? afterWarmPath : afterWarmPath;
    const optimizeStartTime = Date.now();

    // Step 6: Build the Copilot prompt based on selected mode
    const selectedLabels = selected.map(s => s.label.replace(/\$\([^)]+\)\s*/g, '') + ': ' + s.description).join('\n  - ');

    const commonAnalysis =
        `Apply these severity thresholds: RAR >5s is concerning (>15s pathological), Analyzers should be <30% of Csc time, any single target >50% of build time is a red flag.\n` +
        `  - Create or modify \`Directory.Build.props\` in the repo root for repo-wide properties\n` +
        `  - For analyzers: disable CONDITIONALLY: <RunAnalyzers Condition="'$(ContinuousIntegrationBuild)' != 'true'">false</RunAnalyzers>\n` +
        `  - For file copies: enable hardlinks with <CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>true</CreateHardLinksForCopyFilesToOutputDirectoryIfPossible>\n` +
        `  - For custom targets: add Inputs/Outputs AND register generated files in <FileWrites>. Use Returns (not Outputs) when only passing items.\n` +
        `  - Add XML comments explaining what each property does\n` +
        `  - IMPORTANT (MSBuild #13206): Targets with Inputs/Outputs generating Items via Tasks — separate computation from execution targets.\n` +
        `  - NOTE: ResolveProjectReferences total time is misleading (MSBuild #3135). Focus on task self-time.`;

    let buildSteps: string;
    let reportStep: string;
    let binlogFooter: string;
    let optimizedBinlogs: string[];

    if (buildMode === 'quick') {
        const cmd = `dotnet build ${buildTarget_} -m -bl:"${quickPath}"`.trim();
        buildSteps = `**STEP 2 — REBUILD:** Run: \`${cmd}\`\n`;
        reportStep = `  - Cold build time vs baseline\n  - Tell the user: click the 🔄 **Reload** button in the Binlog Explorer toolbar to load the new binlog`;
        binlogFooter = `BASELINE BINLOG: ${baselineBinlog}\nOPTIMIZED BINLOG (will be created): ${quickPath}`;
        optimizedBinlogs = [quickPath];
    } else if (buildMode === 'cold-warm') {
        const coldCmd = `dotnet build ${buildTarget_} -m -bl:"${afterColdPath}"`.trim();
        const warmCmd = `dotnet build ${buildTarget_} -m -bl:"${afterWarmPath}"`.trim();
        buildSteps =
            `**STEP 2 — COLD BUILD:** Run: \`${coldCmd}\`\n` +
            `  Full compilation with optimizations applied.\n\n` +
            `**STEP 3 — WARM BUILD:** Run: \`${warmCmd}\`\n` +
            `  Incremental/no-op. Should be <5s if incrementality works.\n`;
        reportStep =
            `  - Cold build time vs baseline (was it faster?)\n` +
            `  - Warm build time (should be <5s)\n` +
            `  - Targets skipped in warm vs cold\n` +
            `  - Tell the user: click the 🔄 **Reload** button in the Binlog Explorer toolbar to load the updated results`;
        binlogFooter = `BASELINE BINLOG: ${baselineBinlog}\nAFTER-COLD: ${afterColdPath}\nAFTER-WARM: ${afterWarmPath}`;
        optimizedBinlogs = [afterColdPath, afterWarmPath];
    } else {
        // full-ab: clean → cold → warm BEFORE changes, then clean → cold → warm AFTER changes
        const cleanCmd = `dotnet clean ${buildTarget_}`.trim();
        const bcCmd = `dotnet build ${buildTarget_} -m -bl:"${beforeColdPath}"`.trim();
        const bwCmd = `dotnet build ${buildTarget_} -m -bl:"${beforeWarmPath}"`.trim();
        const coldCmd = `dotnet build ${buildTarget_} -m -bl:"${afterColdPath}"`.trim();
        const warmCmd = `dotnet build ${buildTarget_} -m -bl:"${afterWarmPath}"`.trim();
        buildSteps =
            `**STEP 1 — BEFORE-CHANGES BASELINE:** Run these 3 commands to establish a clean before-baseline:\n` +
            `  \`${cleanCmd}\`\n` +
            `  \`${bcCmd}\`\n` +
            `  \`${bwCmd}\`\n` +
            `  This gives us a clean cold build AND a warm/incremental build BEFORE any changes.\n\n` +
            `**STEP 3 — AFTER-CHANGES BUILDS:** After applying optimizations, run:\n` +
            `  \`${cleanCmd}\`\n` +
            `  \`${coldCmd}\`\n` +
            `  \`${warmCmd}\`\n` +
            `  This gives us a clean cold build AND a warm build AFTER changes.\n`;
        reportStep =
            `  Produce a comparison table:\n` +
            `  | Metric | Before (cold) | Before (warm) | After (cold) | After (warm) |\n` +
            `  Show: total build time, top 3 expensive targets, targets skipped count.\n` +
            `  Highlight: cold improvement (before_cold vs after_cold) AND warm improvement (before_warm vs after_warm).\n` +
            `  Tell the user: click the 🔄 **Reload** button in the Binlog Explorer toolbar to load the updated results.`;
        binlogFooter = `BEFORE-COLD: ${beforeColdPath}\nBEFORE-WARM: ${beforeWarmPath}\nAFTER-COLD: ${afterColdPath}\nAFTER-WARM: ${afterWarmPath}`;
        optimizedBinlogs = [beforeColdPath, beforeWarmPath, afterColdPath, afterWarmPath];
    }

    const applyStep = buildMode === 'full-ab' ? 'STEP 2' : 'STEP 1';
    const reportStepNum = buildMode === 'quick' ? 'STEP 3' : buildMode === 'cold-warm' ? 'STEP 4' : 'STEP 4';

    const prompt =
        `Apply the following build performance optimizations to this project.\n\n` +
        `**SELECTED OPTIMIZATIONS:**\n  - ${selectedLabels}\n\n` +
        `**PERFORMANCE DATA (baseline cold build):**\n` +
        `Expensive targets:\n${targetsText.substring(0, 2000)}\n\n` +
        `Expensive tasks:\n${tasksText.substring(0, 2000)}\n\n` +
        `**${applyStep} — ANALYZE & APPLY:**\n${commonAnalysis}\n\n` +
        `${buildSteps}\n` +
        `**${reportStepNum} — REPORT:**\n${reportStep}\n` +
        `  Tell the user: click the 🔄 **Reload** button in the Binlog Explorer toolbar to load the updated results.\n\n` +
        `${binlogFooter}`;

    // Step 6: Auto-detect when optimized binlog is ready using polling with stabilization.
    // MSBuild creates the file at build start and writes progressively, so we need to wait
    // for the file size to stop changing for a sustained period before loading.
    // Uses optimizeStartTime to only accept files created after the flow started.

    const POLL_INTERVAL = 10_000;   // check every 10 seconds
    const STABLE_READINGS = 3;      // need 3 consecutive same-size readings (30s stable)
    let stableCount = 0;
    let lastSize = -1;
    let pollTimer: NodeJS.Timeout | undefined;

    const pollForCompletion = async () => {
        try {
            if (!fs.existsSync(optimizedBinlogPath)) {
                stableCount = 0;
                lastSize = -1;
                pollTimer = setTimeout(pollForCompletion, POLL_INTERVAL);
                return;
            }
            const stat = fs.statSync(optimizedBinlogPath);
            // Only consider files created after the optimize flow started
            if (stat.mtimeMs < optimizeStartTime) {
                pollTimer = setTimeout(pollForCompletion, POLL_INTERVAL);
                return;
            }
            if (stat.size > 0 && stat.size === lastSize) {
                stableCount++;
                if (stableCount >= STABLE_READINGS) {
                    // File has been stable for 30+ seconds — build is done
                    optimizeInProgress = false;
                    await loadOptimizedAndCompare(context, baselineBinlog, optimizedBinlogs);
                    return;
                }
            } else {
                stableCount = 0;
                lastSize = stat.size;
            }
            pollTimer = setTimeout(pollForCompletion, POLL_INTERVAL);
        } catch {
            pollTimer = setTimeout(pollForCompletion, POLL_INTERVAL);
        }
    };

    // Start polling after a 15-second initial delay (build hasn't started yet)
    pollTimer = setTimeout(pollForCompletion, 15_000);

    // Safety timeout: stop polling after 15 minutes
    setTimeout(() => {
        if (pollTimer) { clearTimeout(pollTimer); }
        if (optimizeInProgress) { optimizeInProgress = false; }
    }, 15 * 60 * 1000);

    // Step 7: Launch Copilot agent to apply changes
    vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
        isPartialQuery: false,
    });
}

async function loadOptimizedAndCompare(
    context: vscode.ExtensionContext,
    baselineBinlog: string,
    optimizedBinlogs: string[]
) {
    // Load all available binlogs: baseline + any optimized binlogs that exist
    const binlogsToLoad = [baselineBinlog];
    for (const b of optimizedBinlogs) {
        if (fs.existsSync(b)) { binlogsToLoad.push(b); }
    }

    if (binlogsToLoad.length < 2) { return; }

    allBinlogPaths = binlogsToLoad;
    currentBinlogPath = baselineBinlog;

    await handleBinlogOpen(allBinlogPaths, context, false);

    // Wait for MCP client to be ready before offering comparison
    const waitForMcp = async () => {
        for (let i = 0; i < 30; i++) { // up to 30s
            if (mcpClient?.isReady) { return true; }
            await new Promise(r => setTimeout(r, 1000));
        }
        return false;
    };
    const mcpReady = await waitForMcp();

    const hasMultiple = binlogsToLoad.length > 2;
    vscode.window.showInformationMessage(
        hasMultiple
            ? `✅ Optimization complete! ${binlogsToLoad.length} binlogs loaded (baseline → before-warm → after-cold → after-warm).`
            : `✅ Optimized build complete! ${binlogsToLoad.length} binlogs loaded for comparison.`,
        ...(mcpReady ? ['Show Comparison Timeline'] : []),
        'Dismiss'
    ).then(action => {
        if (action === 'Show Comparison Timeline') {
            vscode.commands.executeCommand('binlog.compareTimelines');
        }
    });
}

/**
 * Build Timeline Webview — shows a horizontal bar chart of target/task durations.
 */
async function showTimelineWebview(context: vscode.ExtensionContext) {
    if (!mcpClient) { return; }

    const panel = vscode.window.createWebviewPanel(
        'binlogTimeline',
        `Build Timeline — ${getFileName(currentBinlogPath || 'binlog')}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    // Fetch data from MCP
    let targetsData: Record<string, any> = {};
    let tasksData: Record<string, any> = {};
    let projectsData: Record<string, any> = {};
    let totalProjectCount = 0;

    try {
        const [targetsResult, tasksResult, projectsResult, allProjectsResult] = await Promise.all([
            mcpClient.callTool('binlog_expensive_targets', { top_number: 20 }),
            mcpClient.callTool('binlog_expensive_tasks', { top_number: 20 }),
            mcpClient.callTool('binlog_expensive_projects', { limit: 20 }),
            mcpClient.callTool('binlog_projects'),
        ]);
        targetsData = JSON.parse(targetsResult.text);
        tasksData = JSON.parse(tasksResult.text);
        projectsData = JSON.parse(projectsResult.text);
        const allProjects = JSON.parse(allProjectsResult.text);
        const projectList = Array.isArray(allProjects) ? allProjects
            : (allProjects && typeof allProjects === 'object') ? Object.values(allProjects) : [];
        const uniqueNames = new Set(projectList.map((p: any) => {
            const fp = p.fullPath || p.projectFile || p.FullPath || p.ProjectFile || '';
            return String(fp).split(/[/\\]/).pop()?.toLowerCase() || '';
        }).filter(Boolean));
        totalProjectCount = uniqueNames.size || projectList.length;
    } catch {
        panel.webview.html = '<html><body><h2>Failed to load timeline data</h2></body></html>';
        return;
    }

    // Build target bars — handle both array (BinlogInsights) and object (baronfel) formats
    function parsePerfEntries(data: any): { name: string; durationMs: number; count: number; skipped?: number }[] {
        if (Array.isArray(data)) {
            return data.map((entry: any) => ({
                name: entry.name || entry.Name || entry.targetName || entry.TargetName || entry.taskName || entry.TaskName || '',
                durationMs: entry.ExclusiveDurationMs || entry.exclusiveDurationMs || entry.totalExclusiveMs || entry.InclusiveDurationMs || entry.inclusiveDurationMs || entry.totalInclusiveMs || entry.totalDurationMs || entry.durationMs || entry.duration || 0,
                count: entry.ExecutionCount || entry.executionCount || 1,
                skipped: entry.SkippedCount || entry.skippedCount || 0,
            }));
        }
        return Object.entries(data).map(([name, info]: [string, any]) => ({
            name,
            durationMs: info.ExclusiveDurationMs || info.exclusiveDurationMs || info.totalExclusiveMs || info.InclusiveDurationMs || info.inclusiveDurationMs || info.totalInclusiveMs || info.totalDurationMs || info.durationMs || info.duration || 0,
            count: info.ExecutionCount || info.executionCount || 1,
            skipped: info.SkippedCount || info.skippedCount || 0,
        }));
    }

    function parseProjectEntries(data: any): { name: string; durationMs: number }[] {
        if (Array.isArray(data)) {
            return data.map((proj: any) => {
                const file = proj.projectName || proj.ProjectFile || proj.projectFile || proj.fullPath || proj.FullPath || proj.ProjectName || '';
                const totalMs = proj.ExclusiveDurationMs || proj.exclusiveDurationMs || proj.totalExclusiveDurationMs
                    || proj.InclusiveDurationMs || proj.inclusiveDurationMs
                    || proj.totalDurationMs || proj.durationMs || proj.duration
                    || proj.TotalDurationMs || proj.DurationMs || proj.Duration || 0;
                return { name: extractFileName(String(file)), durationMs: totalMs };
            });
        }
        return Object.entries(data).map(([id, proj]: [string, any]) => {
            const file = proj.ProjectFile || proj.projectFile || proj.projectName || proj.ProjectName || '';
            const targets = proj.entryTargets || {};
            const totalMs = proj.ExclusiveDurationMs || proj.exclusiveDurationMs || proj.totalExclusiveDurationMs
                || proj.InclusiveDurationMs || proj.inclusiveDurationMs
                || proj.totalDurationMs || proj.durationMs
                || Object.values(targets).reduce((sum: number, t: any) => sum + (t.durationMs || 0), 0);
            return { name: extractFileName(file), durationMs: totalMs };
        });
    }

    const targetBars = parsePerfEntries(targetsData)
        .filter(t => t.durationMs > 0)
        .sort((a, b) => b.durationMs - a.durationMs);

    const taskBars = parsePerfEntries(tasksData)
        .filter(t => t.durationMs > 0)
        .sort((a, b) => b.durationMs - a.durationMs);

    // Compute project build times
    const projectBars = parseProjectEntries(projectsData)
        .filter(p => p.durationMs > 0)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 15);

    // Deduplicate projects by name
    const seenProjects = new Set<string>();
    const uniqueProjectBars = projectBars.filter(p => {
        if (seenProjects.has(p.name)) { return false; }
        seenProjects.add(p.name);
        return true;
    });

    const maxTargetMs = targetBars[0]?.durationMs || 1;
    const maxTaskMs = taskBars[0]?.durationMs || 1;
    const maxProjectMs = uniqueProjectBars[0]?.durationMs || 1;

    function formatDuration(ms: number): string {
        return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
    }

    function renderBars(items: { name: string; durationMs: number; count?: number; skipped?: number }[], maxMs: number, color: string, section: string): string {
        return items.map(item => {
            const pct = Math.max(2, (item.durationMs / maxMs) * 100);
            const meta = item.count && item.count > 1 ? ` <span class="count">×${item.count}</span>` : '';
            const skipBadge = item.skipped !== undefined && item.skipped > 0
                ? ` <span class="skip-badge">⏭ ${item.skipped} skipped</span>` : '';
            const escapedName = escapeHtml(item.name).replace(/'/g, "\\'");
            const durStr = formatDuration(item.durationMs);
            return `<div class="bar-row clickable" onclick="analyze('${escapedName}', '${durStr}', ${item.count || 1}, '${section}')" title="Click to analyze in Copilot Chat">
                <div class="bar-label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}${meta}${skipBadge}</div>
                <div class="bar-track">
                    <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
                </div>
                <div class="bar-value">${durStr}</div>
            </div>`;
        }).join('');
    }

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px;
        max-width: 900px;
        margin: 0 auto;
    }
    h1 { font-size: 1.4em; margin-bottom: 4px; }
    h2 { font-size: 1.1em; margin-top: 24px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
    .bar-row { display: flex; align-items: center; margin: 3px 0; height: 24px; }
    .bar-row.clickable { cursor: pointer; border-radius: 4px; padding: 0 4px; }
    .bar-row.clickable:hover { background: var(--vscode-list-hoverBackground); }
    .bar-label {
        width: 280px; min-width: 280px;
        font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        padding-right: 8px;
    }
    .bar-track {
        flex: 1; height: 18px; background: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 3px; overflow: hidden;
    }
    .bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; min-width: 2px; }
    .bar-value { width: 70px; text-align: right; font-size: 12px; padding-left: 8px; font-variant-numeric: tabular-nums; }
    .count { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .skip-badge {
        color: var(--vscode-charts-green);
        font-size: 10px; margin-left: 4px;
    }
    .section-icon { margin-right: 6px; }
    .summary {
        display: flex; gap: 24px; margin: 12px 0 20px 0;
        padding: 12px 16px; border-radius: 6px;
        background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .summary-item { text-align: center; }
    .summary-value { font-size: 1.6em; font-weight: bold; }
    .summary-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
    <h1>📊 Build Timeline</h1>
    <p style="color:var(--vscode-descriptionForeground)">${getFileName(currentBinlogPath || '')} — click any bar to analyze in Copilot Chat</p>

    <div class="summary">
        <div class="summary-item">
            <div class="summary-value">${totalProjectCount || uniqueProjectBars.length}</div>
            <div class="summary-label">Projects</div>
        </div>
        <div class="summary-item">
            <div class="summary-value">${targetBars.length}</div>
            <div class="summary-label">Targets</div>
        </div>
        <div class="summary-item" title="Cumulative time of the single most expensive target across all projects. With parallel builds, this can exceed wall-clock time because multiple projects run concurrently.">
            <div class="summary-value">${formatDuration(maxTargetMs)}</div>
            <div class="summary-label">Slowest Target</div>
        </div>
    </div>

    <h2 title="Targets sorted by cumulative duration across all project invocations. With parallel builds, these times can exceed the total build time."><span class="section-icon">🔥</span>Slowest Targets</h2>
    <p style="color:var(--vscode-descriptionForeground); font-size:12px; margin:-4px 0 8px 0;">Cumulative time across all project invocations — may exceed wall-clock build time with parallel builds</p>
    ${targetBars.length > 0 ? renderBars(targetBars, maxTargetMs, 'var(--vscode-charts-red, #f14c4c)', 'target') : '<p style="color:var(--vscode-descriptionForeground)">No target data</p>'}

    <h2 title="Tasks sorted by cumulative duration. A task may run many times across projects."><span class="section-icon">🔧</span>Slowest Tasks</h2>
    <p style="color:var(--vscode-descriptionForeground); font-size:12px; margin:-4px 0 8px 0;">Cumulative time — a task may run many times across projects</p>
    ${taskBars.length > 0 ? renderBars(taskBars, maxTaskMs, 'var(--vscode-charts-blue, #3794ff)', 'task') : '<p style="color:var(--vscode-descriptionForeground)">No task data</p>'}

    ${uniqueProjectBars.length > 0 ? `<h2><span class="section-icon">📁</span>Project Build Times</h2>
    ${renderBars(uniqueProjectBars, maxProjectMs, 'var(--vscode-charts-green, #89d185)', 'project')}` : ''}

    <script>
        const vscode = acquireVsCodeApi();
        function analyze(name, duration, count, section) {
            vscode.postMessage({ command: 'analyze', name, duration, count, section });
        }
    </script>
</body>
</html>`;

    // Handle messages from the webview (click-to-analyze)
    panel.webview.onDidReceiveMessage(message => {
        if (message.command === 'analyze') {
            const category = message.section === 'task' ? 'task'
                : message.section === 'project' ? 'project'
                : 'perf-item'; // targets
            vscode.commands.executeCommand('binlog.analyzeInChat', message.name, message.duration, message.count, category);
        }
    });
}

/**
 * Comparison Timeline Webview — side-by-side bar chart comparing two binlogs.
 */
async function showComparisonTimelineWebview(context: vscode.ExtensionContext) {
    if (!mcpClient || allBinlogPaths.length < 2) { return; }

    const pathA = allBinlogPaths[0];
    const pathB = allBinlogPaths[1];
    const nameA = getFileName(pathA);
    const nameB = getFileName(pathB);

    const panel = vscode.window.createWebviewPanel(
        'binlogCompareTimeline',
        `Compare: ${nameA} vs ${nameB}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    // Fetch data for both binlogs
    interface PerfData {
        targets: Record<string, any>;
        tasks: Record<string, any>;
        overview: string;
    }

    async function fetchPerfData(binlogPath: string): Promise<PerfData> {
        const [targetsResult, tasksResult, overviewResult] = await Promise.all([
            mcpClient!.callTool('binlog_expensive_targets', { top_number: 15, binlog_file: binlogPath }),
            mcpClient!.callTool('binlog_expensive_tasks', { top_number: 15, binlog_file: binlogPath }),
            mcpClient!.callTool('binlog_overview', { binlog_file: binlogPath }).catch(() => ({ text: '{}' })),
        ]);
        return {
            targets: JSON.parse(targetsResult.text),
            tasks: JSON.parse(tasksResult.text),
            overview: overviewResult.text,
        };
    }

    let dataA: PerfData, dataB: PerfData;
    try {
        [dataA, dataB] = await Promise.all([fetchPerfData(pathA), fetchPerfData(pathB)]);
    } catch {
        panel.webview.html = '<html><body><h2>Failed to load comparison data. Make sure both binlogs are loaded in the MCP server.</h2></body></html>';
        return;
    }

    function parseBars(data: any): Map<string, number> {
        const map = new Map<string, number>();
        if (Array.isArray(data)) {
            for (const entry of data) {
                const name = entry.name || entry.Name || entry.targetName || entry.TargetName || entry.taskName || entry.TaskName || '';
                const ms = entry.ExclusiveDurationMs || entry.exclusiveDurationMs || entry.totalExclusiveMs || entry.InclusiveDurationMs || entry.inclusiveDurationMs || entry.totalInclusiveMs || entry.totalDurationMs || entry.durationMs || entry.duration || 0;
                if (name) { map.set(name, ms); }
            }
        } else {
            for (const [name, info] of Object.entries(data as Record<string, any>)) {
                map.set(name, info.ExclusiveDurationMs || info.exclusiveDurationMs || info.totalExclusiveMs || info.InclusiveDurationMs || info.inclusiveDurationMs || info.totalInclusiveMs || info.totalDurationMs || info.durationMs || info.duration || 0);
            }
        }
        return map;
    }

    function formatDuration(ms: number): string {
        return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
    }

    // Merge target names from both builds
    const targetsA = parseBars(dataA.targets);
    const targetsB = parseBars(dataB.targets);
    const allTargetNames = [...new Set([...targetsA.keys(), ...targetsB.keys()])];

    const tasksA = parseBars(dataA.tasks);
    const tasksB = parseBars(dataB.tasks);
    const allTaskNames = [...new Set([...tasksA.keys(), ...tasksB.keys()])];

    // Sort by max duration across both builds
    allTargetNames.sort((a, b) =>
        Math.max(targetsA.get(b) || 0, targetsB.get(b) || 0) -
        Math.max(targetsA.get(a) || 0, targetsB.get(a) || 0)
    );
    allTaskNames.sort((a, b) =>
        Math.max(tasksA.get(b) || 0, tasksB.get(b) || 0) -
        Math.max(tasksA.get(a) || 0, tasksB.get(a) || 0)
    );

    function renderComparisonBars(
        names: string[],
        mapA: Map<string, number>,
        mapB: Map<string, number>,
    ): string {
        const maxMs = Math.max(
            ...[...mapA.values(), ...mapB.values(), 1]
        );
        return names.map(name => {
            const msA = mapA.get(name) || 0;
            const msB = mapB.get(name) || 0;
            const pctA = Math.max(1, (msA / maxMs) * 100);
            const pctB = Math.max(1, (msB / maxMs) * 100);
            const delta = msA > 0 ? ((msB - msA) / msA * 100) : (msB > 0 ? 100 : 0);
            const deltaSign = delta > 0 ? '+' : '';
            const deltaClass = delta > 5 ? 'delta-worse' : delta < -5 ? 'delta-better' : 'delta-neutral';
            const deltaStr = msA > 0 || msB > 0 ? `<span class="${deltaClass}">${deltaSign}${delta.toFixed(0)}%</span>` : '';
            // Show "NEW" or "REMOVED" badges
            const badge = msA === 0 && msB > 0 ? '<span class="badge-new">NEW</span>'
                : msA > 0 && msB === 0 ? '<span class="badge-removed">REMOVED</span>' : '';

            return `<div class="cmp-row">
                <div class="cmp-label" title="${escapeHtml(name)}">${escapeHtml(name)} ${badge}</div>
                <div class="cmp-bars">
                    <div class="cmp-bar-pair">
                        <div class="cmp-bar-track">
                            <div class="cmp-bar-fill bar-a" style="width:${pctA}%"></div>
                        </div>
                        <div class="cmp-bar-val">${msA > 0 ? formatDuration(msA) : '—'}</div>
                    </div>
                    <div class="cmp-bar-pair">
                        <div class="cmp-bar-track">
                            <div class="cmp-bar-fill bar-b" style="width:${pctB}%"></div>
                        </div>
                        <div class="cmp-bar-val">${msB > 0 ? formatDuration(msB) : '—'}</div>
                    </div>
                </div>
                <div class="cmp-delta">${deltaStr}</div>
            </div>`;
        }).join('');
    }

    // Summary stats
    const totalA = [...targetsA.values()].reduce((s, v) => s + v, 0);
    const totalB = [...targetsB.values()].reduce((s, v) => s + v, 0);
    const totalDelta = totalA > 0 ? ((totalB - totalA) / totalA * 100) : 0;
    const totalDeltaClass = totalDelta > 5 ? 'delta-worse' : totalDelta < -5 ? 'delta-better' : 'delta-neutral';

    // Extract wall-clock build duration from overview text
    function extractBuildDuration(overviewText: string): string {
        // Look for patterns like "Build succeeded in 294.3s" or "Duration: 5m 12s" or "duration_seconds": 294
        const secMatch = overviewText.match(/(?:in|Duration[:\s]*)\s*([\d.]+)\s*s/i);
        if (secMatch) { return `${parseFloat(secMatch[1]).toFixed(1)}s`; }
        const minMatch = overviewText.match(/(?:in|Duration[:\s]*)\s*(\d+)\s*m\s*([\d.]+)\s*s/i);
        if (minMatch) { return `${minMatch[1]}m ${parseFloat(minMatch[2]).toFixed(0)}s`; }
        const jsonMatch = overviewText.match(/"(?:duration_seconds|durationSeconds|totalSeconds)"[:\s]*([\d.]+)/i);
        if (jsonMatch) { return `${parseFloat(jsonMatch[1]).toFixed(1)}s`; }
        return '';
    }
    const wallClockA = extractBuildDuration(dataA.overview);
    const wallClockB = extractBuildDuration(dataB.overview);

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px; max-width: 1000px; margin: 0 auto;
    }
    h1 { font-size: 1.4em; margin-bottom: 4px; }
    h2 { font-size: 1.1em; margin-top: 28px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
    .legend {
        display: flex; gap: 20px; margin: 8px 0 16px 0; font-size: 12px;
        color: var(--vscode-descriptionForeground);
    }
    .legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
    .summary {
        display: flex; gap: 24px; margin: 12px 0 20px 0;
        padding: 14px 20px; border-radius: 6px;
        background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .summary-item { text-align: center; }
    .summary-value { font-size: 1.5em; font-weight: bold; }
    .summary-label { font-size: 11px; color: var(--vscode-descriptionForeground); }

    .cmp-row { display: flex; align-items: center; margin: 4px 0; }
    .cmp-label {
        width: 240px; min-width: 240px; font-size: 12px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        padding-right: 8px;
    }
    .cmp-bars { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .cmp-bar-pair { display: flex; align-items: center; height: 14px; }
    .cmp-bar-track {
        flex: 1; height: 12px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 2px; overflow: hidden;
    }
    .cmp-bar-fill { height: 100%; border-radius: 2px; min-width: 2px; transition: width 0.5s ease; }
    .bar-a { background: var(--vscode-charts-blue, #3794ff); opacity: 0.85; }
    .bar-b { background: var(--vscode-charts-orange, #d18616); opacity: 0.85; }
    .cmp-bar-val {
        width: 55px; text-align: right; font-size: 11px; padding-left: 6px;
        font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground);
    }
    .cmp-delta { width: 65px; text-align: right; font-size: 11px; padding-left: 8px; font-weight: 600; }

    .delta-worse { color: var(--vscode-charts-red, #f14c4c); }
    .delta-better { color: var(--vscode-charts-green, #89d185); }
    .delta-neutral { color: var(--vscode-descriptionForeground); }

    .badge-new {
        font-size: 9px; padding: 1px 4px; border-radius: 3px; margin-left: 4px;
        background: var(--vscode-charts-orange, #d18616); color: #fff; font-weight: 600;
    }
    .badge-removed {
        font-size: 9px; padding: 1px 4px; border-radius: 3px; margin-left: 4px;
        background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); font-weight: 600;
    }
</style>
</head>
<body>
    <h1>📊 Build Comparison</h1>

    <div class="legend">
        <span><span class="legend-swatch" style="background:var(--vscode-charts-blue,#3794ff)"></span> A: ${nameA}</span>
        <span><span class="legend-swatch" style="background:var(--vscode-charts-orange,#d18616)"></span> B: ${nameB}</span>
    </div>

    <div class="summary">
        ${wallClockA || wallClockB ? `
        <div class="summary-item" title="Actual elapsed time (wall-clock) for the entire build">
            <div class="summary-value">${wallClockA || '—'}</div>
            <div class="summary-label">Build A (wall-clock)</div>
        </div>
        <div class="summary-item" title="Actual elapsed time (wall-clock) for the entire build">
            <div class="summary-value">${wallClockB || '—'}</div>
            <div class="summary-label">Build B (wall-clock)</div>
        </div>
        <div class="summary-item" style="border-left: 1px solid var(--vscode-widget-border); padding-left: 20px;">` : `<div class="summary-item">`}
            <div class="summary-value">${formatDuration(totalA)}</div>
            <div class="summary-label" title="Sum of all target durations (cumulative CPU time)">Build A (targets)</div>
        </div>
        <div class="summary-item">
            <div class="summary-value">${formatDuration(totalB)}</div>
            <div class="summary-label" title="Sum of all target durations (cumulative CPU time)">Build B (targets)</div>
        </div>
        <div class="summary-item">
            <div class="summary-value ${totalDeltaClass}">${totalDelta > 0 ? '+' : ''}${totalDelta.toFixed(1)}%</div>
            <div class="summary-label">Delta</div>
        </div>
    </div>

    <h2><span style="margin-right:6px">🔥</span>Target Comparison</h2>
    ${renderComparisonBars(allTargetNames, targetsA, targetsB)}

    <h2><span style="margin-right:6px">🔧</span>Task Comparison</h2>
    ${renderComparisonBars(allTaskNames, tasksA, tasksB)}
</body>
</html>`;
}

function extractFileName(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
}

/**
 * CodeLens provider for .csproj files — shows build time and diagnostic counts.
 */
let codeLensProvider: vscode.Disposable | undefined;

function registerCodeLensProvider(context: vscode.ExtensionContext) {
    if (codeLensProvider) { return; } // Already registered

    const provider = new BinlogCodeLensProvider();
    codeLensProvider = vscode.languages.registerCodeLensProvider(
        { pattern: '**/*.{csproj,vbproj,fsproj,props,targets}' },
        provider
    );
    context.subscriptions.push(codeLensProvider);
}

class BinlogCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!treeDataProvider || !mcpClient) { return []; }

        const fileName = document.uri.fsPath.split(/[/\\]/).pop() || '';
        const projectFiles = treeDataProvider.getProjectFiles();

        // Check if this file is a project in the loaded binlog
        const matchingProject = projectFiles.find(p => {
            const pName = p.split(/[/\\]/).pop() || '';
            return pName.toLowerCase() === fileName.toLowerCase();
        });

        if (!matchingProject) { return []; }

        // Find the <Project line
        let projectLine = 0;
        for (let i = 0; i < Math.min(document.lineCount, 10); i++) {
            if (document.lineAt(i).text.includes('<Project')) {
                projectLine = i;
                break;
            }
        }

        const range = new vscode.Range(projectLine, 0, projectLine, 0);
        const lenses: vscode.CodeLens[] = [];

        // Per-project diagnostic counts
        const projCounts = treeDataProvider.getProjectDiagnosticCounts(fileName);
        const errorCount = projCounts.errorCount;
        const warnCount = projCounts.warningCount;

        const parts: string[] = [];
        if (errorCount > 0) { parts.push(`$(error) ${errorCount} errors`); }
        if (warnCount > 0) { parts.push(`$(warning) ${warnCount} warnings`); }

        // "Ask @binlog" lens
        lenses.push(new vscode.CodeLens(range, {
            title: `$(tools) Analyze with @binlog`,
            command: 'workbench.action.chat.open',
            arguments: [`@binlog analyze the build of ${fileName} — show errors, performance bottlenecks, and optimization suggestions`],
        }));

        if (parts.length > 0) {
            lenses.push(new vscode.CodeLens(range, {
                title: parts.join(' · '),
                command: 'workbench.actions.view.problems',
                arguments: [],
            }));
        }

        // Timeline lens
        lenses.push(new vscode.CodeLens(range, {
            title: `$(graph) Build Timeline`,
            command: 'binlog.showTimeline',
            arguments: [],
        }));

        return lenses;
    }
}

/**
 * Custom readonly editor for .binlog files.
 * When a user opens a .binlog file in VS Code (e.g. File → Open, double-click in Explorer),
 * this provider loads it into the analyzer and shows a summary webview.
 */
class BinlogEditorProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose() {} };
    }

    resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
    ): void {
        const filePath = document.uri.fsPath;
        const fileName = getFileName(filePath);

        // Show a simple webview indicating the file is being loaded
        webviewPanel.webview.html = this.getHtml(fileName, filePath);

        // Trigger the standard binlog loading flow
        handleBinlogOpen([filePath], this.context);
    }

    private getHtml(fileName: string, filePath: string): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .container { text-align: center; max-width: 500px; }
        h2 { margin-bottom: 8px; }
        .path { opacity: 0.7; font-size: 12px; word-break: break-all; margin-bottom: 24px; }
        .hint { opacity: 0.6; font-size: 13px; margin-top: 16px; }
        .icon { font-size: 48px; margin-bottom: 16px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">📊</div>
        <h2>${fileName}</h2>
        <div class="path">${filePath.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
        <p>This binlog has been loaded into the <strong>Binlog Explorer</strong> sidebar.</p>
        <p class="hint">Use <code>@binlog</code> in Copilot Chat to analyze the build,<br/>
        or expand the tree in the sidebar to explore.</p>
    </div>
</body>
</html>`;
    }
}
