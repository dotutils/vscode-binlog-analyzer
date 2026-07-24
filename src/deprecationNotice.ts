import * as vscode from 'vscode';

/**
 * This "dotutils" extension is deprecated in favor of the official Microsoft
 * extension. On activation we nudge the user to install the replacement and
 * (optionally) uninstall this one. The prompt is best-effort and must never
 * block or break activation.
 */
const NEW_EXTENSION_ID = 'ms-dotnettools.msbuild-binlog-analyzer';
const OLD_EXTENSION_ID = 'dotutils.binlog-analyzer';
const DISMISS_KEY = 'binlog.deprecationNoticeDismissed';

export async function showDeprecationNotice(context: vscode.ExtensionContext): Promise<void> {
    try {
        // Already migrated — the official extension is installed, so stay quiet.
        if (vscode.extensions.getExtension(NEW_EXTENSION_ID)) {
            return;
        }
        if (context.globalState.get<boolean>(DISMISS_KEY)) {
            return;
        }

        const install = 'Install new extension';
        const details = 'What changed';
        const dismiss = "Don't show again";
        const choice = await vscode.window.showWarningMessage(
            'MSBuild Binlog Analyzer has moved to the official Microsoft extension ' +
            '"MSBuild Binlog Analyzer for VS Code" (ms-dotnettools.msbuild-binlog-analyzer). ' +
            'This "dotutils" version is deprecated and will no longer be updated.',
            install, details, dismiss);

        if (choice === install) {
            await vscode.commands.executeCommand('workbench.extensions.installExtension', NEW_EXTENSION_ID);
            const uninstall = 'Uninstall old & reload';
            const later = 'Later';
            const next = await vscode.window.showInformationMessage(
                'The official extension is installed. Uninstall this deprecated version and reload to finish migrating?',
                uninstall, later);
            if (next === uninstall) {
                await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } else if (choice === details) {
            await vscode.env.openExternal(vscode.Uri.parse(
                'https://marketplace.visualstudio.com/items?itemName=' + NEW_EXTENSION_ID));
        } else if (choice === dismiss) {
            await context.globalState.update(DISMISS_KEY, true);
        }
    } catch {
        // Non-fatal — never block activation on the migration notice.
    }
}
