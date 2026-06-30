import * as path from 'path';
import { exec } from 'child_process';
import { DiffEntry, GitFileStatus, VALID_STATUSES } from './types';

export function execAsync(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
                reject(new Error(`Command failed: ${command}\n${stderr}`));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-\/]+$/;

export function isValidBranchName(branch: string): boolean {
    return SAFE_BRANCH_RE.test(branch) && !branch.includes('..');
}

export async function getGitRepoRoot(workspacePath: string): Promise<string> {
    return execAsync('git rev-parse --show-toplevel', workspacePath);
}

export async function detectBaseBranch(repoRoot: string): Promise<string> {
    const candidates = ['master', 'main', 'develop', 'trunk'];
    for (const branch of candidates) {
        try {
            await execAsync(`git rev-parse --verify ${branch}`, repoRoot);
            return branch;
        } catch {
            continue;
        }
    }
    return 'master';
}

export function getFilterPrefix(
    workspacePath: string,
    repoRoot: string,
    manualPrefix: string,
): string {
    if (manualPrefix) {
        return manualPrefix.endsWith('/') ? manualPrefix : manualPrefix + '/';
    }
    const rel = path.relative(repoRoot, workspacePath);
    if (rel && rel !== '.') {
        return rel.endsWith('/') ? rel : rel + '/';
    }
    return '';
}

function parseGitStatus(raw: string): GitFileStatus | undefined {
    const ch = raw.charAt(0);
    if (VALID_STATUSES.has(ch)) {
        return ch as GitFileStatus;
    }
    return undefined;
}

export async function getDiffEntries(
    repoRoot: string,
    baseBranch: string,
    filterPrefix: string,
): Promise<DiffEntry[]> {
    if (!isValidBranchName(baseBranch)) {
        throw new Error(`Invalid branch name: ${baseBranch}`);
    }

    let cmd = `git -c core.quotePath=false diff ${baseBranch} --name-status`;
    if (filterPrefix) {
        cmd += ` -- ${filterPrefix}`;
    }

    const output = await execAsync(cmd, repoRoot);
    if (!output) {
        return [];
    }

    const entries: DiffEntry[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
        if (!line.trim()) { continue; }
        const parts = line.split('\t');
        if (parts.length < 2) { continue; }

        const statusCode = parseGitStatus(parts[0]);
        if (!statusCode) { continue; }

        if (statusCode === 'R' && parts.length >= 3) {
            entries.push({ status: 'R', path: parts[2], oldPath: parts[1] });
        } else if (statusCode === 'C' && parts.length >= 3) {
            entries.push({ status: 'C', path: parts[2], oldPath: parts[1] });
        } else {
            entries.push({ status: statusCode, path: parts[1] });
        }
    }

    return entries;
}

/**
 * List tracked and untracked (non-ignored) files under an optional path prefix.
 */
export async function listRepoFiles(repoRoot: string, filterPrefix: string): Promise<string[]> {
    const prefixArg = filterPrefix ? ` -- ${filterPrefix}` : '';
    const trackedOutput = await execAsync(
        `git -c core.quotePath=false ls-files${prefixArg}`,
        repoRoot,
    );

    let untrackedOutput = '';
    try {
        untrackedOutput = await execAsync(
            `git -c core.quotePath=false ls-files --others --exclude-standard${prefixArg}`,
            repoRoot,
        );
    } catch {
        // No untracked files or git error — ignore
    }

    const files = new Set<string>();
    for (const line of `${trackedOutput}\n${untrackedOutput}`.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
            files.add(trimmed);
        }
    }

    return [...files].sort();
}

/**
 * Quote a single git pathspec argument, escaping embedded double quotes.
 */
function quotePathspec(p: string): string {
    return '"' + p.replace(/"/g, '\\"') + '"';
}

/**
 * Expand tracked-directory entries to their current tracked file set.
 * Returns repo-relative paths. Files are resolved fresh on every call, so file
 * renames/deletes within a tracked directory are picked up automatically
 * (directories are stable, files are not).
 */
export async function expandDirsToTrackedFiles(repoRoot: string, dirs: string[]): Promise<string[]> {
    const norm = dirs
        .map(d => d.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
        .filter(Boolean);
    if (norm.length === 0) { return []; }

    // Ensure trailing slash so git treats each as a directory prefix.
    const pathspecs = norm.map(d => quotePathspec(d.endsWith('/') ? d : d + '/')).join(' ');
    const cmd = `git -c core.quotePath=false ls-files -- ${pathspecs}`;

    let output: string;
    try {
        output = await execAsync(cmd, repoRoot);
    } catch {
        return [];
    }

    const files = new Set<string>();
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) { files.add(trimmed); }
    }
    return [...files];
}
