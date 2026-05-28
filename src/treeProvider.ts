import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, GitFileStatus, TreeNode, FolderNode, FileNode, StatusDisplayMode } from './types';

const STATUS_LABELS: Record<GitFileStatus, string> = {
    A: 'Added',
    M: 'Modified',
    D: 'Deleted',
    R: 'Renamed',
    C: 'Copied',
    T: 'Type Changed',
    U: 'Unmerged',
    '?': 'Untracked',
};

const nodeSorter = (a: TreeNode, b: TreeNode): number => {
    if (a.type !== b.type) { return a.type === 'folder' ? -1 : 1; }
    return a.name.localeCompare(b.name);
};

export class GitDiffTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rootNode: FolderNode | null = null;
    private nodeByPath = new Map<string, TreeNode>();
    private statusMap = new Map<string, GitFileStatus>();
    private activePath: string | undefined;
    private displayMode: StatusDisplayMode = 'badge';

    constructor(private repoRoot: string) {}

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    setDisplayMode(mode: StatusDisplayMode): void {
        this.displayMode = mode;
        this._onDidChangeTreeData.fire();
    }

    getStatusMap(): Map<string, GitFileStatus> {
        return this.statusMap;
    }

    refresh(entries: DiffEntry[]): void {
        this.rootNode = this.buildTree(entries);
        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.rootNode = null;
        this.nodeByPath.clear();
        this.statusMap.clear();
        this.activePath = undefined;
        this._onDidChangeTreeData.fire();
    }

    setActivePath(relPath: string | undefined): void {
        if (this.activePath === relPath) { return; }
        this.activePath = relPath;
        this._onDidChangeTreeData.fire();
    }

    findNodeByAbsPath(absPath: string): TreeNode | undefined {
        if (!this.rootNode) { return undefined; }
        const rel = path.relative(this.repoRoot, absPath);
        if (!rel || rel.startsWith('..')) { return undefined; }
        return this.nodeByPath.get(rel);
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'folder') {
            return this.getFolderTreeItem(element);
        }
        return this.getFileTreeItem(element);
    }

    getChildren(element?: TreeNode): TreeNode[] {
        const node = element ?? this.rootNode;
        if (!node || node.type !== 'folder') { return []; }
        return Array.from(node.children.values()).sort(nodeSorter);
    }

    getParent(element: TreeNode): TreeNode | undefined {
        if (element === this.rootNode) { return undefined; }
        const parentRel = path.dirname(element.relativePath);
        if (parentRel === '.' || parentRel === '') { return undefined; }
        const parent = this.nodeByPath.get(parentRel);
        return parent?.type === 'folder' ? parent : undefined;
    }

    private getFolderTreeItem(element: FolderNode): vscode.TreeItem {
        const isOnActivePath = this.activePath !== undefined &&
            (this.activePath.startsWith(element.relativePath + '/') ||
             this.activePath === element.relativePath);
        const item = new vscode.TreeItem(
            element.name,
            isOnActivePath
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = vscode.ThemeIcon.Folder;
        item.resourceUri = vscode.Uri.file(path.join(this.repoRoot, element.relativePath));
        item.contextValue = 'folder';
        const count = element.fileCount;
        item.description = `${count} file${count !== 1 ? 's' : ''}`;
        return item;
    }

    private getFileTreeItem(element: FileNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            element.name,
            vscode.TreeItemCollapsibleState.None,
        );
        const filePath = path.join(this.repoRoot, element.relativePath);
        item.resourceUri = vscode.Uri.file(filePath);
        // iconPath intentionally not set — VS Code resolves file-type icon from resourceUri + user's icon theme
        if (this.displayMode === 'description') {
            item.description = STATUS_LABELS[element.status];
        }
        item.contextValue = `file_${element.status.toLowerCase()}`;
        item.command = {
            command: 'gitDiffExplorer.openFile',
            title: 'Open File',
            arguments: [element],
        };
        return item;
    }

    private buildTree(entries: DiffEntry[]): FolderNode {
        this.nodeByPath.clear();
        this.statusMap.clear();

        const root: FolderNode = {
            type: 'folder',
            name: '',
            relativePath: '',
            children: new Map(),
            fileCount: 0,
        };
        this.nodeByPath.set('', root);

        for (const entry of entries) {
            const parts = entry.path.split('/').filter(Boolean);
            let current = root;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isFile = i === parts.length - 1;

                if (isFile) {
                    const node: FileNode = {
                        type: 'file',
                        name: part,
                        relativePath: entry.path,
                        status: entry.status,
                    };
                    current.children.set(part, node);
                    this.nodeByPath.set(entry.path, node);
                    this.statusMap.set(entry.path, entry.status);
                } else {
                    const folderPath = parts.slice(0, i + 1).join('/');
                    let folder = current.children.get(part);
                    if (!folder) {
                        folder = {
                            type: 'folder',
                            name: part,
                            relativePath: folderPath,
                            children: new Map(),
                            fileCount: 0,
                        };
                        current.children.set(part, folder);
                        this.nodeByPath.set(folderPath, folder);
                    }
                    current = folder as FolderNode;
                }
            }
        }

        this.computeFileCounts(root);
        return root;
    }

    private computeFileCounts(node: FolderNode): number {
        let count = 0;
        for (const child of node.children.values()) {
            if (child.type === 'file') {
                count++;
            } else {
                count += this.computeFileCounts(child);
            }
        }
        node.fileCount = count;
        return count;
    }
}
