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

    let cmd = `git diff ${baseBranch} --name-status`;
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
