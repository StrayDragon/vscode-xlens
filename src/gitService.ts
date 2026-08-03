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

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-\/@]+$/;

/** Diff semantics for range review: PR-style three-dot (default) or full two-dot. */
export type RangeDiffMode = 'three-dot' | 'two-dot';

/** Diff target for the XLens view: single base ref (working tree vs ref) or two-ref range. */
export type DiffTarget =
    | { kind: 'base'; ref: string }
    | { kind: 'range'; from: string; to: string; mode?: RangeDiffMode };

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

    // No well-known branch found – try any local branch that is not the current HEAD
    let currentBranch = '';
    try {
        currentBranch = (await execAsync('git rev-parse --abbrev-ref HEAD', repoRoot)).trim();
    } catch { /* ignore */ }

    const branches = await listBranches(repoRoot);
    for (const b of branches) {
        if (b !== currentBranch) {
            return b;
        }
    }

    // Only one branch exists – return it (or HEAD as last resort)
    return branches.length > 0 ? branches[0] : (currentBranch || 'HEAD');
}

/** List all local branches in the repo. */
export async function listBranches(repoRoot: string): Promise<string[]> {
    const output = await execAsync(`git branch --format='%(refname:short)'`, repoRoot);
    if (!output) { return []; }
    // Filter out detached HEAD lines like "(HEAD detached at ...)"
    return output.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('(') && !s.startsWith('* '));
}

/** List all tags, version-sorted (v1.10 sorts after v1.9). */
export async function listTags(repoRoot: string): Promise<string[]> {
    const output = await execAsync(`git tag --sort=-version:refname`, repoRoot);
    if (!output) { return []; }
    return output.split('\n').map(s => s.trim()).filter(Boolean);
}

/** List all remote-tracking branches, e.g. `origin/main`. Excludes `origin/HEAD`. */
export async function listRemoteBranches(repoRoot: string): Promise<string[]> {
    const output = await execAsync(`git branch -r --format='%(refname:short)'`, repoRoot);
    if (!output) { return []; }
    return output.split('\n').map(s => s.trim())
        .filter(s => s && !s.endsWith('/HEAD') && !s.includes('HEAD ->'));
}

/** Recent commits as `{ sha, subject }`, newest first. */
export async function listRecentCommits(repoRoot: string, n = 15): Promise<{ sha: string; subject: string }[]> {
    const output = await execAsync(`git log -n ${n} --format=%h%x1f%s`, repoRoot);
    if (!output) { return []; }
    return output.split('\n')
        .map(line => {
            const idx = line.indexOf('\x1f');
            if (idx < 0) { return undefined; }
            return { sha: line.slice(0, idx).trim(), subject: line.slice(idx + 1).trim() };
        })
        .filter((c): c is { sha: string; subject: string } => !!c && !!c.sha);
}

/**
 * Resolve any ref (branch / tag / commit SHA) to a full commit SHA.
 * Throws when the ref is invalid, unsafe, or not a commit.
 */
export async function resolveRef(repoRoot: string, ref: string): Promise<string> {
    if (!isValidBranchName(ref)) {
        throw new Error(`Invalid ref: ${ref}`);
    }
    const output = await execAsync(`git rev-parse --verify --quiet ${ref}^{commit}`, repoRoot);
    if (!output) {
        throw new Error(`Ref not found: ${ref}`);
    }
    return output.trim();
}

