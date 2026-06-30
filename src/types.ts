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
    /** Explicitly tracked file paths (repo-relative). */
    files: string[];
    /** Tracked directories (repo-relative, trailing-slash agnostic). At view time each
     *  directory is expanded via `git ls-files` to its current file set, so file
     *  renames/deletes within a tracked directory are handled automatically. */
    dirs?: string[];
}
