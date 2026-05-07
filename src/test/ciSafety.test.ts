import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    isAllowedRedirectHost,
    isAllowedRedirectUrl,
    safeBasename,
    psSingleQuote,
    assertNoZipSlip,
} from '../ciSafety';

suite('ciSafety', () => {

    suite('isAllowedRedirectHost', () => {
        test('allows known GitHub hosts', () => {
            assert.strictEqual(isAllowedRedirectHost('github.com'), true);
            assert.strictEqual(isAllowedRedirectHost('api.github.com'), true);
            assert.strictEqual(isAllowedRedirectHost('raw.githubusercontent.com'), true);
            assert.strictEqual(isAllowedRedirectHost('pipelines.actions.githubusercontent.com'), true);
        });
        test('allows known Azure DevOps and storage hosts', () => {
            assert.strictEqual(isAllowedRedirectHost('dev.azure.com'), true);
            assert.strictEqual(isAllowedRedirectHost('contoso.visualstudio.com'), true);
            assert.strictEqual(isAllowedRedirectHost('myacct.blob.core.windows.net'), true);
        });
        test('is case-insensitive', () => {
            assert.strictEqual(isAllowedRedirectHost('GITHUB.COM'), true);
            assert.strictEqual(isAllowedRedirectHost('Api.GitHub.Com'), true);
        });
        test('rejects unknown hosts', () => {
            assert.strictEqual(isAllowedRedirectHost('evil.com'), false);
            assert.strictEqual(isAllowedRedirectHost('github.com.evil.com'), false);
            assert.strictEqual(isAllowedRedirectHost('notgithub.com'), false);
            assert.strictEqual(isAllowedRedirectHost(''), false);
        });
        test('rejects suffix-look-alike hosts', () => {
            // Must be exact host or `.suffix` — not `xgithub.com`
            assert.strictEqual(isAllowedRedirectHost('xgithub.com'), false);
            assert.strictEqual(isAllowedRedirectHost('xdev.azure.com'), false);
        });
    });

    suite('isAllowedRedirectUrl', () => {
        test('accepts https URLs to known hosts', () => {
            assert.strictEqual(isAllowedRedirectUrl('https://api.github.com/repos/x/y'), true);
            assert.strictEqual(isAllowedRedirectUrl('https://myacct.blob.core.windows.net/c/x.zip'), true);
        });
        test('accepts http URLs to known hosts', () => {
            assert.strictEqual(isAllowedRedirectUrl('http://github.com/x'), true);
        });
        test('rejects non-http(s) protocols', () => {
            assert.strictEqual(isAllowedRedirectUrl('file:///etc/passwd'), false);
            assert.strictEqual(isAllowedRedirectUrl('ftp://github.com'), false);
            assert.strictEqual(isAllowedRedirectUrl('javascript:alert(1)'), false);
        });
        test('rejects malformed URLs', () => {
            assert.strictEqual(isAllowedRedirectUrl(''), false);
            assert.strictEqual(isAllowedRedirectUrl('not a url'), false);
        });
        test('rejects untrusted hosts', () => {
            assert.strictEqual(isAllowedRedirectUrl('https://evil.com/x'), false);
        });
    });

    suite('safeBasename', () => {
        test('returns the basename for a normal name', () => {
            assert.strictEqual(safeBasename('build-output'), 'build-output');
            assert.strictEqual(safeBasename('logs.zip'), 'logs.zip');
        });
        test('strips parent-directory traversal', () => {
            const out = safeBasename('../../etc/passwd');
            assert.ok(!out.includes('..'), `expected '..' to be stripped, got ${out}`);
            assert.ok(!out.includes('/'), `expected '/' to be stripped, got ${out}`);
        });
        test('strips embedded path separators', () => {
            assert.ok(!safeBasename('a/b/c').includes('/'));
            assert.ok(!safeBasename('a\\b\\c').includes('\\'));
        });
        test('handles Windows drive prefixes', () => {
            const out = safeBasename('C:\\Windows\\evil.exe');
            assert.ok(!out.includes('\\'), `expected '\\' to be stripped, got ${out}`);
            assert.ok(!out.includes('/'), `expected '/' to be stripped, got ${out}`);
        });
        test('rejects empty names', () => {
            assert.throws(() => safeBasename(''));
        });
        test('sanitizes pure-traversal names to a safe placeholder', () => {
            // We don't require throwing — '..' and '/' just need to never
            // produce a value containing path separators or '..'.
            const dotdot = safeBasename('..');
            assert.ok(!dotdot.includes('..'));
            assert.ok(!dotdot.includes('/'));
            assert.ok(!dotdot.includes('\\'));
            assert.ok(dotdot.length > 0);
        });
        test('prefixes Windows reserved device names', () => {
            assert.strictEqual(safeBasename('CON'), '_CON');
            assert.strictEqual(safeBasename('com1.txt'), '_com1.txt');
            assert.strictEqual(safeBasename('NUL'), '_NUL');
        });
    });

    suite('psSingleQuote', () => {
        test('wraps simple paths in single quotes', () => {
            assert.strictEqual(psSingleQuote('C:\\Users\\x.zip'), "'C:\\Users\\x.zip'");
        });
        test('escapes single quotes by doubling', () => {
            assert.strictEqual(psSingleQuote("a'b"), "'a''b'");
            assert.strictEqual(psSingleQuote("'leading'and'trailing'"), "'''leading''and''trailing'''");
        });
        test('does not escape double quotes or backticks', () => {
            // PowerShell single-quoted strings treat ", `, $ as literal.
            assert.strictEqual(psSingleQuote('a"b`c$d'), "'a\"b`c$d'");
        });
    });

    suite('assertNoZipSlip', () => {
        let tmpRoot: string;
        setup(() => {
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'binlog-zipslip-'));
        });
        teardown(() => {
            try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
        });

        test('passes when all files are inside the extract dir', () => {
            const dir = path.join(tmpRoot, 'good');
            fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'a.binlog'), 'x');
            fs.writeFileSync(path.join(dir, 'sub', 'b.binlog'), 'y');
            assert.doesNotThrow(() => assertNoZipSlip(dir));
        });

        test('passes for an empty directory', () => {
            const dir = path.join(tmpRoot, 'empty');
            fs.mkdirSync(dir);
            assert.doesNotThrow(() => assertNoZipSlip(dir));
        });

        test('throws when a symlink escapes the extract dir', function() {
            // Symlink creation requires admin on Windows and is gated behind
            // SeCreateSymbolicLinkPrivilege; skip if it fails.
            const dir = path.join(tmpRoot, 'evil');
            const outside = path.join(tmpRoot, 'outside.txt');
            fs.mkdirSync(dir);
            fs.writeFileSync(outside, 'secret');
            try {
                fs.symlinkSync(outside, path.join(dir, 'leak.txt'), 'file');
            } catch (e: any) {
                if (e.code === 'EPERM' || e.code === 'EACCES') {
                    this.skip();
                    return;
                }
                throw e;
            }
            assert.throws(() => assertNoZipSlip(dir), /escapes extract directory/);
        });
    });
});