/** Merge base of two refs, or undefined when they share no common ancestor. */
export async function getMergeBase(repoRoot: string, from: string, to: string): Promise<string | undefined> {
    try {
        const out = await execAsync(`git merge-base ${from} ${to}`, repoRoot);
        return out || undefined;
    } catch {
        return undefined;
    }
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
    target: DiffTarget,
    filterPrefix: string,
): Promise<DiffEntry[]> {
    let cmd: string;
    if (target.kind === 'range') {
        // Resolve to full SHAs first — safe interpolation and consistent with `git show`.
        const fromSha = await resolveRef(repoRoot, target.from);
        const toSha = await resolveRef(repoRoot, target.to);
        if (target.mode !== 'two-dot') {
            // PR-style three-dot: changes on `to` since it diverged from `from`.
            // Falls back to two-dot when there is no merge base (unrelated histories).
            const mergeBase = await getMergeBase(repoRoot, fromSha, toSha);
            if (mergeBase) {
                cmd = `git -c core.quotePath=false diff ${fromSha}...${toSha} --raw --numstat`;
            } else {
                cmd = `git -c core.quotePath=false diff ${fromSha} ${toSha} --raw --numstat`;
            }
        } else {
            cmd = `git -c core.quotePath=false diff ${fromSha} ${toSha} --raw --numstat`;
        }
    } else {
        if (!isValidBranchName(target.ref)) {
            throw new Error(`Invalid ref: ${target.ref}`);
        }
        cmd = `git -c core.quotePath=false diff ${target.ref} --raw --numstat`;
    }
    if (filterPrefix) {
        cmd += ` -- ${filterPrefix}`;
    }

    const output = await execAsync(cmd, repoRoot);
    if (!output) {
        return [];
    }

    // raw lines:     :<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>
    //                (renames/copies: ... <status>\t<old>\t<new>, status like `R100`)
    // numstat lines: <add>\t<del>\t<path>          (renames: <add>\t<del>\t<old>\t<new>)
    // Collect numstat first — raw lines precede numstat lines in the output.
    const numstatByPath = new Map<string, { additions: number; deletions: number }>();
    for (const line of output.split('\n')) {
        if (!line.trim()) { continue; }
        const parts = line.split('\t');
        if (/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1] ?? '')) {
            // Renames/copies report 4 columns; the last one is the new path
            const path = parts.length >= 4 ? parts[3] : parts[2];
            numstatByPath.set(path, { additions: Number(parts[0]), deletions: Number(parts[1]) });
        }
        // binary files emit `-\t-` numstat lines — skipped here, status still comes from raw
    }

    const entries: DiffEntry[] = [];
    for (const line of output.split('\n')) {
        if (!line.trim()) { continue; }
        const parts = line.split('\t');
        if (!parts[0].startsWith(':')) { continue; }
        // raw status line
        const meta = parts[0].split(' ');
        const rawStatus = meta[4] ?? '';
        const statusCode = parseGitStatus(rawStatus.charAt(0));
        if (!statusCode) { continue; }

        let entry: DiffEntry;
        if ((statusCode === 'R' || statusCode === 'C') && parts.length >= 3) {
            entry = { status: statusCode, path: parts[2], oldPath: parts[1] };
        } else {
            entry = { status: statusCode, path: parts[1] };
        }
        const stat = numstatByPath.get(entry.path);
        if (stat) {
            entry.additions = stat.additions;
            entry.deletions = stat.deletions;
        }
        entries.push(entry);
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

function normalizeDirPath(d: string): string {
    return d.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

async function listFilesUnderDir(repoRoot: string, dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const pathspec = quotePathspec(prefix);

    const files = new Set<string>();

    const trackedCmd = `git -c core.quotePath=false ls-files -- ${pathspec}`;
    const untrackedCmd = `git -c core.quotePath=false ls-files --others --exclude-standard -- ${pathspec}`;

    for (const cmd of [trackedCmd, untrackedCmd]) {
        let output: string;
        try {
            output = await execAsync(cmd, repoRoot);
        } catch {
            continue;
        }
        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) { files.add(trimmed); }
        }
    }

    return [...files];
}

/**
 * Expand tracked-directory entries to their current file set.
 * @param dirs Directory paths with trailing `/` (e.g. `some/project/apis/`).
 */
export async function expandDirsToTrackedFiles(repoRoot: string, dirs: string[]): Promise<string[]> {
    const norm = dirs.map(normalizeDirPath).filter(Boolean);
    if (norm.length === 0) { return []; }

    const files = new Set<string>();

    for (const dir of norm) {
        const candidates = await listFilesUnderDir(repoRoot, dir);
        for (const f of candidates) { files.add(f); }
    }

    return [...files];
}
