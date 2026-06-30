import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, GitFileStatus, TreeNode, FolderNode, FileNode, StatusDisplayMode, ViewMode } from './types';
import { loadPreset } from './presetService';

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

    // Preset state
    private viewMode: ViewMode = 'live';
    private activePresetName: string | undefined;
    private presetFiles: string[] = [];
    private currentEntries: DiffEntry[] = [];
    // Fully resolved preset file set (explicit files + directories expanded via git).
    // Set from doRefresh before refresh(). When unset (e.g. right after switchToPreset),
    // buildPresetTree falls back to the raw `preset.files` on disk as a best-effort view.
    private presetResolvedFiles: string[] | undefined;

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

    // ── Preset mode ──────────────────────────────────────────

    getViewMode(): ViewMode {
        return this.viewMode;
    }

    getActivePresetName(): string | undefined {
        return this.activePresetName;
    }

    getPresetFiles(): string[] {
        return this.presetFiles;
    }

    getCurrentEntries(): DiffEntry[] {
        return this.currentEntries;
    }

    setViewMode(mode: ViewMode, presetName?: string): void {
        this.viewMode = mode;
        // Invalidate resolved files; doRefresh will recompute (possibly expanding dirs).
        this.presetResolvedFiles = undefined;
        if (mode === 'live') {
            this.activePresetName = undefined;
            this.presetFiles = [];
        } else {
            this.activePresetName = presetName;
        }
        // Rebuild with cached entries
        this.rebuildTree();
    }

    /** Store the directory-resolved file set and refresh the tree. Does not fire a
     *  rebuild by itself — pair with refresh(). */
    setPresetResolvedFiles(files: string[]): void {
        this.presetResolvedFiles = files;
    }

    // ── Refresh ──────────────────────────────────────────────

    refresh(entries: DiffEntry[]): void {
        this.currentEntries = entries;
        this.rebuildTree();
    }

    clear(): void {
        this.rootNode = null;
        this.nodeByPath.clear();
        this.statusMap.clear();
        this.activePath = undefined;
        this.currentEntries = [];
        this.presetFiles = [];
        this.presetResolvedFiles = undefined;
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

    // ── TreeDataProvider ─────────────────────────────────────

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

    // ── Tree building (core) ─────────────────────────────────

    private rebuildTree(): void {
        if (this.viewMode === 'preset' && this.activePresetName) {
            this.buildPresetTree();
        } else {
            this.buildLiveTree();
        }
        this._onDidChangeTreeData.fire();
    }

    private buildLiveTree(): void {
        this.statusMap.clear();
        this.rootNode = this.buildTreeFromEntries(this.currentEntries);
    }

    private buildPresetTree(): void {
        this.nodeByPath.clear();
        this.statusMap.clear();

        if (!this.activePresetName) {
            this.rootNode = null;
            return;
        }

        // Load preset
        let presetFiles: string[];
        if (this.presetResolvedFiles) {
            // Directories already expanded by doRefresh → use the resolved set.
            presetFiles = this.presetResolvedFiles;
        } else {
            // Best-effort initial view: read explicit files from disk (dirs not yet
            // expanded). doRefresh() will recompute shortly.
            try {
                const preset = loadPreset(this.repoRoot, this.activePresetName);
                presetFiles = preset.files;
            } catch {
                this.presetFiles = [];
                this.rootNode = null;
                return;
            }
        }
        this.presetFiles = presetFiles;

        if (presetFiles.length === 0) {
            this.rootNode = this.makeEmptyPresetRoot();
            return;
        }

        // Build a live-indexed map: path → DiffEntry
        const liveByPath = new Map<string, DiffEntry>();
        for (const entry of this.currentEntries) {
            liveByPath.set(entry.path, entry);
        }

        // Prepare entries for tree building
        // Clean files: assume they exist (no per-file fs.existsSync).
        // VS Code handles "file not found" when user opens it.
        const merged: DiffEntry[] = [];

        for (const filePath of presetFiles) {
            const liveEntry = liveByPath.get(filePath);

            if (liveEntry) {
                // File is in git diff — show with live status
                this.statusMap.set(filePath, liveEntry.status);
                merged.push(liveEntry);
            } else {
                // File is in preset but not in git diff → clean
                const entry: DiffEntry = { status: 'M' as GitFileStatus, path: filePath };
                // Don't add to statusMap — no decoration for clean files
                merged.push(entry);
            }
        }

        // Build tree and mark clean files
        this.rootNode = this.buildTreeFromEntries(merged);
        this.markCleanNodes(liveByPath);
    }

    private markCleanNodes(liveByPath: Map<string, DiffEntry>): void {
        for (const [, node] of this.nodeByPath) {
            if (node.type !== 'file') { continue; }
            const fileNode = node as FileNode;
            const hasLiveStatus = liveByPath.has(fileNode.relativePath);
            fileNode.isClean = !hasLiveStatus;
            fileNode.isMissing = false;
        }
    }

    private makeEmptyPresetRoot(): FolderNode {
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
        return root;
    }

    private buildTreeFromEntries(entries: DiffEntry[]): FolderNode {
        this.nodeByPath.clear();

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

    // ── Tree items ───────────────────────────────────────────

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
        // contextValue: folders get _inPreset suffix in preset mode
        item.contextValue = this.viewMode === 'preset' ? 'folder_inPreset' : 'folder';
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

        const inPresetMode = this.viewMode === 'preset';

        if (inPresetMode && element.isClean) {
            // Clean/unchanged. Note: TreeItem.description does NOT render $(...) codicons,
            // they would appear literally — so use plain text here. A circular badge is
            // conveyed via the decorationProvider (or the "clean" label).
            item.description = 'clean';
            item.tooltip = 'Not changed from base branch (tracked by preset)';
            // Keep the file-type icon by NOT overriding iconPath — VS Code resolves it from resourceUri.
        } else if (this.displayMode === 'description') {
            item.description = STATUS_LABELS[element.status];
        }

        // iconPath intentionally not set for normal files — VS Code resolves file-type icon from resourceUri
        // Only set for special states above

        // contextValue
        const statusSuffix = element.status.toLowerCase();
        if (inPresetMode) {
            if (element.isClean) {
                item.contextValue = `file_clean_inPreset`;
            } else {
                item.contextValue = `file_${statusSuffix}_inPreset`;
            }
        } else {
            item.contextValue = `file_${statusSuffix}`;
        }

        item.command = {
            command: 'xlens.gitDiffView.openFile',
            title: 'Open File',
            arguments: [element],
        };
        return item;
    }
}
