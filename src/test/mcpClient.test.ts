import * as assert from 'assert';
import { buildMcpArgs, buildLaunchArgs, CONTRACT_LAUNCH_FLAGS } from '../mcpArgs';

// Note: McpClient itself spawns a child process so we don't unit-test it
// end-to-end here. We do, however, exercise the pure-function helper
// `buildMcpArgs` and assert behaviour we contract-document elsewhere.

suite('mcpClient', () => {
    suite('buildMcpArgs', () => {
        test('expands a single binlog with the default template', () => {
            const args = buildMcpArgs('--binlog ${binlog}', ['/tmp/a.binlog']);
            assert.deepStrictEqual(args, ['--binlog', '/tmp/a.binlog']);
        });

        test('repeats the template once per binlog', () => {
            const args = buildMcpArgs('--binlog ${binlog}', ['/a.binlog', '/b.binlog']);
            assert.deepStrictEqual(args, ['--binlog', '/a.binlog', '--binlog', '/b.binlog']);
        });

        test('handles custom templates', () => {
            const args = buildMcpArgs('--file ${binlog} --quiet', ['/a.binlog']);
            assert.deepStrictEqual(args, ['--file', '/a.binlog', '--quiet']);
        });

        test('returns an empty array when no binlogs are provided', () => {
            const args = buildMcpArgs('--binlog ${binlog}', []);
            assert.deepStrictEqual(args, []);
        });

        test('preserves spaces inside binlog paths (does not fragment argv)', () => {
            // Regression: previously the template was substituted then split on
            // whitespace, which broke `C:\\Users\\Has Space\\build.binlog` into
            // three argv entries.
            const args = buildMcpArgs('--binlog ${binlog}', ['C:\\Users\\Has Space\\build.binlog']);
            assert.deepStrictEqual(args, ['--binlog', 'C:\\Users\\Has Space\\build.binlog']);
        });

        test('preserves embedded equals-form (--prefix=${binlog})', () => {
            const args = buildMcpArgs('--prefix=${binlog}', ['/path with space/a.binlog']);
            assert.deepStrictEqual(args, ['--prefix=/path with space/a.binlog']);
        });

        test('keeps each binlog as a single argv entry across multiple binlogs', () => {
            const args = buildMcpArgs('--binlog ${binlog}', [
                '/has space/a.binlog',
                'C:\\Program Files\\b.binlog',
            ]);
            assert.deepStrictEqual(args, [
                '--binlog', '/has space/a.binlog',
                '--binlog', 'C:\\Program Files\\b.binlog',
            ]);
        });

        test('does not interpret special shell characters from path content', () => {
            // The template substitutes literally; shell semantics are the
            // child-process layer's job. We just verify the value passes
            // through unchanged.
            const tricky = '/tmp/with;semi $var `back`/x.binlog';
            const args = buildMcpArgs('--binlog ${binlog}', [tricky]);
            assert.deepStrictEqual(args, ['--binlog', tricky]);
        });
    });

    suite('buildLaunchArgs', () => {
        test('prepends --envelope before the per-binlog args', () => {
            const args = buildLaunchArgs('--binlog ${binlog}', ['/tmp/a.binlog']);
            assert.deepStrictEqual(args, ['--envelope', '--binlog', '/tmp/a.binlog']);
        });

        test('prepends --envelope once for multiple binlogs', () => {
            const args = buildLaunchArgs('--binlog ${binlog}', ['/a.binlog', '/b.binlog']);
            assert.deepStrictEqual(args, ['--envelope', '--binlog', '/a.binlog', '--binlog', '/b.binlog']);
        });

        test('emits just the launch flags when no binlogs are provided', () => {
            const args = buildLaunchArgs('--binlog ${binlog}', []);
            assert.deepStrictEqual(args, ['--envelope']);
        });

        test('preserves spaces inside binlog paths (delegates to buildMcpArgs)', () => {
            const args = buildLaunchArgs('--binlog ${binlog}', ['C:\\Users\\Has Space\\build.binlog']);
            assert.deepStrictEqual(args, ['--envelope', '--binlog', 'C:\\Users\\Has Space\\build.binlog']);
        });

        test('CONTRACT_LAUNCH_FLAGS is --envelope only (no --grouped)', () => {
            assert.deepStrictEqual([...CONTRACT_LAUNCH_FLAGS], ['--envelope']);
        });
    });
});
