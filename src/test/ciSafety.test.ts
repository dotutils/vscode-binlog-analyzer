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
    isValidRepoIdentifier,
    isValidGitRef,
    isValidArtifactName,
    isValidRunId,
    assertValidRepoIdentifier,
    assertValidGitRef,
    assertValidArtifactName,
    assertValidRunId,
} from '../ciSafety';
import {
    buildLaunchSpec,
    quoteForCmdExe,
    clearCommandResolutionCache,
} from '../commandResolver';

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

suite('ciSafety — command argument allow-lists', () => {

    suite('isValidRepoIdentifier / assertValidRepoIdentifier', () => {
        test('accepts real owners, repos, orgs and projects', () => {
            for (const value of ['dotnet', 'templating', 'My.Repo', 'dnceng-public', 'a_b', 'x1', 'Repo.Name-2']) {
                assert.strictEqual(isValidRepoIdentifier(value), true, `expected ${value} to be accepted`);
                assert.strictEqual(assertValidRepoIdentifier(value, 'repo'), value);
            }
        });
        test('rejects shell metacharacters', () => {
            for (const value of ['repo&calc', 'repo;whoami', 'repo|x', 'repo$(calc)', 'repo`calc`',
                                 'repo>out', 'repo<in', 'repo^x', 'repo%PATH%', 'repo!x', 'repo"x', "repo'x"]) {
                assert.strictEqual(isValidRepoIdentifier(value), false, `expected ${value} to be rejected`);
            }
        });
        test('rejects path separators, whitespace and control characters', () => {
            for (const value of ['a/b', 'a\\b', 'a b', 'a\tb', 'a\nb', 'a\u0000b']) {
                assert.strictEqual(isValidRepoIdentifier(value), false, `expected ${JSON.stringify(value)} to be rejected`);
            }
        });
        test('rejects option injection and traversal', () => {
            assert.strictEqual(isValidRepoIdentifier('-oProxyCommand=calc'), false);
            assert.strictEqual(isValidRepoIdentifier('--repo'), false);
            assert.strictEqual(isValidRepoIdentifier('..'), false);
            assert.strictEqual(isValidRepoIdentifier('.'), false);
        });
        test('rejects empty and non-string values', () => {
            assert.strictEqual(isValidRepoIdentifier(''), false);
            assert.strictEqual(isValidRepoIdentifier(undefined), false);
            assert.strictEqual(isValidRepoIdentifier(null), false);
            assert.strictEqual(isValidRepoIdentifier(42), false);
        });
        test('the error names the offending value and the field', () => {
            assert.throws(
                () => assertValidRepoIdentifier('repo&calc', 'GitHub repository'),
                /GitHub repository.*repo&calc/
            );
        });
    });

    suite('isValidGitRef / assertValidGitRef', () => {
        test('accepts real branch names and refs', () => {
            for (const value of ['main', 'feature/my-branch', 'release/10.0.3xx',
                                 'refs/heads/main', 'refs/pull/12345/merge', 'v1.2.3', 'user/fix-#42']) {
                assert.strictEqual(isValidGitRef(value), true, `expected ${value} to be accepted`);
                assert.strictEqual(assertValidGitRef(value), value);
            }
        });
        test('rejects the verified injection payloads', () => {
            assert.strictEqual(isValidGitRef('main&calc'), false);
            assert.strictEqual(isValidGitRef('main&echo X'), false);
            assert.strictEqual(isValidGitRef('$(calc)'), false);
            assert.strictEqual(isValidGitRef('main|calc'), false);
            assert.strictEqual(isValidGitRef('main;whoami'), false);
            assert.strictEqual(isValidGitRef('main`calc`'), false);
            assert.strictEqual(isValidGitRef('main>out.txt'), false);
            assert.strictEqual(isValidGitRef('%COMSPEC%'), false);
        });
        test('rejects control characters and whitespace', () => {
            assert.strictEqual(isValidGitRef('main\ncalc'), false);
            assert.strictEqual(isValidGitRef('main\rcalc'), false);
            assert.strictEqual(isValidGitRef('main\u0000'), false);
            assert.strictEqual(isValidGitRef('my branch'), false);
        });
        test('rejects option injection and traversal', () => {
            assert.strictEqual(isValidGitRef('--upload-pack=calc'), false);
            assert.strictEqual(isValidGitRef('a/../b'), false);
            assert.strictEqual(isValidGitRef('/main'), false);
            assert.strictEqual(isValidGitRef('main/'), false);
            assert.strictEqual(isValidGitRef(''), false);
        });
        test('the error names the offending value', () => {
            assert.throws(() => assertValidGitRef('main&calc'), /branch.*main&calc/);
        });
    });

    suite('isValidArtifactName / assertValidArtifactName', () => {
        test('accepts realistic artifact names', () => {
            for (const value of ['BuildLogs', 'build_Debug', 'binlogs-net8.0', 'Windows x64 logs', 'logs.zip']) {
                assert.strictEqual(isValidArtifactName(value), true, `expected ${value} to be accepted`);
            }
        });
        test('rejects path separators and traversal', () => {
            assert.strictEqual(isValidArtifactName('a/b'), false);
            assert.strictEqual(isValidArtifactName('a\\b'), false);
            assert.strictEqual(isValidArtifactName('../../etc/passwd'), false);
            assert.strictEqual(isValidArtifactName('..'), false);
        });
        test('rejects shell metacharacters', () => {
            for (const value of ['logs&calc', 'logs;whoami', 'logs|x', 'logs$(calc)', 'logs`calc`',
                                 'logs%PATH%', 'logs!x', 'logs"x', 'logs(1)']) {
                assert.strictEqual(isValidArtifactName(value), false, `expected ${value} to be rejected`);
            }
        });
        test('rejects empty and option-like names', () => {
            assert.strictEqual(isValidArtifactName(''), false);
            assert.strictEqual(isValidArtifactName('-dir'), false);
            assert.strictEqual(isValidArtifactName(undefined), false);
        });
        test('the error names the offending value', () => {
            assert.throws(() => assertValidArtifactName('logs&calc'), /artifact name.*logs&calc/);
        });
    });

    suite('isValidRunId / assertValidRunId', () => {
        test('accepts numeric ids', () => {
            assert.strictEqual(isValidRunId('1354651'), true);
            assert.strictEqual(assertValidRunId('23634010652'), '23634010652');
        });
        test('rejects anything else', () => {
            assert.strictEqual(isValidRunId('123&calc'), false);
            assert.strictEqual(isValidRunId('-1'), false);
            assert.strictEqual(isValidRunId(''), false);
            assert.strictEqual(isValidRunId(123 as unknown as string), false);
        });
    });
});

