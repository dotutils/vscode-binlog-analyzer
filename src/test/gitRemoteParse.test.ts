import * as assert from 'assert';
import {
    parseGitHubRemote,
    parseGitHubRemoteDetailed,
    parseAzdoRemote,
    classifyGitHubHost,
    splitRemoteUrl,
} from '../gitRemoteParse';

suite('gitRemoteParse', () => {

    suite('splitRemoteUrl', () => {
        test('parses https remotes', () => {
            assert.deepStrictEqual(splitRemoteUrl('https://github.com/owner/repo.git'), {
                hostname: 'github.com',
                pathname: '/owner/repo.git',
            });
        });
        test('parses scp-form remotes', () => {
            assert.deepStrictEqual(splitRemoteUrl('git@github.com:owner/repo.git'), {
                hostname: 'github.com',
                pathname: 'owner/repo.git',
            });
        });
        test('parses ssh:// remotes', () => {
            const parts = splitRemoteUrl('ssh://git@github.com/owner/repo.git');
            assert.strictEqual(parts?.hostname, 'github.com');
        });
        test('does not treat a scheme as a host', () => {
            // `https` has no dot, so the scp-like branch must not claim it.
            assert.strictEqual(splitRemoteUrl('https://github.com/o/r')?.hostname, 'github.com');
        });
        test('rejects bare owner/repo input', () => {
            assert.strictEqual(splitRemoteUrl('dotnet/templating'), null);
            assert.strictEqual(splitRemoteUrl(''), null);
            assert.strictEqual(splitRemoteUrl('   '), null);
        });
        test('rejects non-git protocols', () => {
            assert.strictEqual(splitRemoteUrl('file:///etc/passwd'), null);
            assert.strictEqual(splitRemoteUrl('javascript:alert(1)'), null);
        });
        test('uses the real host, not userinfo', () => {
            assert.strictEqual(splitRemoteUrl('https://github.com@evil.com/o/r')?.hostname, 'evil.com');
        });
    });

    suite('classifyGitHubHost', () => {
        test('recognises github.com and its subdomains', () => {
            assert.strictEqual(classifyGitHubHost('github.com'), 'github');
            assert.strictEqual(classifyGitHubHost('GitHub.COM'), 'github');
            assert.strictEqual(classifyGitHubHost('www.github.com'), 'github');
        });
        test('recognises GitHub Enterprise Server hosts', () => {
            assert.strictEqual(classifyGitHubHost('github.contoso.com'), 'enterprise');
            assert.strictEqual(classifyGitHubHost('github.mycorp.co.uk'), 'enterprise');
        });
        test('rejects look-alike hosts', () => {
            assert.strictEqual(classifyGitHubHost('evil-github.com'), 'other');
            assert.strictEqual(classifyGitHubHost('notgithub.com'), 'other');
            assert.strictEqual(classifyGitHubHost('github.com.attacker.io'), 'other');
            assert.strictEqual(classifyGitHubHost('githubbcom'), 'other');
        });
    });

    suite('parseGitHubRemote — spoofed hosts', () => {
        const spoofed = [
            'https://evil-github.com/attacker/payload',
            'https://notgithub.com/attacker/payload',
            'https://github.com.attacker.io/attacker/payload',
            'https://github.com.attacker.io/attacker/payload.git',
            'git@evil-github.com:attacker/payload.git',
            'https://github.com@evil.com/attacker/payload',
            'https://evil.com/github.com/attacker/payload',
        ];
        for (const remote of spoofed) {
            test(`rejects ${remote}`, () => {
                assert.strictEqual(parseGitHubRemote(remote), null);
                assert.strictEqual(parseGitHubRemoteDetailed(remote).kind, 'none');
            });
        }
    });

    suite('parseGitHubRemote — shell metacharacter payloads', () => {
        const payloads = [
            'https://github.com/owner/repo&calc',
            'https://github.com/owner/repo;whoami',
            'https://github.com/owner/repo|x',
            'https://github.com/owner/repo$(calc)',
            'https://github.com/owner/repo`calc`',
            'https://github.com/own er/repo',
            'https://github.com/owner&calc/repo',
            'git@github.com:owner/repo&calc.git',
        ];
        for (const remote of payloads) {
            test(`rejects ${remote}`, () => {
                assert.strictEqual(parseGitHubRemote(remote), null);
            });
        }

        test('rejects percent-encoded metacharacters', () => {
            // %26 decodes to `&` — it must not survive as an argument.
            assert.strictEqual(parseGitHubRemote('https://github.com/owner/repo%26calc'), null);
            assert.strictEqual(parseGitHubRemote('https://github.com/owner/repo%2Fnested'), null);
        });

        test('rejects leading-dash owners (option injection)', () => {
            assert.strictEqual(parseGitHubRemote('https://github.com/-oProxyCommand/repo'), null);
        });
    });

    suite('parseGitHubRemote — legitimate remotes', () => {
        test('https with .git suffix', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/dotnet/templating.git'),
                { owner: 'dotnet', repo: 'templating' }
            );
        });
        test('https without .git suffix', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/dotnet/templating'),
                { owner: 'dotnet', repo: 'templating' }
            );
        });
        test('trailing slash', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/dotnet/templating/'),
                { owner: 'dotnet', repo: 'templating' }
            );
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/dotnet/templating.git/'),
                { owner: 'dotnet', repo: 'templating' }
            );
        });
        test('scp form', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('git@github.com:owner/repo.git'),
                { owner: 'owner', repo: 'repo' }
            );
        });
        test('ssh:// form', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('ssh://git@github.com/owner/repo.git'),
                { owner: 'owner', repo: 'repo' }
            );
        });
        test('dotted repo names survive', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/My.Org/My.Repo'),
                { owner: 'My.Org', repo: 'My.Repo' }
            );
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/dotnet/dotnet.github.io'),
                { owner: 'dotnet', repo: 'dotnet.github.io' }
            );
        });
        test('deep URLs (Actions run links)', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/dotnet/templating/actions/runs/12345'),
                { owner: 'dotnet', repo: 'templating' }
            );
        });
        test('scheme-less github.com URLs', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('github.com/dotnet/templating'),
                { owner: 'dotnet', repo: 'templating' }
            );
        });
        test('query strings and fragments are ignored', () => {
            assert.deepStrictEqual(
                parseGitHubRemote('https://github.com/dotnet/templating?tab=readme#top'),
                { owner: 'dotnet', repo: 'templating' }
            );
        });
    });

    suite('parseGitHubRemoteDetailed — GitHub Enterprise', () => {
        test('reports Enterprise hosts explicitly rather than "not found"', () => {
            const result = parseGitHubRemoteDetailed('https://github.contoso.com/owner/repo.git');
            assert.strictEqual(result.kind, 'enterprise');
            if (result.kind === 'enterprise') {
                assert.strictEqual(result.host, 'github.contoso.com');
            }
        });
        test('Enterprise remotes stay unsupported', () => {
            assert.strictEqual(parseGitHubRemote('https://github.contoso.com/owner/repo.git'), null);
            assert.strictEqual(parseGitHubRemote('git@github.contoso.com:owner/repo.git'), null);
        });
        test('look-alikes are not misreported as Enterprise', () => {
            assert.strictEqual(parseGitHubRemoteDetailed('https://github.com.attacker.io/o/r').kind, 'none');
            assert.strictEqual(parseGitHubRemoteDetailed('https://evil-github.com/o/r').kind, 'none');
        });
    });

    suite('parseAzdoRemote', () => {
        test('dev.azure.com https remotes', () => {
            assert.deepStrictEqual(
                parseAzdoRemote('https://dev.azure.com/dnceng-public/public/_git/dotnet-runtime'),
                { org: 'dnceng-public', project: 'public' }
            );
            assert.deepStrictEqual(
                parseAzdoRemote('https://dev.azure.com/dnceng-public/public/_build/results?buildId=1354651'),
                { org: 'dnceng-public', project: 'public' }
            );
        });
        test('ssh.dev.azure.com scp remotes', () => {
            assert.deepStrictEqual(
                parseAzdoRemote('git@ssh.dev.azure.com:v3/myorg/myproject/myrepo'),
                { org: 'myorg', project: 'myproject' }
            );
        });
        test('legacy visualstudio.com remotes', () => {
            assert.deepStrictEqual(
                parseAzdoRemote('https://contoso.visualstudio.com/MyProject/_git/MyRepo'),
                { org: 'contoso', project: 'MyProject' }
            );
            assert.deepStrictEqual(
                parseAzdoRemote('https://contoso.visualstudio.com/DefaultCollection/MyProject/_git/MyRepo'),
                { org: 'contoso', project: 'MyProject' }
            );
        });
        test('rejects spoofed Azure DevOps hosts', () => {
            assert.strictEqual(parseAzdoRemote('https://evil-dev.azure.com/org/project/_git/r'), null);
            assert.strictEqual(parseAzdoRemote('https://dev.azure.com.attacker.io/org/project/_git/r'), null);
            assert.strictEqual(parseAzdoRemote('https://notvisualstudio.com/org/project/_git/r'), null);
            assert.strictEqual(parseAzdoRemote('https://contoso.visualstudio.com.attacker.io/p/_git/r'), null);
            assert.strictEqual(parseAzdoRemote('https://evil.com/dev.azure.com/org/project'), null);
        });
        test('rejects shell metacharacter payloads', () => {
            assert.strictEqual(parseAzdoRemote('https://dev.azure.com/org&calc/project/_git/r'), null);
            assert.strictEqual(parseAzdoRemote('https://dev.azure.com/org/project;whoami/_git/r'), null);
            assert.strictEqual(parseAzdoRemote('https://dev.azure.com/org/project|x'), null);
            assert.strictEqual(parseAzdoRemote('https://contoso.visualstudio.com/proj$(calc)/_git/r'), null);
        });
        test('rejects route markers as org/project', () => {
            assert.strictEqual(parseAzdoRemote('https://dev.azure.com/org/_git/repo'), null);
            assert.strictEqual(parseAzdoRemote('https://dev.azure.com/org'), null);
        });
        test('rejects GitHub remotes', () => {
            assert.strictEqual(parseAzdoRemote('https://github.com/owner/repo.git'), null);
        });
    });
});
