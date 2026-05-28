import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, GitFileStatus, TreeNode } from './types';

const STATUS_ICONS: Record<GitFileStatus, { id: string; color: vscode.ThemeColor }> = {
    A: { id: 'diff-added', color: new vscode.ThemeColor('charts.green') },
    M: { id: 'diff-modified', color: new vscode.ThemeColor('charts.yellow') },
    D: { id: 'diff-removed', color: new vscode.ThemeColor('charts.red') },
    R: { id: 'diff-renamed', color: new vscode.ThemeColor('charts.blue') },
    C: { id: 'diff-added', color: new vscode.ThemeColor('charts.green') },
    T: { id: 'diff-modified', color: new vscode.ThemeColor('charts.yellow') },
    U: { id: 'diff-modified', color: new vscode.ThemeColor('charts.yellow') },
    '?': { id: 'question', color: new vscode.ThemeColor('charts.foreground') },
};

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

export class GitDiffTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rootNode: TreeNode | null = null;
    private parentMap = new Map<TreeNode, TreeNode>();

    constructor(private repoRoot: string) {}

    refresh(entries: DiffEntry[]): void {
        this.rootNode = this.buildTree(entries);
        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.rootNode = null;
        this.parentMap.clear();
        this._onDidChangeTreeData.fire();
    }

    findNodeByAbsPath(absPath: string): TreeNode | undefined {
        if (!this.rootNode) { return undefined; }
        const rel = path.relative(this.repoRoot, absPath);
        if (!rel) { return undefined; }
        return this.findNodeInTree(this.rootNode, rel);
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'folder') {
            const item = new vscode.TreeItem(
                element.name,
                vscode.TreeItemCollapsibleState.Collapsed,
            );
            item.iconPath = vscode.ThemeIcon.Folder;
            item.resourceUri = vscode.Uri.file(path.join(this.repoRoot, element.relativePath));
            item.contextValue = 'folder';
            const count = this.countFiles(element);
            item.description = `${count} file${count !== 1 ? 's' : ''}`;
            return item;
        }

        const item = new vscode.TreeItem(
            element.name,
            vscode.TreeItemCollapsibleState.None,
        );

        const filePath = path.join(this.repoRoot, element.relativePath);
        item.resourceUri = vscode.Uri.file(filePath);

        const status = element.status!;
        const iconDef = STATUS_ICONS[status];
        item.iconPath = new vscode.ThemeIcon(iconDef.id, iconDef.color);
        item.description = STATUS_LABELS[status];
        item.contextValue = `file_${status.toLowerCase()}`;

        item.command = {
            command: 'gitDiffExplorer.openFile',
            title: 'Open File',
            arguments: [element],
        };

        return item;
    }

    getChildren(element?: TreeNode): TreeNode[] {
        if (!element) {
            if (!this.rootNode) { return []; }
            return Array.from(this.rootNode.children.values()).sort((a, b) => {
                if (a.type !== b.type) { return a.type === 'folder' ? -1 : 1; }
                return a.name.localeCompare(b.name);
            });
        }
        return Array.from(element.children.values()).sort((a, b) => {
            if (a.type !== b.type) { return a.type === 'folder' ? -1 : 1; }
            return a.name.localeCompare(b.name);
        });
    }

    getParent(element: TreeNode): TreeNode | undefined {
        return this.parentMap.get(element);
    }

    private buildTree(entries: DiffEntry[]): TreeNode {
        this.parentMap.clear();
        const root: TreeNode = {
            type: 'folder',
            name: '',
            relativePath: '',
            children: new Map(),
        };

        for (const entry of entries) {
            const parts = entry.path.split('/').filter(Boolean);
            let current = root;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isFile = i === parts.length - 1;

                if (isFile) {
                    const node: TreeNode = {
                        type: 'file',
                        name: part,
                        relativePath: entry.path,
                        status: entry.status,
                        children: new Map(),
                    };
                    current.children.set(part, node);
                    this.parentMap.set(node, current);
                } else {
                    if (!current.children.has(part)) {
                        const folder: TreeNode = {
                            type: 'folder',
                            name: part,
                            relativePath: parts.slice(0, i + 1).join('/'),
                            children: new Map(),
                        };
                        current.children.set(part, folder);
                        this.parentMap.set(folder, current);
                    }
                    current = current.children.get(part)!;
                }
            }
        }

        return root;
    }

    private findNodeInTree(node: TreeNode, relPath: string): TreeNode | undefined {
        for (const child of node.children.values()) {
            if (child.relativePath === relPath) { return child; }
            if (child.type === 'folder') {
                const found = this.findNodeInTree(child, relPath);
                if (found) { return found; }
            }
        }
        return undefined;
    }

    private countFiles(node: TreeNode): number {
        let count = 0;
        for (const child of node.children.values()) {
            if (child.type === 'file') {
                count++;
            } else {
                count += this.countFiles(child);
            }
        }
        return count;
    }
}
