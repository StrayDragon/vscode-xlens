export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export type StatusDisplayMode = 'badge' | 'description' | 'hidden';

export type ViewMode = 'live' | 'preset';

export const VALID_STATUSES = new Set<string>(['A', 'M', 'D', 'R', 'C', 'T', 'U', '?']);

export interface DiffEntry {
    status: GitFileStatus;
    path: string;
    oldPath?: string;
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
    baseBranch?: string;
    createdAt: string;
    updatedAt: string;
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
