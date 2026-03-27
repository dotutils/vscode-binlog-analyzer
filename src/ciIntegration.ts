import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CiBuild {
    id: string;
    label: string;
    description: string;
    detail?: string;
    source: 'azdo' | 'github';
    artifactDownloadArgs: string[];
}

interface CiArtifact {
    name: string;
    size?: number;
    downloadUrl?: string;
    source: 'azdo' | 'github';
}

// ─── Azure DevOps ────────────────────────────────────────────────────────────

async function execCommand(cmd: string, args: string[], cwd?: string, timeoutMs: number = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        // Strip GITHUB_TOKEN from env to avoid interfering with gh CLI keyring auth
        const env = { ...process.env };
        if (cmd === 'gh') { delete env.GITHUB_TOKEN; }
        cp.execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, shell: true, env }, (err, stdout, stderr) => {
            resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err as any).code ?? 1 : 0 });
        });
    });
}

async function isAzCliAvailable(): Promise<boolean> {
    const result = await execCommand('az', ['--version']);
    return result.code === 0;
}

async function isGhCliAvailable(): Promise<boolean> {
    const result = await execCommand('gh', ['--version']);
    return result.code === 0;
}

/** Detect Azure DevOps org/project from any Azure DevOps URL */
function parseAzdoRemote(remoteUrl: string): { org: string; project: string } | null {
    // HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}
    let m = remoteUrl.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git/);
    if (m) { return { org: m[1], project: m[2] }; }

    // General AzDO URL: https://dev.azure.com/{org}/{project}/...
    m = remoteUrl.match(/dev\.azure\.com\/([^/]+)\/([^/?]+)/);
    if (m) { return { org: m[1], project: m[2] }; }

    // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    m = remoteUrl.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\//);
    if (m) { return { org: m[1], project: m[2] }; }

    // Old VSTS: https://{org}.visualstudio.com/{project}/_git/{repo}
    m = remoteUrl.match(/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git/);
    if (m) { return { org: m[1], project: m[2] }; }

    // Old VSTS general: https://{org}.visualstudio.com/{project}/...
    m = remoteUrl.match(/([^/.]+)\.visualstudio\.com\/([^/?]+)/);
    if (m) { return { org: m[1], project: m[2] }; }

    return null;
}

/** Detect GitHub owner/repo from git remote URL */
function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
    // HTTPS: https://github.com/{owner}/{repo}.git
    let m = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (m) { return { owner: m[1], repo: m[2] }; }
    return null;
}

async function getGitRemoteUrl(cwd?: string): Promise<string> {
    const result = await execCommand('git', ['remote', 'get-url', 'origin'], cwd);
    return result.stdout.trim();
}

async function getGitBranch(cwd?: string): Promise<string> {
    const result = await execCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    return result.stdout.trim();
}

interface AzdoPipeline {
    id: number;
    name: string;
    folder: string;
}

async function listAzdoPipelines(org: string, project: string): Promise<AzdoPipeline[]> {
    const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/pipelines?api-version=7.0`;
    try {
        const data = await httpsGetJson(apiUrl);
        const pipelines = data.value || [];
        return pipelines.map((p: any) => ({
            id: p.id,
            name: p.name,
            folder: p.folder || '',
        }));
    } catch {
        // Fallback to az CLI if REST fails (private projects)
        try {
            const result = await execCommand('az', [
                'pipelines', 'list',
                '--org', `https://dev.azure.com/${org}`,
                '--project', project,
                '--output', 'json',
            ]);
            if (result.code !== 0) { return []; }
            const pipelines = JSON.parse(result.stdout);
            return pipelines.map((p: any) => ({ id: p.id, name: p.name, folder: p.folder || '' }));
        } catch { return []; }
    }
}

