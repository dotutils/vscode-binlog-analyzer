import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as https from 'https';
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
        cp.execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
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

/** Detect Azure DevOps org/project from git remote URL */
function parseAzdoRemote(remoteUrl: string): { org: string; project: string } | null {
    // HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}
    let m = remoteUrl.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git/);
    if (m) { return { org: m[1], project: m[2] }; }

    // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    m = remoteUrl.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\//);
    if (m) { return { org: m[1], project: m[2] }; }

    // Old VSTS: https://{org}.visualstudio.com/{project}/_git/{repo}
    m = remoteUrl.match(/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git/);
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
        const result = await execCommand('az', [
            'pipelines', 'list',
            '--org', `https://dev.azure.com/${org}`,
            '--project', project,
            '--output', 'json',
        ]);
        if (result.code !== 0) { return []; }
        const pipelines = JSON.parse(result.stdout);
        return pipelines.map((p: any) => ({ id: p.id, name: p.name, folder: p.folder || '' }));
    }
}

async function listAzdoBuilds(org: string, project: string, pipelineId?: number, top: number = 20): Promise<CiBuild[]> {
    let apiUrl = `https://dev.azure.com/${org}/${project}/_apis/build/builds?api-version=7.0&$top=${top}&queryOrder=finishTimeDescending`;
    if (pipelineId !== undefined) {
        apiUrl += `&definitions=${pipelineId}`;
    }

    let runs: any[] = [];
    try {
        const data = await httpsGetJson(apiUrl);
        runs = data.value || [];
    } catch {
        // Fallback to az CLI
        const args = [
            'pipelines', 'runs', 'list',
            '--org', `https://dev.azure.com/${org}`,
            '--project', project,
            '--top', String(top),
            '--output', 'json',
        ];
        if (pipelineId !== undefined) {
            args.push('--pipeline-ids', String(pipelineId));
        }
        const result = await execCommand('az', args);
        if (result.code !== 0) { throw new Error(`Failed to list builds: ${result.stderr}`); }
        runs = JSON.parse(result.stdout);
    }

    return runs.map((run: any) => ({
        id: String(run.id),
        label: `#${run.id} — ${run.definition?.name || 'Build'}`,
        description: `${run.result || run.status} · ${(run.sourceBranch || '').replace('refs/heads/', '')}`,
        detail: `${new Date(run.finishTime || run.startTime || run.queueTime).toLocaleString()} · ${run.result || run.status}`,
        source: 'azdo' as const,
        artifactDownloadArgs: [org, project, String(run.id)],
    }));
}