suite('commandResolver — launching without a shell', () => {
    let tmpDir: string;
    let originalPath: string | undefined;
    let originalPathExt: string | undefined;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlog-cmdresolve-'));
        originalPath = process.env.PATH;
        originalPathExt = process.env.PATHEXT;
        clearCommandResolutionCache();
    });

    teardown(() => {
        if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
        if (originalPathExt === undefined) { delete process.env.PATHEXT; } else { process.env.PATHEXT = originalPathExt; }
        clearCommandResolutionCache();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    });

    test('a real executable is launched directly with an untouched argv', () => {
        const name = 'faketool';
        const file = path.join(tmpDir, process.platform === 'win32' ? `${name}.exe` : name);
        fs.writeFileSync(file, '');
        if (process.platform !== 'win32') { fs.chmodSync(file, 0o755); }
        process.env.PATH = tmpDir;
        process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

        const spec = buildLaunchSpec(name, ['run', 'list', '--branch', 'main&calc']);
        assert.strictEqual(spec.file, file);
        assert.deepStrictEqual(spec.args, ['run', 'list', '--branch', 'main&calc']);
        assert.strictEqual(spec.windowsVerbatimArguments, false);
    });

    test('a .cmd shim runs through cmd.exe with every argument quoted', function() {
        if (process.platform !== 'win32') { this.skip(); return; }
        const shim = path.join(tmpDir, 'faketool.cmd');
        fs.writeFileSync(shim, '@echo off\r\n');
        process.env.PATH = tmpDir;
        process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

        const spec = buildLaunchSpec('faketool', ['run', 'list', '--branch', 'main&calc']);
        assert.ok(/cmd\.exe$/i.test(spec.file), `expected cmd.exe, got ${spec.file}`);
        assert.strictEqual(spec.windowsVerbatimArguments, true);
        assert.deepStrictEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);

        // cmd.exe strips the outermost pair of quotes; what remains must consist
        // exclusively of quoted tokens, so `&` can never act as a separator.
        const inner = spec.args[3].slice(1, -1);
        assert.ok(inner.includes('"main&calc"'), `expected the payload to stay quoted, got ${inner}`);
        assert.strictEqual(inner.replace(/"[^"]*"/g, '').trim(), '');
        assert.ok(inner.includes(`"${shim}"`));
    });

    test('an unresolvable command still never asks for a shell', () => {
        process.env.PATH = path.join(tmpDir, 'nowhere');
        const spec = buildLaunchSpec('definitely-not-installed-xyz', ['--version']);
        assert.strictEqual(spec.file, 'definitely-not-installed-xyz');
        assert.deepStrictEqual(spec.args, ['--version']);
        assert.strictEqual(spec.windowsVerbatimArguments, false);
    });

    test('the current directory is never searched', function() {
        if (process.platform !== 'win32') { this.skip(); return; }
        fs.writeFileSync(path.join(tmpDir, 'planted.exe'), '');
        process.env.PATH = path.join(tmpDir, 'nowhere');
        const originalCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            const spec = buildLaunchSpec('planted', []);
            assert.strictEqual(spec.file, 'planted', 'a binary in the cwd must not be resolved');
        } finally {
            process.chdir(originalCwd);
        }
    });

    suite('quoteForCmdExe', () => {
        test('quotes ordinary arguments', () => {
            assert.strictEqual(quoteForCmdExe('main'), '"main"');
            assert.strictEqual(quoteForCmdExe('a b'), '"a b"');
        });
        test('neutralises cmd.exe separators by quoting them', () => {
            assert.strictEqual(quoteForCmdExe('main&calc'), '"main&calc"');
            assert.strictEqual(quoteForCmdExe('a|b'), '"a|b"');
            assert.strictEqual(quoteForCmdExe('a>b'), '"a>b"');
            assert.strictEqual(quoteForCmdExe('a^b'), '"a^b"');
            assert.strictEqual(quoteForCmdExe('$(calc)'), '"$(calc)"');
        });
        test('doubles trailing backslashes so the closing quote survives', () => {
            assert.strictEqual(quoteForCmdExe('C:\\tmp\\'), '"C:\\tmp\\\\"');
            assert.strictEqual(quoteForCmdExe('C:\\tmp'), '"C:\\tmp"');
        });
        test('refuses characters that cannot be neutralised', () => {
            assert.throws(() => quoteForCmdExe('a"b'), /cannot be passed/);
            assert.throws(() => quoteForCmdExe('%COMSPEC%'), /cannot be passed/);
            assert.throws(() => quoteForCmdExe('a!b!'), /cannot be passed/);
            assert.throws(() => quoteForCmdExe('a\nb'), /cannot be passed/);
            assert.throws(() => quoteForCmdExe('a\u0000b'), /cannot be passed/);
        });
    });
});

