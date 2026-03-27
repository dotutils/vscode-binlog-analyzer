import * as vscode from 'vscode';
import * as cp from 'child_process';
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
    downloadUrl?: string;
    source: 'azdo' | 'github';
}

// ─── Azure DevOps ────────────────────────────────────────────────────────────

async function execCommand(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        cp.execFile(cmd, args, { cwd, timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
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

async function listAzdoBuilds(org: string, project: string, top: number = 20): Promise<CiBuild[]> {
    const result = await execCommand('az', [
        'pipelines', 'runs', 'list',
        '--org', `https://dev.azure.com/${org}`,
        '--project', project,
        '--top', String(top),
        '--output', 'json',
    ]);
    if (result.code !== 0) {
        throw new Error(`az pipelines runs list failed: ${result.stderr}`);
    }

    const runs = JSON.parse(result.stdout);
    return runs.map((run: any) => ({
        id: String(run.id),
        label: `#${run.id} — ${run.definition?.name || 'Build'}`,
        description: `${run.result || run.status} · ${run.sourceBranch?.replace('refs/heads/', '')}`,
        detail: `${new Date(run.finishTime || run.startTime || run.queueTime).toLocaleString()} · ${run.result || run.status}`,
        source: 'azdo' as const,
        artifactDownloadArgs: [org, project, String(run.id)],
    }));
}

async function downloadAzdoArtifact(org: string, project: string, runId: string, artifactName: string, destDir: string): Promise<string[]> {
    const result = await execCommand('az', [
        'pipelines', 'runs', 'artifact', 'download',
        '--org', `https://dev.azure.com/${org}`,
        '--project', project,
        '--run-id', runId,
        '--artifact-name', artifactName,
        '--path', destDir,
    ]);
    if (result.code !== 0) {
        throw new Error(`Failed to download artifact: ${result.stderr}`);
    }

    return findBinlogFiles(destDir);
}

async function listAzdoArtifacts(org: string, project: string, runId: string): Promise<CiArtifact[]> {
    const result = await execCommand('az', [
        'pipelines', 'runs', 'artifact', 'list',
        '--org', `https://dev.azure.com/${org}`,
        '--project', project,
        '--run-id', runId,
        '--output', 'json',
    ]);
    if (result.code !== 0) {
        throw new Error(`Failed to list artifacts: ${result.stderr}`);
    }

    const artifacts = JSON.parse(result.stdout);
    return artifacts.map((a: any) => ({
        name: a.name,
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
    ]);
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

export async function downloadCiBinlog(): Promise<string[] | undefined> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const remoteUrl = await getGitRemoteUrl(cwd);

    if (!remoteUrl) {
        vscode.window.showErrorMessage('No git remote found. Open a project with a git remote to use CI/CD integration.');
        return;
    }

    const azdoInfo = parseAzdoRemote(remoteUrl);
    const ghInfo = parseGitHubRemote(remoteUrl);

    if (!azdoInfo && !ghInfo) {
        vscode.window.showErrorMessage(
            'Could not detect Azure DevOps or GitHub remote from git origin URL.\n' +
            `Remote: ${remoteUrl}`
        );
        return;
    }

    // Determine source and check CLI availability
    let source: 'azdo' | 'github';
    if (azdoInfo && ghInfo) {
        const pick = await vscode.window.showQuickPick(
            [
                { label: '$(azure) Azure DevOps', value: 'azdo' as const },
                { label: '$(github) GitHub Actions', value: 'github' as const },
            ],
            { placeHolder: 'Select CI/CD platform' }
        );
        if (!pick) { return; }
        source = pick.value;
    } else {
        source = azdoInfo ? 'azdo' : 'github';
    }

    // Verify CLI
    if (source === 'azdo') {
        if (!(await isAzCliAvailable())) {
            const action = await vscode.window.showErrorMessage(
                'Azure CLI (`az`) is required for Azure DevOps integration. Install it from https://aka.ms/install-az-cli',
                'Open Install Page'
            );
            if (action) { vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/install-az-cli')); }
            return;
        }
        // Check az devops extension
        const extCheck = await execCommand('az', ['extension', 'show', '--name', 'azure-devops', '--output', 'json']);
        if (extCheck.code !== 0) {
            const install = await vscode.window.showWarningMessage(
                'The `azure-devops` extension for Azure CLI is required. Install it now?',
                'Install', 'Cancel'
            );
            if (install === 'Install') {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Installing azure-devops CLI extension...' },
                    async () => {
                        const r = await execCommand('az', ['extension', 'add', '--name', 'azure-devops']);
                        if (r.code !== 0) { throw new Error(r.stderr); }
                    }
                );
            } else {
                return;
            }
        }
    } else {
        if (!(await isGhCliAvailable())) {
            const action = await vscode.window.showErrorMessage(
                'GitHub CLI (`gh`) is required for GitHub Actions integration. Install it from https://cli.github.com',
                'Open Install Page'
            );
            if (action) { vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com')); }
            return;
        }
    }

    // List builds
    let builds: CiBuild[];
    try {
        builds = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Fetching CI builds...' },
            async () => {
                if (source === 'azdo') {
                    return listAzdoBuilds(azdoInfo!.org, azdoInfo!.project);
                } else {
                    return listGitHubRuns(ghInfo!.owner, ghInfo!.repo);
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
        placeHolder: 'Select a build to download binlog from',
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
                artifactDownloadArgs: [azdoInfo!.org, azdoInfo!.project, id],
            };
        } else {
            selectedBuild = {
                id, label: `#${id}`, description: 'manual', source: 'github',
                artifactDownloadArgs: [ghInfo!.owner, ghInfo!.repo, id],
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
        a.name.toLowerCase().includes('msbuild-log')
    );

    const artifactList = binlogArtifacts.length > 0 ? binlogArtifacts : artifacts;

    if (artifactList.length === 0) {
        vscode.window.showWarningMessage(
            'No artifacts found for this build. Make sure your CI pipeline publishes `.binlog` files as artifacts.'
        );
        return;
    }

    const artifactPick = await vscode.window.showQuickPick(
        artifactList.map(a => ({
            label: a.name,
            description: binlogArtifacts.includes(a) ? '$(file-binary) likely binlog' : '',
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