async function downloadAzdoArtifact(org: string, project: string, runId: string, artifactName: string, destDir: string): Promise<string[]> {
    // Try direct ZIP download first (works for public projects without az CLI)
    const zipUrl = `https://dev.azure.com/${org}/${project}/_apis/build/builds/${runId}/artifacts?artifactName=${encodeURIComponent(artifactName)}&api-version=7.0&%24format=zip`;
    const zipPath = path.join(destDir, `${artifactName}.zip`);

    try {
        await httpsDownloadFile(zipUrl, zipPath);
        // Extract ZIP
        const extractDir = path.join(destDir, artifactName);
        fs.mkdirSync(extractDir, { recursive: true });
        // Use PowerShell to extract (available on all Windows)
        const extractResult = await execCommand('powershell', [
            '-NoProfile', '-Command',
            `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
        ], undefined, 120000);
        if (extractResult.code === 0) {
            fs.unlinkSync(zipPath);
            return findBinlogFiles(extractDir);
        }
    } catch { /* fall through to az CLI */ }

    // Fallback: az CLI download
    const result = await execCommand('az', [
        'pipelines', 'runs', 'artifact', 'download',
        '--org', `https://dev.azure.com/${org}`,
        '--project', project,
        '--run-id', runId,
        '--artifact-name', artifactName,
        '--path', destDir,
    ], undefined, 120000);
    if (result.code !== 0) {
        throw new Error(`Failed to download artifact: ${result.stderr}`);
    }

    return findBinlogFiles(destDir);
}

async function listAzdoArtifacts(org: string, project: string, runId: string): Promise<CiArtifact[]> {
    const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/build/builds/${runId}/artifacts?api-version=7.0`;

    // Try az rest first (works for authenticated users)
    const azResult = await execCommand('az', [
        'rest', '--method', 'get', '--uri', apiUrl,
        '--resource', 'https://management.azure.com/',
        '--output', 'json',
    ]);

    let artifacts: any[] = [];
    if (azResult.code === 0 && azResult.stdout.trim().startsWith('{')) {
        try {
            const data = JSON.parse(azResult.stdout);
            artifacts = data.value || [];
        } catch { /* fall through */ }
    }

    // Fallback: unauthenticated HTTPS fetch (works for public projects)
    if (artifacts.length === 0) {
        try {
            const json = await httpsGetJson(apiUrl);
            artifacts = json?.value || [];
        } catch { /* fall through */ }
    }

    // Last fallback: az pipelines runs artifact list
    if (artifacts.length === 0) {
        const cliResult = await execCommand('az', [
            'pipelines', 'runs', 'artifact', 'list',
            '--org', `https://dev.azure.com/${org}`,
            '--project', project,
            '--run-id', runId,
            '--output', 'json',
        ]);
        if (cliResult.code === 0) {
            try { artifacts = JSON.parse(cliResult.stdout); } catch { /* ignore */ }
        }
    }

    return artifacts.map((a: any) => ({
        name: a.name,
        size: parseInt(a.resource?.properties?.artifactsize || '0', 10),
        source: 'azdo' as const,
    }));
}

// ─── GitHub Actions ──────────────────────────────────────────────────────────

async function listGitHubRuns(owner: string, repo: string, top: number = 20): Promise<CiBuild[]> {
    const result = await execCommand('gh', [
        'run', 'list',
        '--repo', `${owner}/${repo}`,
        '--limit', String(top),
        '--json', 'databaseId,displayTitle,status,conclusion,headBranch,createdAt,workflowName',
    ]);
    if (result.code !== 0) {
        throw new Error(`gh run list failed: ${result.stderr}`);
    }

    const runs = JSON.parse(result.stdout);
    return runs.map((run: any) => ({
        id: String(run.databaseId),
        label: `#${run.databaseId} — ${run.workflowName || 'Workflow'}`,
        description: `${run.conclusion || run.status} · ${run.headBranch}`,
        detail: `${run.displayTitle} · ${new Date(run.createdAt).toLocaleString()}`,
        source: 'github' as const,
        artifactDownloadArgs: [owner, repo, String(run.databaseId)],
    }));
}