suite('ciIntegration — no shell is ever requested', () => {
    /** Strip comments so documentation about the old bug cannot satisfy the check. */
    function stripComments(source: string): string {
        return source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
    }

    function readSource(fileName: string): string {
        const candidates = [
            path.resolve(__dirname, '..', '..', 'src', fileName),
            path.resolve(process.cwd(), 'src', fileName),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) { return fs.readFileSync(candidate, 'utf8'); }
        }
        throw new Error(`Could not locate src/${fileName} (looked in ${candidates.join(', ')})`);
    }

    for (const fileName of ['ciIntegration.ts', 'commandResolver.ts']) {
        test(`${fileName} never passes a shell option to child_process`, () => {
            const source = stripComments(readSource(fileName));
            const match = /\bshell\s*:/.exec(source);
            assert.strictEqual(
                match,
                null,
                `${fileName} must not pass a \`shell\` option — Node does not escape args when a shell is used`
            );
        });
    }

    test('no source file anywhere in src/ enables a shell', () => {
        const srcDir = [
            path.resolve(__dirname, '..', '..', 'src'),
            path.resolve(process.cwd(), 'src'),
        ].find(dir => fs.existsSync(dir));
        assert.ok(srcDir, 'could not locate the src directory');

        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.ts')) { continue; }
                const source = stripComments(fs.readFileSync(full, 'utf8'));
                // `shell: false` is explicit and fine; anything else is not.
                const bad = source.match(/\bshell\s*:\s*(?!false\b)[^,\s}]+/g);
                if (bad) { offenders.push(`${entry.name}: ${bad.join(', ')}`); }
            }
        };
        walk(srcDir!);

        assert.deepStrictEqual(
            offenders,
            [],
            'child_process must never be given a truthy `shell` option (DEP0190: args are not escaped)'
        );
    });

    test('ciIntegration routes every child process through buildLaunchSpec', () => {
        const source = stripComments(readSource('ciIntegration.ts'));
        assert.ok(source.includes('buildLaunchSpec('), 'execCommand must resolve executables explicitly');
        const execFileCalls = source.match(/cp\.execFile\(/g) || [];
        assert.strictEqual(execFileCalls.length, 1, 'expected exactly one execFile call site');
        assert.ok(/cp\.execFile\(\s*spec\.file\s*,/.test(source), 'execFile must launch the resolved executable');
    });
});
