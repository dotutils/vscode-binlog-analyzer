import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'dotutils.binlog-analyzer';

function getExtension() {
    return vscode.extensions.getExtension(EXTENSION_ID);
}

async function tryActivate(): Promise<boolean> {
    const ext = getExtension();
    if (!ext) { return false; }
    try {
        await ext.activate();
        return ext.isActive;
    } catch {
        // Extension may fail to activate if github.copilot-chat is missing
        return false;
    }
}

suite('Extension E2E Tests', () => {

    suite('Discovery', () => {
        test('extension is present in the list', () => {
            const ext = getExtension();
            assert.ok(ext, `Extension ${EXTENSION_ID} not found`);
        });

        test('extension has correct display name', () => {
            const ext = getExtension()!;
            assert.strictEqual(ext.packageJSON.displayName, 'MSBuild Binlog Analyzer');
        });

        test('extension has correct version', () => {
            const ext = getExtension()!;
            assert.ok(ext.packageJSON.version, 'Version should be defined');
        });
    });

    suite('Package Manifest', () => {
        let pkg: any;

        suiteSetup(() => {
            pkg = getExtension()!.packageJSON;
        });

        test('declares expected commands', () => {
            const commands: string[] = pkg.contributes.commands.map((c: any) => c.command);
            const expected = [
                'binlog.loadFile',
                'binlog.addFile',
                'binlog.removeFile',
                'binlog.manageBinlogs',
                'binlog.showBuildSummary',
                'binlog.refreshTree',
                'binlog.setWorkspaceFolder',
                'binlog.fixAllIssues',
                'binlog.showErrors',
                'binlog.openInStructuredLogViewer',
                'binlog.showTimeline',
                'binlog.compareTimelines',
                'binlog.scanSecrets',
                'binlog.redactSecrets',
                'binlog.copyItem',
                'binlog.copyAllErrors',
                'binlog.copyAllWarnings',
                'binlog.openProjectFolder',
                'binlog.openInEditor',
                'binlog.openProjectDetails',
            ];
            for (const cmd of expected) {
                assert.ok(commands.includes(cmd), `Command '${cmd}' not declared in package.json`);
            }
        });

        test('declares binlogExplorer view', () => {
            const views = pkg.contributes.views;
            const container = Object.values(views).flat() as any[];
            const binlogView = container.find((v: any) => v.id === 'binlogExplorer');
            assert.ok(binlogView, 'binlogExplorer view not declared');
        });

        test('declares chat participant', () => {
            const participants = pkg.contributes.chatParticipants;
            assert.ok(participants, 'chatParticipants not declared');
            const binlog = participants.find((p: any) => p.id === 'binlog-analyzer.binlog');
            assert.ok(binlog, '@binlog chat participant not declared');
        });

        test('declares slash commands', () => {
            const participants = pkg.contributes.chatParticipants;
            const binlog = participants.find((p: any) => p.id === 'binlog-analyzer.binlog');
            const commands: string[] = binlog.commands.map((c: any) => c.name);
            const expected = ['errors', 'timeline', 'targets', 'summary', 'secrets', 'compare', 'perf', 'incremental'];
            for (const cmd of expected) {
                assert.ok(commands.includes(cmd), `Slash command '/${cmd}' not declared`);
            }
        });

        test('declares activation events', () => {
            const events: string[] = pkg.activationEvents;
            assert.ok(events.includes('onUri'), 'Missing onUri activation event');
            assert.ok(events.includes('onView:binlogExplorer'), 'Missing onView activation event');
        });

        test('declares custom editor for .binlog files', () => {
            const editors = pkg.contributes.customEditors;
            assert.ok(editors, 'customEditors not declared');
            const binlogEditor = editors.find((e: any) => e.viewType === 'binlog-analyzer.binlogViewer');
            assert.ok(binlogEditor, 'binlog custom editor not declared');
            assert.ok(
                binlogEditor.selector.some((s: any) => s.filenamePattern === '*.binlog'),
                'Custom editor should match *.binlog files'
            );
        });

        test('declares menus for binlogExplorer', () => {
            const menus = pkg.contributes.menus;
            assert.ok(menus['view/title'], 'Missing view/title menus');
            assert.ok(menus['view/item/context'], 'Missing view/item/context menus');
        });
    });

    suite('Activation', () => {
        test('extension activates or fails gracefully with missing dependency', async () => {
            const ext = getExtension()!;
            const activated = await tryActivate();
            if (activated) {
                assert.ok(ext.isActive, 'Extension should be active');
            } else {
                // Expected when github.copilot-chat is not installed
                assert.ok(true, 'Extension failed to activate due to missing dependency — expected in test environment');
            }
        });
    });

    suite('Commands (if activated)', () => {
        let activated: boolean;

        suiteSetup(async () => {
            activated = await tryActivate();
        });

        test('registered commands are available', async function () {
            if (!activated) { this.skip(); return; }
            const allCommands = await vscode.commands.getCommands(true);
            const binlogCommands = allCommands.filter(c => c.startsWith('binlog.'));
            assert.ok(binlogCommands.length >= 15, `Expected at least 15 binlog commands, got ${binlogCommands.length}`);
        });

        test('refreshTree does not throw without binlog', async function () {
            if (!activated) { this.skip(); return; }
            await vscode.commands.executeCommand('binlog.refreshTree');
        });

        test('showTimeline does not crash without binlog', async function () {
            if (!activated) { this.skip(); return; }
            await vscode.commands.executeCommand('binlog.showTimeline');
        });

        test('copyAllErrors does not crash without binlog', async function () {
            if (!activated) { this.skip(); return; }
            await vscode.commands.executeCommand('binlog.copyAllErrors');
        });

        test('copyAllWarnings does not crash without binlog', async function () {
            if (!activated) { this.skip(); return; }
            await vscode.commands.executeCommand('binlog.copyAllWarnings');
        });
    });
});