async function listAzdoBuilds(org: string, project: string, opts?: { pipelineId?: number; branch?: string; top?: number }): Promise<CiBuild[]> {
    const top = opts?.top ?? 20;
    let apiUrl = `https://dev.azure.com/${org}/${project}/_apis/build/builds?api-version=7.0&%24top=${top}&queryOrder=finishTimeDescending`;
    if (opts?.pipelineId !== undefined) {
        apiUrl += `&definitions=${opts.pipelineId}`;
    }
    if (opts?.branch) {
        apiUrl += `&branchName=${encodeURIComponent(opts.branch.startsWith('refs/') ? opts.branch : `refs/heads/${opts.branch}`)}`;
    }

    let runs: any[] = [];
    try {
        const data = await httpsGetJson(apiUrl);
        runs = data.value || [];
    } catch (restErr) {
        // Fallback to az CLI
        const args = [
            'pipelines', 'runs', 'list',
            '--org', `https://dev.azure.com/${org}`,
            '--project', project,
            '--top', String(top),
            '--output', 'json',
        ];
        if (opts?.pipelineId !== undefined) {
            args.push('--pipeline-ids', String(opts.pipelineId));
        }
        if (opts?.branch) {
            args.push('--branch', opts.branch.startsWith('refs/') ? opts.branch : `refs/heads/${opts.branch}`);
        }
        const result = await execCommand('az', args);
        if (result.code !== 0) {
            const restMsg = restErr instanceof Error ? restErr.message : String(restErr);
            throw new Error(
                `Could not list builds. REST API: ${restMsg}` +
                (result.stderr ? `. az CLI: ${result.stderr.substring(0, 200)}` : '. az CLI not available or failed.')
            );
        }
        try {
            runs = JSON.parse(result.stdout);
        } catch {
            throw new Error('az CLI returned invalid JSON');
        }
    }

    return runs.map((run: any) => {
        const branch = (run.sourceBranch || '').replace('refs/heads/', '').replace('refs/pull/', 'PR ');
        const prTitle = run.triggerInfo?.['pr.title'];
        const buildNum = run.buildNumber || '';
        const title = prTitle || buildNum;
        return {
            id: String(run.id),
            label: `#${run.id} — ${run.definition?.name || 'Build'}`,
            description: `${run.result || run.status} · ${branch}`,
            detail: [
                new Date(run.finishTime || run.startTime || run.queueTime).toLocaleString(),
                title,
            ].filter(Boolean).join(' · '),
            source: 'azdo' as const,
            artifactDownloadArgs: [org, project, String(run.id)],
        };
    });
}

