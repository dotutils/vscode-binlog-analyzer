import * as assert from 'assert';
import {
    unwrapToolResultText,
    isSupportedMajor,
    OLD_SERVER_MESSAGE,
    ENVELOPE_CONTRACT_TOOLS,
    initFailureMessage,
} from '../envelope';

// These shapes mirror real `binlog-mcp --envelope` output captured over stdio
// (overview = object data; errors/warnings/projects = array data; expensive_*
// = bare JSON arrays that are NOT enveloped). See the unwrap boundary in
// mcpClient.callTool.

suite('envelope', () => {
    suite('isSupportedMajor', () => {
        test('accepts major 1', () => {
            assert.strictEqual(isSupportedMajor('1.0.0'), true);
            assert.strictEqual(isSupportedMajor('1.4.2'), true);
        });
        test('rejects major 2 (grouped) and non-numeric', () => {
            assert.strictEqual(isSupportedMajor('2.0.0'), false);
            assert.strictEqual(isSupportedMajor('abc'), false);
        });
    });

    suite('unwrapToolResultText — envelope present', () => {
        test('unwraps object data (overview) to its inner JSON text', () => {
            const data = { succeeded: false, duration: '00:01:27.04', errorCount: 3 };
            const envelope = JSON.stringify({ schemaVersion: '1.0.0', kind: 'overview', data });
            const out = unwrapToolResultText('binlog_overview', envelope);
            assert.deepStrictEqual(JSON.parse(out), data);
        });

        test('unwraps array data (errors) to a bare array, matching legacy v1', () => {
            const data = [{ severity: 'error', code: 'FS0001', message: 'boom' }];
            const envelope = JSON.stringify({ schemaVersion: '1.2.0', kind: 'errors', data });
            const out = unwrapToolResultText('binlog_errors', envelope);
            assert.deepStrictEqual(JSON.parse(out), data);
        });

        test('throws when the envelope carries a server-side error', () => {
            const envelope = JSON.stringify({
                schemaVersion: '1.0.0', kind: 'projects',
                error: { code: 'BINLOG_NOT_LOADED', message: 'no binlog' },
            });
            assert.throws(
                () => unwrapToolResultText('binlog_projects', envelope),
                /BINLOG_NOT_LOADED: no binlog/
            );
        });

        test('throws on an unsupported (grouped) major version', () => {
            const envelope = JSON.stringify({ schemaVersion: '2.0.0', kind: 'errors', data: [] });
            assert.throws(
                () => unwrapToolResultText('binlog_errors', envelope),
                /Unsupported binlog-mcp envelope schemaVersion '2.0.0'/
            );
        });

        test('throws when an envelope omits data', () => {
            const envelope = JSON.stringify({ schemaVersion: '1.0.0', kind: 'overview' });
            assert.throws(
                () => unwrapToolResultText('binlog_overview', envelope),
                /contained no data/
            );
        });
    });

    suite('unwrapToolResultText — passthrough (not enveloped)', () => {
        test('passes bare JSON from a non-contract tool through unchanged', () => {
            const bare = JSON.stringify([{ targetName: 'CoreCompile', totalExclusiveMs: 124304 }]);
            assert.strictEqual(unwrapToolResultText('binlog_expensive_targets', bare), bare);
        });

        test('passes plain text from a non-contract tool through unchanged', () => {
            const text = 'No results found for the given search.';
            assert.strictEqual(unwrapToolResultText('binlog_search', text), text);
        });
    });

    suite('unwrapToolResultText — old-server detection', () => {
        test('throws for a contract tool that returns a bare v1 array', () => {
            // Legacy server: binlog_errors -> bare array, no schemaVersion.
            const bare = JSON.stringify([{ severity: 'error', message: 'boom' }]);
            assert.throws(() => unwrapToolResultText('binlog_errors', bare), new RegExp(escapeRegExp(OLD_SERVER_MESSAGE)));
        });

        test('throws for a contract tool that returns legacy prose (overview/compare)', () => {
            const prose = 'Build: FAILED\nDuration: 87.0s\nProjects: 7  Errors: 3  Warnings: 2';
            assert.throws(() => unwrapToolResultText('binlog_overview', prose), new RegExp(escapeRegExp(OLD_SERVER_MESSAGE)));
        });

        test('every contract tool is covered by the old-server guard', () => {
            const bareArray = '[]';
            for (const tool of ENVELOPE_CONTRACT_TOOLS) {
                assert.throws(
                    () => unwrapToolResultText(tool, bareArray),
                    new RegExp(escapeRegExp(OLD_SERVER_MESSAGE)),
                    `expected old-server error for ${tool}`
                );
            }
        });
    });

    suite('initFailureMessage', () => {
        test('returns the generic message when the process never exited (undefined)', () => {
            const msg = initFailureMessage(undefined);
            assert.match(msg, /Failed to initialize MCP server after 5 attempts/);
            // Must NOT mislead the user toward a server update when the process
            // is still up but unresponsive.
            assert.doesNotMatch(msg, /too old/);
        });

        test('surfaces the actionable old-server update on a non-zero startup exit', () => {
            const msg = initFailureMessage(1);
            assert.match(msg, /exited during startup \(exit code 1\)/);
            assert.match(msg, /too old to support --envelope/);
            assert.match(msg, /dotnet tool update -g Microsoft\.AITools\.BinlogMcp/);
        });

        test('treats a clean (zero) startup exit as a likely old server too', () => {
            // An old server that prints help for an unknown flag may exit 0; the
            // process is still gone, so the update hint is the right guidance.
            assert.match(initFailureMessage(0), /exited during startup \(exit code 0\)/);
        });

        test('reports an unknown exit code when terminated by a signal (null)', () => {
            assert.match(initFailureMessage(null), /exit code unknown/);
        });
    });
});

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