async function listGitHubArtifacts(owner: string, repo: string, runId: string): Promise<CiArtifact[]> {
    const result = await execCommand('gh', [
        'api', `repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
        '--jq', '.artifacts[] | {name: .name}',
    ]);
    if (result.code !== 0) {
        // Fallback: try gh run view
        const viewResult = await execCommand('gh', [
            'run', 'view', runId,
            '--repo', `${owner}/${repo}`,
            '--json', 'jobs',
        ]);
        return [];
    }

    // Parse newline-separated JSON objects
    const artifacts: CiArtifact[] = [];
    for (const line of result.stdout.trim().split('\n')) {
        if (!line.trim()) { continue; }
        try {
            const obj = JSON.parse(line);
            artifacts.push({ name: obj.name, source: 'github' });
        } catch { /* skip malformed lines */ }
    }
    return artifacts;
}

async function downloadGitHubArtifact(owner: string, repo: string, runId: string, artifactName: string, destDir: string): Promise<string[]> {
    const result = await execCommand('gh', [
        'run', 'download', runId,
        '--repo', `${owner}/${repo}`,
        '--name', artifactName,
        '--dir', destDir,
    ], undefined, 120000);
    if (result.code !== 0) {
        throw new Error(`Failed to download artifact: ${result.stderr}`);
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
        https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
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
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

/** Download a file via HTTPS to a local path. Follows redirects. */
function httpsDownloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const doRequest = (reqUrl: string) => {
            https.get(reqUrl, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    doRequest(res.headers.location);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const fileStream = fs.createWriteStream(destPath);
                res.pipe(fileStream);
                fileStream.on('finish', () => { fileStream.close(); resolve(); });
                fileStream.on('error', reject);
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
        const orgProject = await vscode.window.showInputBox({
            prompt: 'Enter Azure DevOps org/project (or paste a build URL)',
            placeHolder: 'e.g. dnceng-public/public or https://dev.azure.com/dnceng-public/public/_build/...',
            validateInput: (v) => {
                const trimmed = v.trim();
                if (trimmed.includes('dev.azure.com') || trimmed.includes('visualstudio.com')) { return null; }
                if (/^[^/]+\/[^/]+$/.test(trimmed)) { return null; }
                return 'Enter as org/project or paste an Azure DevOps URL';
            },
        });
        if (!orgProject) { return; }
        const trimmed = orgProject.trim();
        // Try parsing as URL
        const parsed = parseAzdoRemote(trimmed);
        if (parsed) {
            effectiveAzdoInfo = parsed;
        } else {
            const parts = trimmed.split('/');
            effectiveAzdoInfo = { org: parts[0], project: parts[1] };
        }
    }

    if (source === 'github' && !effectiveGhInfo) {
        const ownerRepo = await vscode.window.showInputBox({
            prompt: 'Enter GitHub owner/repo',
            placeHolder: 'e.g. dotnet/templating',
            validateInput: (v) => /^[^/]+\/[^/]+$/.test(v.trim()) ? null : 'Enter as owner/repo',
        });
        if (!ownerRepo) { return; }
        const parts = ownerRepo.trim().split('/');
        effectiveGhInfo = { owner: parts[0], repo: parts[1] };
    }

    // Verify CLI
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

    // For Azure DevOps: let user pick a pipeline first
    let azdoPipelineId: number | undefined;
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

    // List builds
    let builds: CiBuild[];
    try {
        builds = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Fetching CI builds...' },
            async () => {
                if (source === 'azdo') {
                    return listAzdoBuilds(effectiveAzdoInfo!.org, effectiveAzdoInfo!.project, azdoPipelineId);
                } else {
                    return listGitHubRuns(effectiveGhInfo!.owner, effectiveGhInfo!.repo);
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

    // Filter to likely binlog artifacts or let user pick
    const binlogArtifacts = artifacts.filter(a =>
        a.name.toLowerCase().includes('binlog') ||
        a.name.toLowerCase().includes('binary-log') ||
        a.name.toLowerCase().includes('msbuild-log') ||
        a.name.toLowerCase().includes('build_debug') ||
        a.name.toLowerCase().includes('build_release')
    );

    const artifactList = binlogArtifacts.length > 0 ? binlogArtifacts : artifacts;

    if (artifactList.length === 0) {
        vscode.window.showWarningMessage(
            'No artifacts found for this build. Make sure your CI pipeline publishes `.binlog` files as artifacts.'
        );
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
        { placeHolder: 'Select artifact containing binlog files' }
    );
    if (!artifactPick) { return; }

    // Download artifact
    const destDir = path.join(getDownloadDir(), `${source}-${selectedBuild.id}-${artifactPick.artifact.name}`);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    let binlogFiles: string[];
    try {
        binlogFiles = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Downloading ${artifactPick.artifact.name}...` },
            async () => {
                if (source === 'azdo') {
                    const [org, project, runId] = selectedBuild.artifactDownloadArgs;
                    return downloadAzdoArtifact(org, project, runId, artifactPick.artifact.name, destDir);
                } else {
                    const [owner, repo, runId] = selectedBuild.artifactDownloadArgs;
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
        `✅ Downloaded ${binlogFiles.length} binlog(s) from CI: ${fileNames}`
    );

    return binlogFiles;
}