async function downloadAzdoArtifact(org: string, project: string, runId: string, artifactName: string, destDir: string): Promise<string[]> {
    // Try direct ZIP download first (works for public projects without az CLI)
    const zipUrl = `https://dev.azure.com/${org}/${project}/_apis/build/builds/${runId}/artifacts?artifactName=${encodeURIComponent(artifactName)}&api-version=7.0&%24format=zip`;
    const zipPath = path.join(destDir, `${artifactName}.zip`);

    try {
        await httpsDownloadFile(zipUrl, zipPath);
        const extractDir = path.join(destDir, artifactName);
        fs.mkdirSync(extractDir, { recursive: true });
        const extractResult = await execCommand('powershell', [
            '-NoProfile', '-Command',
            `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
        ], undefined, 120000);
        if (extractResult.code === 0) {
            try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
            return findBinlogFiles(extractDir);
        }
        // Extraction failed — clean up bad zip
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    } catch {
        // Clean up any partial download
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    }

    // Fallback: az CLI download (handles auth for private projects)
    const result = await execCommand('az', [
        'pipelines', 'runs', 'artifact', 'download',
        '--org', `https://dev.azure.com/${org}`,
        '--project', project,
        '--run-id', runId,
        '--artifact-name', artifactName,
        '--path', destDir,
    ], undefined, 120000);
    if (result.code !== 0) {
        throw new Error(
            result.stderr.includes('azure-devops')
                ? `az CLI needs the azure-devops extension. Run: az extension add --name azure-devops`
                : `Failed to download artifact: ${result.stderr.substring(0, 300)}`
        );
    }

    return findBinlogFiles(destDir);
}

async function listAzdoArtifacts(org: string, project: string, runId: string): Promise<CiArtifact[]> {
    const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/build/builds/${runId}/artifacts?api-version=7.0`;
    const errors: string[] = [];

    // Try az rest first (works for authenticated users)
    let artifacts: any[] = [];
    try {
        const azResult = await execCommand('az', [
            'rest', '--method', 'get', '--uri', apiUrl,
            '--resource', '499b84ac-1321-427f-aa17-267ca6975798',
            '--output', 'json',
        ]);
        if (azResult.code === 0 && azResult.stdout.trim().startsWith('{')) {
            const data = JSON.parse(azResult.stdout);
            artifacts = data.value || [];
        } else {
            errors.push(`az rest: code=${azResult.code}, stderr=${(azResult.stderr || '').substring(0, 100)}`);
        }
    } catch (e) {
        errors.push(`az rest: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Fallback: unauthenticated HTTPS fetch (works for public projects)
    if (artifacts.length === 0) {
        try {
            const json = await httpsGetJson(apiUrl);
            artifacts = json?.value || [];
        } catch (e) {
            errors.push(`HTTPS: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Last fallback: az pipelines runs artifact list
    if (artifacts.length === 0) {
        try {
            const cliResult = await execCommand('az', [
                'pipelines', 'runs', 'artifact', 'list',
                '--org', `https://dev.azure.com/${org}`,
                '--project', project,
                '--run-id', runId,
                '--output', 'json',
            ]);
            if (cliResult.code === 0 && cliResult.stdout.trim()) {
                artifacts = JSON.parse(cliResult.stdout);
            } else {
                errors.push(`az pipelines: code=${cliResult.code}, stderr=${(cliResult.stderr || '').substring(0, 100)}`);
            }
        } catch (e) {
            errors.push(`az pipelines: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (artifacts.length === 0 && errors.length > 0) {
        throw new Error(`All artifact listing strategies failed:\n${errors.join('\n')}`);
    }

    return artifacts.map((a: any) => ({
        name: a.name,
        size: parseInt(a.resource?.properties?.artifactsize || a.size_in_bytes || '0', 10),
        source: 'azdo' as const,
    }));
}

// ─── GitHub Actions ──────────────────────────────────────────────────────────

async function listGitHubRuns(owner: string, repo: string, top: number = 20, branch?: string): Promise<CiBuild[]> {
    const args = [
        'run', 'list',
        '--repo', `${owner}/${repo}`,
        '--limit', String(top),
        '--json', 'databaseId,displayTitle,status,conclusion,headBranch,createdAt,workflowName',
    ];
    if (branch) {
        args.push('--branch', branch);
    }
    const result = await execCommand('gh', args);
    if (result.code !== 0) {
        throw new Error(`gh run list failed: ${result.stderr.substring(0, 300)}`);
    }

    let runs: any[];
    try {
        runs = JSON.parse(result.stdout);
    } catch {
        throw new Error('gh CLI returned invalid JSON');
    }

    return runs.map((run: any) => ({
        id: String(run.databaseId),
        label: `#${run.databaseId} — ${run.workflowName || 'Workflow'}`,
        description: `${run.conclusion || run.status} · ${run.headBranch || ''}`,
        detail: `${run.displayTitle || ''} · ${run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}`,
        source: 'github' as const,
        artifactDownloadArgs: [owner, repo, String(run.databaseId)],
    }));
}

async function listGitHubArtifacts(owner: string, repo: string, runId: string): Promise<CiArtifact[]> {
    // Use full JSON output instead of jq for robustness
    const result = await execCommand('gh', [
        'api', `repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
    ]);

    if (result.code !== 0) {
        throw new Error(`Failed to list artifacts: ${result.stderr.substring(0, 300)}`);
    }

    let data: any;
    try {
        data = JSON.parse(result.stdout);
    } catch {
        throw new Error('gh api returned invalid JSON');
    }

    const artifacts = data.artifacts || [];
    return artifacts.map((a: any) => ({
        name: a.name,
        size: a.size_in_bytes,
        source: 'github' as const,
    }));
}

async function downloadGitHubArtifact(owner: string, repo: string, runId: string, artifactName: string, destDir: string): Promise<string[]> {
    const result = await execCommand('gh', [
        'run', 'download', runId,
        '--repo', `${owner}/${repo}`,
        '--name', artifactName,
        '--dir', destDir,
    ], undefined, 120000);
    if (result.code !== 0) {
        // Clean up empty directory on failure
        try { fs.rmdirSync(destDir); } catch { /* ignore */ }
        throw new Error(`Failed to download artifact: ${result.stderr.substring(0, 300)}`);
    }

    return findBinlogFiles(destDir);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findBinlogFiles(dir: string): string[] {
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...findBinlogFiles(fullPath));
            } else if (entry.name.endsWith('.binlog')) {
                results.push(fullPath);
            }
        }
    } catch { /* skip unreadable dirs */ }
    return results;
}

function getDownloadDir(): string {
    const dir = path.join(os.tmpdir(), 'binlog-analyzer-ci');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/** Simple HTTPS GET that returns parsed JSON. Works without auth for public APIs. */
function httpsGetJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('http://') ? http : https;
        proto.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Reject sign-in redirects (Azure DevOps private projects redirect to login)
                if (res.headers.location.includes('_signin') || res.headers.location.includes('login')) {
                    reject(new Error('Authentication required (redirected to sign-in page)'));
                    return;
                }
                httpsGetJson(res.headers.location).then(resolve, reject);
                return;
            }
            if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Invalid JSON response (got ${data.substring(0, 50)}...)`)); }
            });
        }).on('error', reject);
    });
}

