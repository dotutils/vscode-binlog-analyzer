import * as vscode from 'vscode';

/**
 * This "dotutils" extension is deprecated in favor of the official Microsoft
 * extension. A single transient toast is too easy to dismiss, so we use two
 * layers that are hard to miss but not obnoxious:
 *   1. A blocking modal shown exactly once (Escape/Cancel only defers it to the
 *      next activation — it is never treated as a permanent dismissal).
 *   2. A persistent status-bar warning that stays until the user migrates or
 *      explicitly opts out, and re-opens the migration prompt on click.
 * Everything is best-effort and must never block or break activation.
 */
const NEW_EXTENSION_ID = 'ms-dotnettools.msbuild-binlog-analyzer';
const OLD_EXTENSION_ID = 'dotutils.binlog-analyzer';
const MIGRATE_COMMAND = 'binlog.showDeprecationMigration';
const SUPPRESS_KEY = 'binlog.deprecationNoticeSuppressed';
const MODAL_SHOWN_KEY = 'binlog.deprecationModalShown';

export function registerDeprecationNotice(context: vscode.ExtensionContext): void {
    try {
        // Already migrated — the official extension is installed, so stay quiet.
        if (vscode.extensions.getExtension(NEW_EXTENSION_ID)) {
            return;
        }
        if (context.globalState.get<boolean>(SUPPRESS_KEY)) {
            return;
        }

        // Persistent, always-visible reminder that survives dismissing the dialog.
        const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
        status.text = '$(warning) Binlog Analyzer deprecated';
        status.tooltip = 'This extension has moved to ms-dotnettools.msbuild-binlog-analyzer. Click to migrate.';
        status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        status.command = MIGRATE_COMMAND;
        status.show();
        context.subscriptions.push(status);

        const migrate = async (modal: boolean): Promise<void> => {
            try {
                const install = 'Install new extension';
                const dismiss = "Don't show again";
                const choice = await vscode.window.showWarningMessage(
                    'MSBuild Binlog Analyzer has moved to the official Microsoft extension ' +
                    '"MSBuild Binlog Analyzer for VS Code" (ms-dotnettools.msbuild-binlog-analyzer). ' +
                    'This "dotutils" version is deprecated and will no longer be updated. ' +
                    'Please install the official extension to keep getting updates.',
                    { modal },
                    install, dismiss);

                if (choice === install) {
                    await vscode.commands.executeCommand('workbench.extensions.installExtension', NEW_EXTENSION_ID);
                    status.hide();
                    const uninstall = 'Uninstall old & reload';
                    const next = await vscode.window.showInformationMessage(
                        'The official extension is installed. Uninstall this deprecated version and reload to finish migrating?',
                        uninstall, 'Later');
                    if (next === uninstall) {
                        await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                } else if (choice === dismiss) {
                    await context.globalState.update(SUPPRESS_KEY, true);
                    status.hide();
                }
                // choice === undefined (Escape/Cancel) or "Later": leave the status
                // bar in place and re-prompt on a future activation.
            } catch {
                // Non-fatal.
            }
        };

        context.subscriptions.push(
            vscode.commands.registerCommand(MIGRATE_COMMAND, () => migrate(false))
        );

        // Show the unmissable modal exactly once; the status bar covers later sessions.
        if (!context.globalState.get<boolean>(MODAL_SHOWN_KEY)) {
            void context.globalState.update(MODAL_SHOWN_KEY, true);
            void migrate(true);
        }
    } catch {
        // Non-fatal — never block activation on the migration notice.
    }
}
