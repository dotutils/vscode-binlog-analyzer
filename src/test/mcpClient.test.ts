import * as assert from 'assert';
import { buildMcpArgs } from '../mcpArgs';

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
    });
});