/** Download a file via HTTPS to a local path. Follows redirects. Rejects on auth redirects. */
function httpsDownloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const doRequest = (reqUrl: string, redirectCount: number = 0) => {
            if (redirectCount > 5) {
                reject(new Error('Too many redirects'));
                return;
            }
            const proto = reqUrl.startsWith('http://') ? http : https;
            proto.get(reqUrl, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (res.headers.location.includes('_signin') || res.headers.location.includes('login')) {
                        reject(new Error('Authentication required (redirected to sign-in page)'));
                        return;
                    }
                    doRequest(res.headers.location, redirectCount + 1);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                // Verify we're getting binary data, not an HTML error page
                const contentType = res.headers['content-type'] || '';
                if (contentType.includes('text/html')) {
                    reject(new Error('Received HTML instead of file — likely an auth page'));
                    return;
                }
                const fileStream = fs.createWriteStream(destPath);
                res.pipe(fileStream);
                fileStream.on('finish', () => { fileStream.close(); resolve(); });
                fileStream.on('error', (err) => {
                    fs.unlink(destPath, () => {}); // Clean up partial file
                    reject(err);
                });
            }).on('error', reject);
        };
        doRequest(url);
    });
}

/** Extract numeric build/run ID from a raw string (URL or plain number) */
function extractBuildId(input: string): string | null {
    // Plain number
    if (/^\d+$/.test(input)) { return input; }

    // Azure DevOps: .../_build/results?buildId=1354651
    let m = input.match(/buildId=(\d+)/);
    if (m) { return m[1]; }

    // Azure DevOps: .../_build?definitionId=...&_a=summary (not a run ID — skip)
    // GitHub Actions: .../actions/runs/23634010652
    m = input.match(/\/actions\/runs\/(\d+)/);
    if (m) { return m[1]; }

    // Last resort: find any number sequence >= 4 digits
    m = input.match(/(\d{4,})/);
    if (m) { return m[1]; }

    return null;
}

// ─── Main Command ────────────────────────────────────────────────────────────

let ciDownloadInProgress = false;
let extensionContext: vscode.ExtensionContext | undefined;

/** Set the extension context for persistent storage (call from activate) */
export function setCiContext(ctx: vscode.ExtensionContext) {
    extensionContext = ctx;
}

function getRecentAzdoOrgs(): string[] {
    const wsKey = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || 'default';
    return extensionContext?.workspaceState.get<string[]>(`ci.recentAzdoOrgs.${wsKey}`, []) || [];
}

function saveRecentAzdoOrg(orgProject: string) {
    const wsKey = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || 'default';
    const recent = getRecentAzdoOrgs().filter(o => o !== orgProject);
    recent.unshift(orgProject);
    extensionContext?.workspaceState.update(`ci.recentAzdoOrgs.${wsKey}`, recent.slice(0, 5));
}

function getRecentGhRepos(): string[] {
    const wsKey = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || 'default';
    return extensionContext?.workspaceState.get<string[]>(`ci.recentGhRepos.${wsKey}`, []) || [];
}

function saveRecentGhRepo(ownerRepo: string) {
    const wsKey = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || 'default';
    const recent = getRecentGhRepos().filter(o => o !== ownerRepo);
    recent.unshift(ownerRepo);
    extensionContext?.workspaceState.update(`ci.recentGhRepos.${wsKey}`, recent.slice(0, 5));
}

