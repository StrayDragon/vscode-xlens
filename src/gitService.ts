import * as path from 'path';
import { exec } from 'child_process';
import { DiffEntry, GitFileStatus } from './types';

function execAsync(command: string, cwd: string): Promise<string> {
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

export async function getDiffEntries(
    repoRoot: string,
    baseBranch: string,
    filterPrefix: string,
): Promise<DiffEntry[]> {
    let cmd = `git diff ${baseBranch} --name-status`;
    if (filterPrefix) {
        cmd += ` -- ${filterPrefix}`;
    }

    let output: string;
    try {
        output = await execAsync(cmd, repoRoot);
    } catch {
        return [];
    }

    if (!output) {
        return [];
    }

    const entries: DiffEntry[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
        if (!line.trim()) { continue; }
        const parts = line.split('\t');
        if (parts.length < 2) { continue; }

        const statusCode = parts[0] as GitFileStatus;
        // For renames: R100\told_path\tnew_path
        if (statusCode.startsWith('R') && parts.length >= 3) {
            entries.push({
                status: 'R',
                path: parts[2],
                oldPath: parts[1],
            });
        } else if (statusCode.startsWith('C') && parts.length >= 3) {
            entries.push({
                status: 'C',
                path: parts[2],
                oldPath: parts[1],
            });
        } else {
            entries.push({
                status: statusCode.charAt(0) as GitFileStatus,
                path: parts[1],
            });
        }
    }

    return entries;
}
