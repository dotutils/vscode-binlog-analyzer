/**
 * Parsing of git remote URLs into CI coordinates.
 *
 * These parsers are a security boundary: whatever they return is passed
 * straight to `gh` / `az` as command arguments, so they must never accept a
 * host they do not fully control, and they must never emit an owner/repo/org/
 * project containing shell metacharacters.
 *
 * The previous implementation matched `github.com` as a *substring*, so
 * `https://evil-github.com/attacker/payload` and
 * `https://notgithub.com/attacker/payload` both parsed as GitHub repositories.
 * This module does real URL parsing and anchors on the hostname instead.
 *
 * Nothing here imports `vscode`, so it is unit-testable.
 */
import { URL } from 'url';
import { isValidRepoIdentifier } from './ciSafety';

export interface GitHubRemote {
    owner: string;
    repo: string;
}

export interface AzdoRemote {
    org: string;
    project: string;
}

/**
 * Outcome of parsing a remote as GitHub.
 *
 * `enterprise` exists purely so callers can say *why* nothing happened:
 * GitHub Enterprise Server hosts have never been supported, and previously
 * failed with a generic "no CI provider" experience.
 */
export type GitHubRemoteParseResult =
    | { kind: 'github'; owner: string; repo: string }
    | { kind: 'enterprise'; host: string }
    | { kind: 'none' };

/** User-facing explanation for GitHub Enterprise Server remotes. */
export const GITHUB_ENTERPRISE_UNSUPPORTED_MESSAGE =
    'GitHub Enterprise remotes are not supported.';

/**
 * `[user@]host:path` (scp-like) remotes, e.g. `git@github.com:owner/repo.git`.
 * The host must contain a dot so that `https:`/`ssh:` URL schemes and Windows
 * drive letters (`C:\…`) can never be mistaken for a hostname.
 */
const SCP_LIKE_REMOTE = /^(?:[^@/\\\s]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(?![/\\])(.*)$/;

/** Schemes git uses that carry a hostname. */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'git+https:']);

/** `host/path` without a scheme, e.g. `github.com/owner/repo`. */
const SCHEMELESS_WITH_HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?\//;

const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export interface RemoteParts {
    hostname: string;
    /** Raw (still percent-encoded) path, without leading slash guarantees. */
    pathname: string;
}

/**
 * Split any git remote form into hostname + path. Returns `null` when the
 * input is not a remote URL we understand (e.g. a bare `owner/repo`).
 */
export function splitRemoteUrl(remoteUrl: string): RemoteParts | null {
    if (typeof remoteUrl !== 'string') { return null; }
    const trimmed = remoteUrl.trim();
    if (!trimmed) { return null; }

    const scp = SCP_LIKE_REMOTE.exec(trimmed);
    if (scp) {
        return { hostname: normalizeHost(scp[1]), pathname: scp[2] };
    }

    let candidate = trimmed;
    if (!HAS_SCHEME.test(candidate)) {
        if (!SCHEMELESS_WITH_HOST.test(candidate)) { return null; }
        candidate = 'https://' + candidate;
    }

    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) { return null; }
    if (!url.hostname) { return null; }
    return { hostname: normalizeHost(url.hostname), pathname: url.pathname };
}

function normalizeHost(host: string): string {
    // Lower-case, drop the root-label dot, and strip IPv6 brackets so a
    // bracketed literal can never look like a suffix match.
    return host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

/** Decode and drop empty path segments. Returns `null` on malformed escapes. */
function pathSegments(pathname: string): string[] | null {
    const raw = pathname.split('/').filter(segment => segment.length > 0);
    const decoded: string[] = [];
    for (const segment of raw) {
        try {
            decoded.push(decodeURIComponent(segment));
        } catch {
            return null;
        }
    }
    return decoded;
}

/**
 * Classify a hostname as github.com, a GitHub Enterprise Server host, or
 * something unrelated.
 *
 * `github.com.attacker.io` is deliberately *not* treated as Enterprise: only a
 * `github.<company>.<tld>` shape qualifies, and a second label of `com` is the
 * classic look-alike pattern.
 */
export function classifyGitHubHost(hostname: string): 'github' | 'enterprise' | 'other' {
    const host = normalizeHost(hostname);
    if (host === 'github.com' || host.endsWith('.github.com')) { return 'github'; }
    const labels = host.split('.');
    if (labels.length >= 3 && labels[0] === 'github' && labels[1] !== 'com') {
        return 'enterprise';
    }
    return 'other';
}

/**
 * Parse a GitHub remote, distinguishing "not GitHub" from "GitHub Enterprise,
 * which we do not support".
 */
export function parseGitHubRemoteDetailed(remoteUrl: string): GitHubRemoteParseResult {
    const parts = splitRemoteUrl(remoteUrl);
    if (!parts) { return { kind: 'none' }; }

    const classification = classifyGitHubHost(parts.hostname);
    if (classification === 'other') { return { kind: 'none' }; }
    if (classification === 'enterprise') { return { kind: 'enterprise', host: parts.hostname }; }

    const segments = pathSegments(parts.pathname);
    if (!segments || segments.length < 2) { return { kind: 'none' }; }

    const owner = segments[0];
    let repo = segments[1];
    if (repo.length > 4 && repo.toLowerCase().endsWith('.git')) {
        repo = repo.slice(0, -4);
    }

    if (!isValidRepoIdentifier(owner) || !isValidRepoIdentifier(repo)) {
        return { kind: 'none' };
    }
    return { kind: 'github', owner, repo };
}

/** Detect GitHub owner/repo from a git remote URL. `null` when unsupported. */
export function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
    const result = parseGitHubRemoteDetailed(remoteUrl);
    return result.kind === 'github' ? { owner: result.owner, repo: result.repo } : null;
}

/** True when the remote points at a GitHub Enterprise Server installation. */
export function isGitHubEnterpriseRemote(remoteUrl: string): boolean {
    return parseGitHubRemoteDetailed(remoteUrl).kind === 'enterprise';
}

/** Azure DevOps route markers that can never be an org or a project. */
function isRouteMarker(segment: string | undefined): boolean {
    return !segment || segment.startsWith('_');
}

/**
 * Detect an Azure DevOps org/project from a remote URL. Only `dev.azure.com`,
 * `ssh.dev.azure.com` and `<org>.visualstudio.com` are accepted.
 */
export function parseAzdoRemote(remoteUrl: string): AzdoRemote | null {
    const parts = splitRemoteUrl(remoteUrl);
    if (!parts) { return null; }

    const host = parts.hostname;
    const segments = pathSegments(parts.pathname);
    if (!segments) { return null; }

    let org: string | undefined;
    let project: string | undefined;

    if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com') {
        // ssh form is `v3/{org}/{project}/{repo}`; https form is `{org}/{project}/…`
        const rest = segments[0]?.toLowerCase() === 'v3' ? segments.slice(1) : segments;
        org = rest[0];
        project = rest[1];
    } else if (host.endsWith('.visualstudio.com') && host.split('.').length >= 3) {
        org = host.split('.')[0];
        project = segments[0];
        if (project?.toLowerCase() === 'defaultcollection') {
            project = segments[1];
        }
    } else {
        return null;
    }

    if (isRouteMarker(org) || isRouteMarker(project)) { return null; }
    if (!isValidRepoIdentifier(org!) || !isValidRepoIdentifier(project!)) { return null; }
    return { org: org!, project: project! };
}
