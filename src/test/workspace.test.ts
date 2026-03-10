import * as assert from 'assert';
import {
    workspaceMatchesBinlog,
    getSourceLabel,
    getProjectRootCandidates,
    extractFileName,
} from '../parsers';

suite('Workspace Flow Scenarios', () => {

    suite('workspaceMatchesBinlog', () => {
        test('matches when binlog is inside workspace', () => {
            assert.ok(workspaceMatchesBinlog(
                'C:\\src\\MyProject',
                'C:\\src\\MyProject\\artifacts\\build.binlog'
            ));
        });

        test('matches when workspace is inside binlog dir', () => {
            assert.ok(workspaceMatchesBinlog(
                'C:\\src\\MyProject\\src\\App',
                'C:\\src\\MyProject\\build.binlog'
            ));
        });

        test('matches case-insensitively', () => {
            assert.ok(workspaceMatchesBinlog(
                'C:\\SRC\\MYPROJECT',
                'c:\\src\\myproject\\build.binlog'
            ));
        });

        test('does not match unrelated paths', () => {
            assert.ok(!workspaceMatchesBinlog(
                'C:\\src\\ProjectA',
                'C:\\src\\ProjectB\\build.binlog'
            ));
        });

        test('does not match different drives', () => {
            assert.ok(!workspaceMatchesBinlog(
                'C:\\src\\MyProject',
                'D:\\builds\\build.binlog'
            ));
        });

        test('returns false when workspace is undefined', () => {
            assert.ok(!workspaceMatchesBinlog(undefined, 'C:\\src\\build.binlog'));
        });

        test('returns false when workspace is empty', () => {
            assert.ok(!workspaceMatchesBinlog('', 'C:\\src\\build.binlog'));
        });

        test('matches when binlog is directly in workspace root', () => {
            assert.ok(workspaceMatchesBinlog(
                'C:\\src\\MyProject',
                'C:\\src\\MyProject\\msbuild.binlog'
            ));
        });

        test('matches deeply nested binlog', () => {
            assert.ok(workspaceMatchesBinlog(
                'C:\\repos\\dotnet\\msbuild',
                'C:\\repos\\dotnet\\msbuild\\artifacts\\log\\Debug\\msbuild.binlog'
            ));
        });
    });

    suite('getSourceLabel', () => {
        test('shows workspace name when workspace matches binlog', () => {
            const result = getSourceLabel(
                'C:\\src\\MyProject',
                'MyProject',
                'C:\\src\\MyProject\\build.binlog'
            );
            assert.strictEqual(result.label, 'MyProject');
            assert.ok(result.tooltip.includes('Workspace:'));
        });

        test('shows binlog parent dir when workspace does not match', () => {
            const result = getSourceLabel(
                'C:\\src\\ProjectA',
                'ProjectA',
                'C:\\src\\ProjectB\\build.binlog'
            );
            assert.strictEqual(result.label, 'ProjectB');
            assert.ok(result.tooltip.includes('Binlog source:'));
        });

        test('shows binlog parent dir when no workspace', () => {
            const result = getSourceLabel(
                undefined,
                undefined,
                'C:\\builds\\templating\\msbuild.binlog'
            );
            assert.strictEqual(result.label, 'templating');
            assert.ok(result.tooltip.includes('Binlog source:'));
        });

        test('uses workspace basename when workspace name not provided', () => {
            const result = getSourceLabel(
                'C:\\repos\\my-app',
                undefined,
                'C:\\repos\\my-app\\out\\build.binlog'
            );
            assert.strictEqual(result.label, 'my-app');
        });
    });

    suite('Scenario: Open first binlog without workspace', () => {
        test('no workspace → label shows binlog parent directory', () => {
            const binlog = 'C:\\builds\\msbuild\\msbuild.binlog';
            const result = getSourceLabel(undefined, undefined, binlog);
            assert.strictEqual(result.label, 'msbuild');
            assert.ok(result.tooltip.includes('Binlog source:'));
        });

        test('no workspace → workspace does not match', () => {
            assert.ok(!workspaceMatchesBinlog(
                undefined,
                'C:\\builds\\msbuild\\msbuild.binlog'
            ));
        });

        test('project root candidates are detected from binlog projects', () => {
            const projectPaths = [
                'C:\\msbuild\\main_2\\msbuild\\src\\Build\\Microsoft.Build.csproj',
                'C:\\msbuild\\main_2\\msbuild\\src\\Tasks\\Microsoft.Build.Tasks.csproj',
                'C:\\msbuild\\main_2\\msbuild\\src\\Shared\\Microsoft.Build.Shared.csproj',
            ];
            const candidates = getProjectRootCandidates(projectPaths);
            assert.ok(candidates.length > 0, 'Should detect at least one candidate');
            const normalized = candidates.map(c => c.toLowerCase());
            assert.ok(
                normalized.some(c => c.includes('msbuild')),
                'Should include msbuild directory as candidate'
            );
        });
    });

    suite('Scenario: Select workspace matching binlog', () => {
        const binlog = 'C:\\msbuild\\main_2\\msbuild\\msbuild.binlog';
        const workspace = 'C:\\msbuild\\main_2\\msbuild';

        test('workspace matches binlog after selection', () => {
            assert.ok(workspaceMatchesBinlog(workspace, binlog));
        });

        test('label shows workspace name', () => {
            const result = getSourceLabel(workspace, 'msbuild', binlog);
            assert.strictEqual(result.label, 'msbuild');
            assert.ok(result.tooltip.includes('Workspace:'));
        });
    });

    suite('Scenario: Switch to different binlog', () => {
        const oldBinlog = 'C:\\msbuild\\main_2\\msbuild\\msbuild.binlog';
        const newBinlog = 'C:\\templating\\templating.binlog';
        const workspace = 'C:\\msbuild\\main_2\\msbuild';

        test('old workspace does not match new binlog', () => {
            assert.ok(!workspaceMatchesBinlog(workspace, newBinlog));
        });

        test('label switches to new binlog directory name', () => {
            const result = getSourceLabel(workspace, 'msbuild', newBinlog);
            assert.strictEqual(result.label, 'templating');
            assert.ok(result.tooltip.includes('Binlog source:'));
        });

        test('getFileName returns correct name for new binlog', () => {
            assert.strictEqual(extractFileName(newBinlog), 'templating.binlog');
        });
    });

    suite('Scenario: Update workspace to match new binlog', () => {
        const newBinlog = 'C:\\templating\\templating.binlog';
        const newWorkspace = 'C:\\templating';

        test('new workspace matches new binlog', () => {
            assert.ok(workspaceMatchesBinlog(newWorkspace, newBinlog));
        });

        test('label now shows workspace name', () => {
            const result = getSourceLabel(newWorkspace, 'templating', newBinlog);
            assert.strictEqual(result.label, 'templating');
            assert.ok(result.tooltip.includes('Workspace:'));
        });

        test('old binlog from msbuild would not match templating workspace', () => {
            const oldBinlog = 'C:\\msbuild\\main_2\\msbuild\\msbuild.binlog';
            assert.ok(!workspaceMatchesBinlog(newWorkspace, oldBinlog));
        });
    });

    suite('Scenario: Full flow simulation', () => {
        // Simulates the full user journey:
        // 1. Open msbuild.binlog with no workspace
        // 2. Set workspace to C:\msbuild\main_2
        // 3. Load templating.binlog
        // 4. Set workspace to C:\templating

        const msbuildBinlog = 'C:\\msbuild\\main_2\\msbuild\\msbuild.binlog';
        const templatingBinlog = 'C:\\templating\\src\\templating.binlog';

        test('Step 1: no workspace, msbuild binlog', () => {
            const match = workspaceMatchesBinlog(undefined, msbuildBinlog);
            assert.ok(!match, 'Should not match without workspace');

            const label = getSourceLabel(undefined, undefined, msbuildBinlog);
            assert.strictEqual(label.label, 'msbuild');
        });

        test('Step 2: set workspace to msbuild root', () => {
            const ws = 'C:\\msbuild\\main_2';
            const match = workspaceMatchesBinlog(ws, msbuildBinlog);
            assert.ok(match, 'Workspace should match binlog');

            const label = getSourceLabel(ws, 'main_2', msbuildBinlog);
            assert.strictEqual(label.label, 'main_2');
            assert.ok(label.tooltip.includes('Workspace:'));
        });

        test('Step 3: load templating binlog with msbuild workspace', () => {
            const ws = 'C:\\msbuild\\main_2';
            const match = workspaceMatchesBinlog(ws, templatingBinlog);
            assert.ok(!match, 'msbuild workspace should NOT match templating binlog');

            const label = getSourceLabel(ws, 'main_2', templatingBinlog);
            assert.strictEqual(label.label, 'src');
            assert.ok(label.tooltip.includes('Binlog source:'));
        });

        test('Step 4: set workspace to templating root', () => {
            const ws = 'C:\\templating';
            const match = workspaceMatchesBinlog(ws, templatingBinlog);
            assert.ok(match, 'templating workspace should match templating binlog');

            const label = getSourceLabel(ws, 'templating', templatingBinlog);
            assert.strictEqual(label.label, 'templating');
            assert.ok(label.tooltip.includes('Workspace:'));
        });
    });

    suite('Edge cases', () => {
        test('binlog at drive root', () => {
            const match = workspaceMatchesBinlog('C:\\', 'C:\\build.binlog');
            assert.ok(match, 'Drive root workspace matches anything on same drive');
        });

        test('Unix-style paths', () => {
            const match = workspaceMatchesBinlog(
                '/home/user/repos/myproject',
                '/home/user/repos/myproject/build.binlog'
            );
            assert.ok(match);
        });

        test('workspace with trailing separator', () => {
            const match = workspaceMatchesBinlog(
                'C:\\src\\project\\',
                'C:\\src\\project\\build.binlog'
            );
            assert.ok(match);
        });

        test('project root candidates deduplication', () => {
            const paths = [
                'C:\\src\\proj\\A.csproj',
                'C:\\src\\proj\\B.csproj',
                'C:\\src\\proj\\C.csproj',
            ];
            const candidates = getProjectRootCandidates(paths);
            // All same dir — should rank C:\src\proj highest
            assert.ok(candidates.length > 0);
        });

        test('project root candidates with diverse paths', () => {
            const paths = [
                'C:\\repos\\dotnet\\runtime\\src\\libs\\System.IO\\System.IO.csproj',
                'C:\\repos\\dotnet\\runtime\\src\\libs\\System.Net\\System.Net.csproj',
                'D:\\other\\unrelated\\Other.csproj',
            ];
            const candidates = getProjectRootCandidates(paths);
            assert.ok(candidates.length >= 2, 'Should detect multiple candidates');
        });
    });
});