export async function downloadCiBinlog(): Promise<string[] | undefined> {
    if (ciDownloadInProgress) {
        vscode.window.showInformationMessage('CI download already in progress...');
        return;
    }
    ciDownloadInProgress = true;
    try {
        return await doDownloadCiBinlog();
    } finally {
        ciDownloadInProgress = false;
    }
}

async function doDownloadCiBinlog(): Promise<string[] | undefined> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const remoteUrl = await getGitRemoteUrl(cwd);

    const azdoInfo = remoteUrl ? parseAzdoRemote(remoteUrl) : null;
    const ghInfo = remoteUrl ? parseGitHubRemote(remoteUrl) : null;

    // Always let user choose platform — repos often have CI on a different platform
    const platformPick = await vscode.window.showQuickPick(
        [
            {
                label: '$(github) GitHub Actions',
                value: 'github' as const,
                description: ghInfo ? `${ghInfo.owner}/${ghInfo.repo}` : '',
            },
            {
                label: '$(cloud) Azure DevOps',
                value: 'azdo' as const,
                description: azdoInfo ? `${azdoInfo.org}/${azdoInfo.project}` : '',
            },
        ],
        { placeHolder: 'Select CI/CD platform' }
    );
    if (!platformPick) { return; }
    const source = platformPick.value;

    // For AzDO: if not detected from remote, ask user for org/project
    let effectiveAzdoInfo = azdoInfo;
    let effectiveGhInfo = ghInfo;

    if (source === 'azdo' && !effectiveAzdoInfo) {
        const recentOrgs = getRecentAzdoOrgs();
        let orgProjectInput: string | undefined;

        if (recentOrgs.length > 0) {
            // Show quick pick with recent orgs + manual entry
            const pick = await vscode.window.showQuickPick([
                ...recentOrgs.map(o => ({ label: o, description: '$(history) recent', value: o })),
                { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
                { label: '$(edit) Enter org/project or paste URL...', value: '__manual__' },
            ], { placeHolder: 'Select Azure DevOps org/project' });
            if (!pick) { return; }
            orgProjectInput = pick.value === '__manual__' ? undefined : pick.value;
        }

        if (!orgProjectInput) {
            orgProjectInput = await vscode.window.showInputBox({
                prompt: 'Enter Azure DevOps org/project (or paste a build URL)',
                placeHolder: 'e.g. dnceng-public/public or https://dev.azure.com/dnceng-public/public/_build/...',
                validateInput: (v) => {
                    const trimmed = v.trim();
                    if (trimmed.includes('dev.azure.com') || trimmed.includes('visualstudio.com')) { return null; }
                    if (/^[^/]+\/[^/]+$/.test(trimmed)) { return null; }
                    return 'Enter as org/project or paste an Azure DevOps URL';
                },
            });
        }
        if (!orgProjectInput) { return; }

        const trimmed = orgProjectInput.trim();
        const parsed = parseAzdoRemote(trimmed);
        if (parsed) {
            effectiveAzdoInfo = parsed;
        } else {
            const parts = trimmed.split('/');
            effectiveAzdoInfo = { org: parts[0], project: parts[1] };
        }
        saveRecentAzdoOrg(`${effectiveAzdoInfo.org}/${effectiveAzdoInfo.project}`);
        // If URL contains buildId, skip straight to artifact selection
        const directBuildId = extractBuildId(trimmed);
        if (directBuildId && trimmed.includes('buildId')) {
            return await downloadAzdoArtifactFlow(effectiveAzdoInfo, directBuildId);
        }
    }

    if (source === 'github' && !effectiveGhInfo) {
        const recentRepos = getRecentGhRepos();
        let ghInput: string | undefined;

        if (recentRepos.length > 0) {
            const pick = await vscode.window.showQuickPick([
                ...recentRepos.map(o => ({ label: o, description: '$(history) recent', value: o })),
                { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
                { label: '$(edit) Enter owner/repo or paste URL...', value: '__manual__' },
            ], { placeHolder: 'Select GitHub repo' });
            if (!pick) { return; }
            ghInput = pick.value === '__manual__' ? undefined : pick.value;
        }

        if (!ghInput) {
            ghInput = await vscode.window.showInputBox({
                prompt: 'Enter GitHub owner/repo (or paste a GitHub Actions run URL)',
                placeHolder: 'e.g. dotnet/templating or https://github.com/dotnet/templating/actions/runs/12345',
                validateInput: (v) => {
                    const trimmed = v.trim();
                    if (trimmed.includes('github.com')) { return null; }
                    if (/^[^/]+\/[^/]+$/.test(trimmed)) { return null; }
                    return 'Enter as owner/repo or paste a GitHub Actions URL';
                },
            });
        }
        if (!ghInput) { return; }

        const trimmed = ghInput.trim();
        const parsed = parseGitHubRemote(trimmed);
        if (parsed) {
            effectiveGhInfo = parsed;
        } else {
            const parts = trimmed.split('/');
            effectiveGhInfo = { owner: parts[0], repo: parts[1] };
        }
        saveRecentGhRepo(`${effectiveGhInfo.owner}/${effectiveGhInfo.repo}`);
        // If URL contains /actions/runs/{id}, skip straight to artifact selection
        const runMatch = trimmed.match(/\/actions\/runs\/(\d+)/);
        if (runMatch) {
            return await downloadGitHubArtifactFlow(effectiveGhInfo, runMatch[1]);
        }
    }

    // Verify CLI availability — only required for GitHub (AzDO uses REST API for public projects)
    if (source === 'github') {
        if (!(await isGhCliAvailable())) {
            const action = await vscode.window.showErrorMessage(
                'GitHub CLI (`gh`) is required for GitHub Actions integration. Install it from https://cli.github.com',
                'Open Install Page'
            );
            if (action) { vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com')); }
            return;
        }
    }

    // Detect current branch for quick filter
    const currentBranch = await getGitBranch(cwd);

    // For Azure DevOps: let user pick pipeline and/or branch filter
    let azdoPipelineId: number | undefined;
    let branchFilter: string | undefined;

    if (source === 'azdo') {
        try {
            const pipelines = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Fetching pipelines...' },
                () => listAzdoPipelines(effectiveAzdoInfo!.org, effectiveAzdoInfo!.project)
            );
            if (pipelines.length > 0) {
                const pipelinePick = await vscode.window.showQuickPick(
                    [
                        { label: '$(list-flat) All pipelines', pipeline: undefined as AzdoPipeline | undefined },
                        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
                        ...pipelines.map(p => ({
                            label: p.name,
                            description: p.folder !== '\\' ? p.folder : '',
                            pipeline: p as AzdoPipeline | undefined,
                        })),
                    ],
                    { placeHolder: `Select a pipeline from ${effectiveAzdoInfo!.org}/${effectiveAzdoInfo!.project}` }
                );
                if (!pipelinePick) { return; }
                azdoPipelineId = pipelinePick.pipeline?.id;
            }
        } catch {
            // Non-fatal — fall through to list all runs
        }
    }

    // Offer branch/PR filter
    interface FilterPickItem extends vscode.QuickPickItem { value: string | undefined; }
    const filterItems: FilterPickItem[] = [
        { label: '$(list-flat) All branches', description: 'Show recent builds from all branches', value: undefined },
    ];
    if (currentBranch && currentBranch !== 'HEAD') {
        filterItems.unshift({
            label: `$(git-branch) Current branch: ${currentBranch}`,
            description: 'Show builds for this branch',
            value: currentBranch,
        });
    }
    filterItems.push({
        label: '$(edit) Enter branch or PR number...',
        description: '',
        value: '__manual__',
    });

    const filterPick = await vscode.window.showQuickPick(filterItems, {
        placeHolder: 'Filter builds by branch?',
    });
    if (!filterPick) { return; }

    if (filterPick.value === '__manual__') {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter branch name, PR number, or PR URL',
            placeHolder: source === 'azdo' ? 'e.g. main, release/10.0.3xx, or PR 12345' : 'e.g. main, feature/my-branch, or 53547',
        });
        if (!input) { return; }
        const trimmed = input.trim();

        // Extract PR number from URL or "PR 12345" or plain number
        const prUrlMatch = trimmed.match(/\/pull\/(\d+)/);
        const prMatch = trimmed.match(/^(?:PR\s*)?#?(\d+)$/i);
        const prNumber = prUrlMatch?.[1] || prMatch?.[1];

        if (prNumber) {
            if (source === 'azdo') {
                branchFilter = `refs/pull/${prNumber}/merge`;
            } else {
                // GitHub: resolve PR number to head branch name
                try {
                    const prResult = await execCommand('gh', [
                        'pr', 'view', prNumber,
                        '--repo', `${effectiveGhInfo!.owner}/${effectiveGhInfo!.repo}`,
                        '--json', 'headRefName',
                    ]);
                    if (prResult.code === 0) {
                        const prData = JSON.parse(prResult.stdout);
                        branchFilter = prData.headRefName;
                    } else {
                        branchFilter = trimmed;
                    }
                } catch {
                    branchFilter = trimmed;
                }
            }
        } else {
            branchFilter = trimmed;
        }
    } else {
        branchFilter = filterPick.value;
    }

    // List builds
    let builds: CiBuild[];
    try {
        builds = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Fetching CI builds...' },
            async () => {
                if (source === 'azdo') {
                    return listAzdoBuilds(effectiveAzdoInfo!.org, effectiveAzdoInfo!.project, {
                        pipelineId: azdoPipelineId,
                        branch: branchFilter,
                    });
                } else {
                    // gh run list supports --branch
                    return listGitHubRuns(effectiveGhInfo!.owner, effectiveGhInfo!.repo, 20, branchFilter);
                }
            }
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to list builds: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    if (builds.length === 0) {
        vscode.window.showInformationMessage('No builds found.');
        return;
    }

    // Pick a build — include option to enter run ID manually
    interface BuildPickItem extends vscode.QuickPickItem {
        build?: CiBuild;
        isManual?: boolean;
    }

    const repoLabel = source === 'azdo'
        ? `${effectiveAzdoInfo!.org}/${effectiveAzdoInfo!.project}`
        : `${effectiveGhInfo!.owner}/${effectiveGhInfo!.repo}`;

    const pickItems: BuildPickItem[] = [
        {
            label: '$(edit) Enter run/build ID manually...',
            description: '',
            isManual: true,
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...builds.map(b => ({
            label: b.label,
            description: b.description,
            detail: b.detail,
            build: b,
        })),
    ];

    const buildPick = await vscode.window.showQuickPick(pickItems, {
        placeHolder: `Select a build from ${repoLabel}`,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!buildPick) { return; }

    let selectedBuild: CiBuild;
    if (buildPick.isManual) {
        const rawInput = await vscode.window.showInputBox({
            prompt: `Enter the ${source === 'azdo' ? 'Azure DevOps build' : 'GitHub Actions run'} ID or paste the build URL`,
            placeHolder: 'e.g. 1354651 or https://dev.azure.com/org/project/_build/results?buildId=1354651',
            validateInput: (v) => {
                const extracted = extractBuildId(v.trim());
                return extracted ? null : 'Could not find a numeric build/run ID. Paste a URL or enter a number.';
            },
        });
        if (!rawInput) { return; }
        const id = extractBuildId(rawInput.trim())!;
        if (source === 'azdo') {
            selectedBuild = {
                id, label: `#${id}`, description: 'manual', source: 'azdo',
                artifactDownloadArgs: [effectiveAzdoInfo!.org, effectiveAzdoInfo!.project, id],
            };
        } else {
            selectedBuild = {
                id, label: `#${id}`, description: 'manual', source: 'github',
                artifactDownloadArgs: [effectiveGhInfo!.owner, effectiveGhInfo!.repo, id],
            };
        }
    } else {
        selectedBuild = buildPick.build!;
    }

    // List artifacts
    let artifacts: CiArtifact[];
    try {
        artifacts = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Fetching artifacts...' },
            async () => {
                if (source === 'azdo') {
                    const [org, project, runId] = selectedBuild.artifactDownloadArgs;
                    return listAzdoArtifacts(org, project, runId);
                } else {
                    const [owner, repo, runId] = selectedBuild.artifactDownloadArgs;
                    return listGitHubArtifacts(owner, repo, runId);
                }
            }
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to list artifacts: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    return pickAndDownloadArtifact(artifacts, source, selectedBuild.artifactDownloadArgs, selectedBuild.label);
}

/** Direct AzDO artifact flow — skips pipeline/build selection, goes straight to artifacts */
async function downloadAzdoArtifactFlow(
    azdoInfo: { org: string; project: string },
    buildId: string
): Promise<string[] | undefined> {
    let artifacts: CiArtifact[];
    try {
        artifacts = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching artifacts for build #${buildId}...` },
            () => listAzdoArtifacts(azdoInfo.org, azdoInfo.project, buildId)
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to list artifacts: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    return pickAndDownloadArtifact(artifacts, 'azdo', [azdoInfo.org, azdoInfo.project, buildId], `build #${buildId}`);
}

/** Direct GitHub artifact flow — skips run selection, goes straight to artifacts */
async function downloadGitHubArtifactFlow(
    ghInfo: { owner: string; repo: string },
    runId: string
): Promise<string[] | undefined> {
    // Verify gh CLI first
    if (!(await isGhCliAvailable())) {
        vscode.window.showErrorMessage(
            'GitHub CLI (`gh`) is required. Install it from https://cli.github.com'
        );
        return;
    }

    let artifacts: CiArtifact[];
    try {
        artifacts = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching artifacts for run #${runId}...` },
            () => listGitHubArtifacts(ghInfo.owner, ghInfo.repo, runId)
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to list artifacts: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    return pickAndDownloadArtifact(artifacts, 'github', [ghInfo.owner, ghInfo.repo, runId], `run #${runId}`);
}

/** Shared artifact picker and download logic */
async function pickAndDownloadArtifact(
    artifacts: CiArtifact[],
    source: 'azdo' | 'github',
    downloadArgs: string[],
    buildLabel: string
): Promise<string[] | undefined> {
    const binlogArtifacts = artifacts.filter(a => {
        const n = a.name.toLowerCase();
        return n.includes('binlog') || n.includes('binary-log') || n.includes('msbuild-log') ||
               n.includes('build_debug') || n.includes('build_release') ||
               n.includes('buildlogs') || n === 'logs';
    });
    const artifactList = binlogArtifacts.length > 0 ? binlogArtifacts : artifacts;

    if (artifactList.length === 0) {
        const hint = source === 'github'
            ? 'No artifacts found. Build artifacts with binlogs may be on Azure DevOps — try selecting "Azure DevOps" as the platform.'
            : 'No artifacts found for this build. Make sure your CI pipeline publishes `.binlog` files as artifacts.';
        vscode.window.showWarningMessage(hint);
        return;
    }

    const formatSize = (bytes?: number) => {
        if (!bytes) { return ''; }
        if (bytes > 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
        if (bytes > 1024) { return `${(bytes / 1024).toFixed(0)} KB`; }
        return `${bytes} B`;
    };

    const artifactPick = await vscode.window.showQuickPick(
        artifactList.map(a => ({
            label: a.name,
            description: [
                formatSize(a.size),
                binlogArtifacts.includes(a) ? '$(file-binary) likely binlog' : '',
            ].filter(Boolean).join(' · '),
            artifact: a,
        })),
        { placeHolder: `Select artifact from ${buildLabel}` }
    );
    if (!artifactPick) { return; }

    const destDir = path.join(getDownloadDir(), `${source}-${downloadArgs[2]}-${artifactPick.artifact.name}`);
    fs.mkdirSync(destDir, { recursive: true });

    let binlogFiles: string[];
    try {
        binlogFiles = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Downloading ${artifactPick.artifact.name}...` },
            async () => {
                if (source === 'azdo') {
                    const [org, project, runId] = downloadArgs;
                    return downloadAzdoArtifact(org, project, runId, artifactPick.artifact.name, destDir);
                } else {
                    const [owner, repo, runId] = downloadArgs;
                    return downloadGitHubArtifact(owner, repo, runId, artifactPick.artifact.name, destDir);
                }
            }
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    if (binlogFiles.length === 0) {
        vscode.window.showWarningMessage('No .binlog files found in the downloaded artifact.');
        return;
    }

    const fileNames = binlogFiles.map(f => path.basename(f)).join(', ');
    vscode.window.showInformationMessage(
        `✅ Downloaded ${binlogFiles.length} binlog(s) from ${buildLabel}: ${fileNames}`
    );
    return binlogFiles;
}
