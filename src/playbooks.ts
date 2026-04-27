import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Loads markdown playbooks from `resources/playbooks/` shipped with the
 * extension. Files are read once and cached for the lifetime of the
 * extension host.
 *
 * Why files instead of inline strings?
 *  - One source of truth between @binlog participant, the build-analysis
 *    chat mode, and any future consumers.
 *  - Reviewable as docs in PRs (no diff noise from string concatenation).
 *  - Slash-command authors no longer need to touch TypeScript.
 *  - Lazy loading: heavy playbooks (perf, incremental) are only fetched
 *    when the user actually invokes the matching slash command, instead
 *    of being baked into every chat turn.
 */
export class PlaybookLoader {
    private readonly cache = new Map<string, string>();
    private readonly rootDir: string;

    constructor(extensionUri: vscode.Uri) {
        this.rootDir = path.join(extensionUri.fsPath, 'resources', 'playbooks');
    }

    /** Read a playbook by relative path (e.g. `core` or `commands/errors`). Returns '' if missing. */
    get(relPath: string): string {
        const cached = this.cache.get(relPath);
        if (cached !== undefined) {
            return cached;
        }
        const fsPath = path.join(this.rootDir, `${relPath}.md`);
        try {
            const text = fs.readFileSync(fsPath, 'utf8').trim();
            this.cache.set(relPath, text);
            return text;
        } catch {
            this.cache.set(relPath, '');
            return '';
        }
    }

    /** Convenience: get the per-command instructions for a slash command. */
    getCommand(command: string): string {
        return this.get(`commands/${command}`);
    }
}
