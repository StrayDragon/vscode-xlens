export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export type StatusDisplayMode = 'badge' | 'description' | 'hidden';

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
}

export type TreeNode = FolderNode | FileNode;
