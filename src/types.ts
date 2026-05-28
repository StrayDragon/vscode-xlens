export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface DiffEntry {
    status: GitFileStatus;
    path: string;
    oldPath?: string;
}

export interface TreeNode {
    type: 'folder' | 'file';
    name: string;
    relativePath: string;
    status?: GitFileStatus;
    children: Map<string, TreeNode>;
}
