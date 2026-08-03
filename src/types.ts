export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export type StatusDisplayMode = 'badge' | 'description' | 'hidden';

export type ViewMode = 'live' | 'preset';

export const VALID_STATUSES = new Set<string>(['A', 'M', 'D', 'R', 'C', 'T', 'U', '?']);

export interface DiffEntry {
    status: GitFileStatus;
    path: string;
    oldPath?: string;
    /** Line additions (from --numstat). Undefined when not collected. */
    additions?: number;
    /** Line deletions (from --numstat). Undefined when not collected. */
    deletions?: number;
}

export interface FolderNode {
    type: 'folder';
    name: string;
    relativePath: string;
    children: Map<string, TreeNode>;
    fileCount: number;
}

export interface FileNode {
    type: 'file';
    name: string;
    relativePath: string;
    status: GitFileStatus;
    /** Original path for renamed/copied files. */
    oldPath?: string;
    /** Line additions (from --numstat). */
    additions?: number;
    /** Line deletions (from --numstat). */
    deletions?: number;
    /** True when the file is in the active preset but has no live git status (clean/unchanged) */
    isClean?: boolean;
    /** True when the file is in the active preset but doesn't exist on disk */
    isMissing?: boolean;
}

export type TreeNode = FolderNode | FileNode;

export interface PresetMeta {
    name: string;
    description: string;
    fileCount: number;
    /** Number of directories tracked by the preset (resolved at view time). */
    dirCount?: number;
    /** Single-ref base (live diff vs working tree). Mutually exclusive with `range`. */
    baseBranch?: string;
    /** Two-ref range (range review diff between two commits). Mutually exclusive with `baseBranch`. */
    range?: DiffRange;
    createdAt: string;
    updatedAt: string;
}

/** A two-ref diff range: `git diff <from> <to>` (branches, tags, or commits). */
export interface DiffRange {
    from: string;
    to: string;
}

export interface Preset extends PresetMeta {
    /** Tracked paths (repo-relative).
     *  File paths are bare: `some/project/file.ts`.
     *  Directory paths end with `/`: `some/project/dir/`.
     *  Directories are resolved at view time via `git ls-files`. */
    paths: string[];
}

/** Returns true if a preset path entry represents a directory (ends with `/`). */
export function isDirPath(p: string): boolean {
    return p.endsWith('/');
}

/** Extract file paths from a preset's paths array. */
export function filePaths(paths: string[]): string[] {
    return paths.filter(p => !isDirPath(p));
}

/** Extract directory paths from a preset's paths array. */
export function dirPaths(paths: string[]): string[] {
    return paths.filter(isDirPath);
}
