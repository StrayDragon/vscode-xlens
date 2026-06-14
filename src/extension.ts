import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitDiffTreeProvider } from './treeProvider';
import { getGitRepoRoot, getFilterPrefix, getDiffEntries, detectBaseBranch, execAsync, isValidBranchName } from './gitService';
import { GitStatusDecorationProvider } from './decorationProvider';
import { TreeNode, StatusDisplayMode, ViewMode, FileNode, FolderNode } from './types';
import {
    ensurePresetDir,
    listPresets,
    loadPreset,
    createPreset,
    deletePreset,
    renamePreset,
    addFilesToPreset,
    removeFilesFromPreset,
    updatePresetDescription,
} from './presetService';

const TEMP_DIR = path.join(os.tmpdir(), 'xlens-diff');

let provider: GitDiffTreeProvider | undefined;
let decorationProvider: GitStatusDecorationProvider | undefined;
let treeView: vscode.TreeView<TreeNode> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let repoRoot: string | undefined;
let detectedBaseBranch: string | undefined;
let configCache: Config | undefined;
let contextRef: vscode.ExtensionContext | undefined;

interface Config {
    autoReveal: boolean;
    autoRefresh: boolean;
    refreshDebounce: number;
    baseBranch: string;
    filterPrefix: string;
    statusDisplay: StatusDisplayMode;
}

function readConfig(): Config {
    const config = vscode.workspace.getConfiguration('gitDiffExplorer');
    return {
        autoReveal: config.get<boolean>('autoReveal', false),
        autoRefresh: config.get<boolean>('autoRefresh', true),
        refreshDebounce: config.get<number>('refreshDebounce', 2000),
        baseBranch: config.get<string>('baseBranch', ''),
        filterPrefix: config.get<string>('filterPrefix', ''),
        statusDisplay: config.get<StatusDisplayMode>('statusDisplay', 'badge'),
    };
}

function getConfig(): Config {
    return configCache ?? readConfig();
}

function getResolvedBaseBranch(preset?: { baseBranch?: string }): string {
    // Preset base branch override
    if (preset?.baseBranch) {
        return preset.baseBranch;
    }
    const cfg = getConfig();
    return cfg.baseBranch || detectedBaseBranch || 'master';
}

async function setContextKey(key: string, value: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', key, value);
}

// ── Helper: collect relative paths from tree nodes ──────────

function collectFilePathsFromNodes(nodes: TreeNode[]): string[] {
    const files = new Set<string>();

    for (const node of nodes) {
        if (node.type === 'file') {
            files.add(node.relativePath);
        } else if (node.type === 'folder') {
            // Walk the tree under this folder to collect all descendant files
            collectDescendantFiles(node, files);
        }
    }

    return [...files];
}

function collectDescendantFiles(folder: TreeNode, out: Set<string>): void {
    if (!provider || folder.type !== 'folder') { return; }
    for (const child of folder.children.values()) {
        if (child.type === 'file') {
            out.add(child.relativePath);
        } else {
            collectDescendantFiles(child, out);
        }
    }
}

// ── Helper: collect relative paths from URIs (File Explorer context menu) ──

async function collectFilePathsFromUris(uris: vscode.Uri[], repoRoot: string): Promise<string[]> {
    const files = new Set<string>();
    const dirs: string[] = [];

    for (const uri of uris) {
        const absPath = uri.fsPath;
        if (!absPath.startsWith(repoRoot)) { continue; }
        const rel = path.relative(repoRoot, absPath);
        if (rel.startsWith('..')) { continue; }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(absPath);
        } catch { continue; }

        if (stat.isDirectory()) {
            dirs.push(rel);
        } else if (rel) {
            files.add(rel);
        }
    }

    // Use git ls-files for directories to avoid recursive FS walk
    for (const dirRel of dirs) {
        try {
            const prefix = dirRel ? dirRel + '/' : '';
            const output = await execAsync(`git ls-files -- ${prefix}`, repoRoot);
            for (const line of output.split('\n')) {
                const trimmed = line.trim();
                if (trimmed) { files.add(trimmed); }
            }
        } catch { /* skip on git error */ }
    }

    return [...files];
}

// ── Presets Quick Pick ──────────────────────────────────────

async function showPresetsQuickPick(): Promise<void> {
    if (!repoRoot || !provider) { return; }

    const presets = listPresets(repoRoot);
    const isPresetMode = provider.getViewMode() === 'preset';
    const activeName = provider.getActivePresetName();

    const items: (vscode.QuickPickItem & { presetName?: string })[] = [];

    // Live view option
    items.push({
        label: `$(${isPresetMode ? 'circle-outline' : 'circle-filled'}) Live Git Diff`,
        description: isPresetMode ? '' : '$(check) active',
        presetName: undefined, // means switch to live
    });

    // Separator
    if (presets.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    // Presets
    for (const p of presets) {
        const isActive = isPresetMode && p.name === activeName;
        items.push({
            label: `$(${isActive ? 'pin' : 'circle-outline'}) ${p.name}`,
            description: p.description ? p.description.substring(0, 60) : `${p.fileCount} files`,
            detail: `${p.fileCount} files · ${p.baseBranch ? `base: ${p.baseBranch}` : 'default base'}`,
            presetName: p.name,
        });
    }

    // Actions separator
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    items.push({
        label: '$(save) Save Current Files as Preset...',
        description: '',
        presetName: '__save__',
    });

    if (isPresetMode && activeName) {
        items.push({
            label: '$(edit) Edit Preset Description...',
            presetName: '__edit_desc__',
        });
        items.push({
            label: '$(symbol-rename) Rename Preset...',
            presetName: '__rename__',
        });
    }

    items.push({
        label: '$(trash) Delete Preset...',
        presetName: '__delete__',
    });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: isPresetMode ? `Active: 📌 ${activeName}` : 'XLens Presets',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!pick || !pick.presetName) {
        // Selected Live view or cancelled
        if (pick && pick.presetName === undefined && isPresetMode) {
            await switchToLive();
        }
        return;
    }

    switch (pick.presetName) {
        case '__save__':
            await saveCurrentAsPreset();
            break;
        case '__edit_desc__':
            await editPresetDescription();
            break;
        case '__rename__':
            await renamePresetFlow();
            break;
        case '__delete__':
            await deletePresetFlow();
            break;
        default:
            await switchToPreset(pick.presetName);
    }
}

// ── Save / Switch / Delete / Rename / Edit flows ────────────

async function saveCurrentAsPreset(): Promise<void> {
    if (!repoRoot || !provider) { return; }

    const entries = provider.getCurrentEntries();
    if (entries.length === 0) {
        vscode.window.showWarningMessage('XLens: No changed files to save.');
        return;
    }

    const name = await vscode.window.showInputBox({
        prompt: 'Preset name',
        placeHolder: 'e.g. feature-auth',
        validateInput: (val) => {
            if (!val.trim()) { return 'Name is required'; }
            return undefined;
        },
    });
    if (!name) { return; }

    // Check for conflict
    const presets = listPresets(repoRoot);
    const existingNames = new Set(presets.map(p => p.name));
    if (existingNames.has(name)) {
        const overwrite = await vscode.window.showWarningMessage(
            `Preset "${name}" already exists. Overwrite?`,
            { modal: true },
            'Overwrite',
        );
        if (overwrite !== 'Overwrite') { return; }
        deletePreset(repoRoot, name);
    }

    const description = await vscode.window.showInputBox({
        prompt: 'Description (optional)',
        placeHolder: 'Brief description of this preset',
    });

    try {
        const files = entries.map(e => e.path);
        const preset = createPreset(repoRoot, name, files, description ?? undefined);
        await switchToPreset(preset.name);
        vscode.window.showInformationMessage(`XLens: Preset "${name}" saved with ${files.length} files.`);
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function switchToPreset(name: string): Promise<void> {
    if (!provider || !contextRef) { return; }

    provider.setViewMode('preset', name);
    await contextRef.workspaceState.update('xlensActivePreset', name);
    await setContextKey('xlens:presetActive', true);

    // Run git diff with potentially overridden base branch
    await doRefresh();

    updateViewTitle();
}

async function switchToLive(): Promise<void> {
    if (!provider || !contextRef) { return; }

    provider.setViewMode('live');
    await contextRef.workspaceState.update('xlensActivePreset', undefined);
    await setContextKey('xlens:presetActive', false);

    await doRefresh();

    updateViewTitle();
}

async function editPresetDescription(): Promise<void> {
    if (!repoRoot || !provider) { return; }
    const activeName = provider.getActivePresetName();
    if (!activeName) { return; }

    const preset = loadPreset(repoRoot, activeName);
    const description = await vscode.window.showInputBox({
        prompt: 'Edit description',
        value: preset.description,
        placeHolder: 'Brief description of this preset',
    });
    if (description === undefined) { return; } // cancelled

    updatePresetDescription(repoRoot, activeName, description ?? '');
}

async function renamePresetFlow(): Promise<void> {
    if (!repoRoot || !provider) { return; }
    const oldName = provider.getActivePresetName();
    if (!oldName) { return; }

    const newName = await vscode.window.showInputBox({
        prompt: 'New name for preset',
        value: oldName,
        validateInput: (val) => {
            if (!val.trim()) { return 'Name is required'; }
            return undefined;
        },
    });
    if (!newName || newName === oldName) { return; }

    try {
        renamePreset(repoRoot, oldName, newName);
        await switchToPreset(newName);
        vscode.window.showInformationMessage(`XLens: Preset renamed to "${newName}".`);
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function deletePresetFlow(): Promise<void> {
    if (!repoRoot || !provider) { return; }

    const presets = listPresets(repoRoot);
    if (presets.length === 0) {
        vscode.window.showInformationMessage('XLens: No presets to delete.');
        return;
    }

    const picks = presets.map(p => ({ label: p.name, description: `${p.fileCount} files`, presetName: p.name }));
    const pick = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select preset to delete',
    });
    if (!pick) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Delete preset "${pick.label}"? This cannot be undone.`,
        { modal: true },
        'Delete',
    );
    if (confirm !== 'Delete') { return; }

    try {
        deletePreset(repoRoot, pick.label);
        const activeName = provider.getActivePresetName();
        if (activeName === pick.label) {
            await switchToLive();
        }
        vscode.window.showInformationMessage(`XLens: Preset "${pick.label}" deleted.`);
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function updateViewTitle(): void {
    if (!treeView || !provider) { return; }

    const activeName = provider.getActivePresetName();
    if (provider.getViewMode() === 'preset' && activeName) {
        treeView.title = `XLens: 📌 ${activeName}`;
    } else {
        treeView.title = 'XLens';
    }
}

// ── Activate ────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
    contextRef = context;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('XLens: No workspace folder open.');
        return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;

    try {
        repoRoot = await getGitRepoRoot(workspacePath);
    } catch {
        vscode.window.showWarningMessage('XLens: Not a git repository.');
        return;
    }

    // Ensure preset directory exists
    try {
        ensurePresetDir(repoRoot);
    } catch {
        // Not critical
    }

    configCache = readConfig();

    provider = new GitDiffTreeProvider(repoRoot);
    decorationProvider = new GitStatusDecorationProvider(repoRoot);
    context.subscriptions.push(provider, decorationProvider);
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(decorationProvider),
    );

    provider.setDisplayMode(configCache.statusDisplay);
    decorationProvider.setDisplayMode(configCache.statusDisplay);

    detectedBaseBranch = await detectBaseBranch(repoRoot);

    treeView = vscode.window.createTreeView('gitDiffExplorerView', {
        treeDataProvider: provider,
        showCollapseAll: true,
        canSelectMany: true,
    });
    context.subscriptions.push(treeView);

    // Restore active preset from workspace state
    const savedPreset = context.workspaceState.get<string>('xlensActivePreset');
    if (savedPreset) {
        // Validate that the preset still exists
        try {
            loadPreset(repoRoot, savedPreset);
            provider.setViewMode('preset', savedPreset);
            await setContextKey('xlens:presetActive', true);
        } catch {
            // Preset no longer exists, reset to live
            context.workspaceState.update('xlensActivePreset', undefined);
            await setContextKey('xlens:presetActive', false);
        }
    } else {
        await setContextKey('xlens:presetActive', false);
    }

    // Initial load
    await doRefresh();
    updateViewTitle();

    // ── Commands ────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.refresh', () => doRefresh()),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('xlens.showPresets', () => showPresetsQuickPick()),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('xlens.preset.switchToLive', () => switchToLive()),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('xlens.preset.addFiles', async (clicked: TreeNode, selected?: TreeNode[]) => {
            if (!repoRoot || !provider) { return; }

            // Collect nodes: if multi-selected, use selected array; otherwise use the single clicked node
            const nodes: TreeNode[] = selected && selected.length > 0 ? selected : [clicked];
            const filePaths = collectFilePathsFromNodes(nodes);
            if (filePaths.length === 0) {
                vscode.window.showInformationMessage('XLens: No files to add.');
                return;
            }

            // Determine target preset
            let targetPreset: string;

            if (provider.getViewMode() === 'preset' && provider.getActivePresetName()) {
                // Auto-add to active preset
                targetPreset = provider.getActivePresetName()!;
            } else {
                // Show preset picker
                const presets = listPresets(repoRoot);
                if (presets.length === 0) {
                    const create = await vscode.window.showInformationMessage(
                        'No presets yet. Create one?',
                        'Create',
                    );
                    if (create === 'Create') {
                        await saveCurrentAsPreset();
                    }
                    return;
                }

                const picks = presets.map(p => ({
                    label: p.name,
                    description: `${p.fileCount} files`,
                    presetName: p.name,
                }));

                const pick = await vscode.window.showQuickPick(picks, {
                    placeHolder: 'Select preset to add files to...',
                });
                if (!pick) { return; }
                targetPreset = pick.presetName;
            }

            try {
                addFilesToPreset(repoRoot, targetPreset, filePaths);

                // If we're currently viewing this preset, refresh
                if (provider.getViewMode() === 'preset' && provider.getActivePresetName() === targetPreset) {
                    await doRefresh();
                }

                vscode.window.showInformationMessage(
                    `XLens: Added ${filePaths.length} file(s) to preset "${targetPreset}".`,
                );
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('xlens.preset.addFilesFromExplorer', async (clicked: vscode.Uri, selected?: vscode.Uri[]) => {
            if (!repoRoot || !provider) { return; }

            const uris: vscode.Uri[] = selected && selected.length > 0 ? selected : [clicked];
            const filePaths = await collectFilePathsFromUris(uris, repoRoot);
            if (filePaths.length === 0) {
                vscode.window.showInformationMessage('XLens: No files to add.');
                return;
            }

            // Show preset picker
            const presets = listPresets(repoRoot);
            if (presets.length === 0) {
                const create = await vscode.window.showInformationMessage(
                    'No presets yet. Create one?',
                    'Create',
                );
                if (create === 'Create') {
                    await saveCurrentAsPreset();
                }
                return;
            }

            const picks = presets.map(p => ({
                label: p.name,
                description: `${p.fileCount} files`,
                presetName: p.name,
            }));

            const pick = await vscode.window.showQuickPick(picks, {
                placeHolder: `Add ${filePaths.length} file(s) to preset...`,
            });
            if (!pick) { return; }

            try {
                addFilesToPreset(repoRoot, pick.presetName, filePaths);

                // If viewing this preset, refresh
                if (provider.getViewMode() === 'preset' && provider.getActivePresetName() === pick.presetName) {
                    await doRefresh();
                }

                vscode.window.showInformationMessage(
                    `XLens: Added ${filePaths.length} file(s) to preset "${pick.presetName}".`,
                );
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('xlens.preset.removeFiles', async (clicked: TreeNode, selected?: TreeNode[]) => {
            if (!repoRoot || !provider) { return; }
            const activeName = provider.getActivePresetName();
            if (!activeName) { return; }

            const nodes: TreeNode[] = selected && selected.length > 0 ? selected : [clicked];
            const filePaths = nodes
                .filter(n => n.type === 'file')
                .map(n => n.relativePath);

            if (filePaths.length === 0) {
                vscode.window.showInformationMessage('XLens: No files to remove.');
                return;
            }

            try {
                removeFilesFromPreset(repoRoot, activeName, filePaths);
                await doRefresh();
                vscode.window.showInformationMessage(
                    `XLens: Removed ${filePaths.length} file(s) from preset "${activeName}".`,
                );
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.openDiff', async (node: TreeNode) => {
            if (!repoRoot || node.type !== 'file') { return; }
            const baseBranch = getResolvedBaseBranch();
            const currentPath = path.join(repoRoot, node.relativePath);

            let baseContent: string;
            try {
                baseContent = await execAsync(
                    `git show ${baseBranch}:${node.relativePath}`,
                    repoRoot,
                );
            } catch {
                vscode.window.showInformationMessage(
                    `XLens: This file does not exist on ${baseBranch}. Opening current version instead.`,
                );
                vscode.window.showTextDocument(vscode.Uri.file(currentPath));
                return;
            }

            fs.mkdirSync(TEMP_DIR, { recursive: true });
            const safeName = node.relativePath.replace(/[\/\\]/g, '_');
            const tempPath = path.join(TEMP_DIR, `${baseBranch}...${safeName}`);
            fs.writeFileSync(tempPath, baseContent);

            const baseUri = vscode.Uri.file(tempPath);
            const currentUri = vscode.Uri.file(currentPath);
            const title = `${node.relativePath} (${baseBranch} ↔ Current)`;
            vscode.commands.executeCommand('vscode.diff', baseUri, currentUri, title).then(undefined, () => {});
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.openFile', (node?: TreeNode) => {
            if (!repoRoot || !node || node.type !== 'file') { return; }
            const filePath = path.join(repoRoot, node.relativePath);
            vscode.window.showTextDocument(vscode.Uri.file(filePath));
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.copyPath', (node: TreeNode) => {
            vscode.env.clipboard.writeText(node.relativePath);
            vscode.window.showInformationMessage(`Copied: ${node.relativePath}`);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.changeBaseBranch', async () => {
            const current = getResolvedBaseBranch();
            const picks = ['master', 'main', 'develop', 'trunk'].map(b => ({
                label: b,
                description: b === current ? '$(check) current' : '',
            }));
            const input = await vscode.window.showQuickPick(picks, {
                placeHolder: `Current: ${current}. Select base branch...`,
            });
            if (input && input.label !== current) {
                detectedBaseBranch = input.label;
                const config = vscode.workspace.getConfiguration('gitDiffExplorer');
                await config.update('baseBranch', input.label, vscode.ConfigurationTarget.Global);
                doRefresh();
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.newFile', async (node: TreeNode) => {
            if (!repoRoot || node.type !== 'folder') { return; }
            const fileName = await vscode.window.showInputBox({
                prompt: `New file under ${node.relativePath || '/'}`,
                placeHolder: 'e.g. utils.ts, sub/dir/file.ts',
            });
            if (!fileName) { return; }
            const filePath = path.resolve(repoRoot, node.relativePath, fileName);
            if (!filePath.startsWith(repoRoot + path.sep) && filePath !== repoRoot) {
                vscode.window.showErrorMessage('XLens: Path is outside the repository.');
                return;
            }
            const dir = path.dirname(filePath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, '');
            await vscode.window.showTextDocument(vscode.Uri.file(filePath));
            scheduleRefresh();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.revealInExplorer', (node: TreeNode) => {
            if (!repoRoot) { return; }
            const filePath = path.join(repoRoot, node.relativePath);
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(filePath)).then(undefined, () => {});
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.revealActiveFile', async () => {
            if (!provider || !repoRoot || !treeView) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const filePath = editor.document.uri.fsPath;
            const rel = path.relative(repoRoot, filePath);
            provider.setActivePath(rel || undefined);
            const node = provider.findNodeByAbsPath(filePath);
            if (node) {
                await treeView.reveal(node, { select: true, focus: true, expand: 3 }).then(undefined, () => {});
            } else {
                vscode.window.showInformationMessage('XLens: File not found in changed files.');
            }
        }),
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || !provider || !repoRoot || !treeView) { return; }
            const cfg = getConfig();
            if (!cfg.autoReveal) { return; }
            const filePath = editor.document.uri.fsPath;
            const rel = path.relative(repoRoot, filePath);
            provider.setActivePath(rel || undefined);
            const node = provider.findNodeByAbsPath(filePath);
            if (node) {
                treeView.reveal(node, { select: true, focus: false, expand: 3 }).then(undefined, () => {});
            }
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()),
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gitDiffExplorer')) {
                configCache = readConfig();
                const mode = configCache.statusDisplay;
                provider?.setDisplayMode(mode);
                decorationProvider?.setDisplayMode(mode);
                scheduleRefresh();
            }
        }),
    );

    // Watch for git state changes
    try {
        const gitExt = vscode.extensions.getExtension<{ getAPI(version: number): GitAPI }>('vscode.git');
        if (gitExt) {
            if (!gitExt.isActive) { await gitExt.activate(); }
            const gitApi = gitExt.exports.getAPI(1);
            for (const repo of gitApi.repositories) {
                context.subscriptions.push(
                    repo.state.onDidChange(() => scheduleRefresh()),
                );
            }
            context.subscriptions.push(
                gitApi.onDidOpenRepository((r) => {
                    context.subscriptions.push(
                        r.state.onDidChange(() => scheduleRefresh()),
                    );
                }),
            );
        }
    } catch {
        // Git extension not available; auto-refresh via file save still works
    }
}

function scheduleRefresh() {
    const cfg = getConfig();
    if (!cfg.autoRefresh) { return; }

    if (refreshTimer) { clearTimeout(refreshTimer); }
    refreshTimer = setTimeout(() => doRefresh(), cfg.refreshDebounce);
}

let refreshInFlight = false;

async function doRefresh() {
    if (!provider || !repoRoot) { return; }
    if (refreshInFlight) { return; }
    refreshInFlight = true;

    try {
        const cfg = getConfig();

        // Load preset once if in preset mode (avoid double-load)
        let presetBaseBranch: string | undefined;
        if (provider.getViewMode() === 'preset' && provider.getActivePresetName()) {
            try {
                const preset = loadPreset(repoRoot, provider.getActivePresetName()!);
                presetBaseBranch = preset.baseBranch;
            } catch { /* ignore */ }
        }

        const baseBranch = getResolvedBaseBranch(presetBaseBranch ? { baseBranch: presetBaseBranch } : undefined);
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) { return; }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        const filterPrefix = getFilterPrefix(workspacePath, repoRoot, cfg.filterPrefix);

        const entries = await getDiffEntries(repoRoot, baseBranch, filterPrefix);
        provider.refresh(entries);
        decorationProvider?.updateStatuses(provider.getStatusMap());
        updateViewTitle();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`XLens: ${message}`);
        provider.clear();
        decorationProvider?.updateStatuses(new Map());
    } finally {
        refreshInFlight = false;
    }
}

export function deactivate() {
    if (refreshTimer) { clearTimeout(refreshTimer); }
    provider = undefined;
    decorationProvider = undefined;
    treeView = undefined;
    configCache = undefined;
    repoRoot = undefined;
    detectedBaseBranch = undefined;
    contextRef = undefined;
    try {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch {
        // ignore
    }
}

// Minimal type for vscode.git extension API
interface GitAPI {
    repositories: GitRepository[];
    onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitRepository {
    state: GitRepositoryState;
}

interface GitRepositoryState {
    onDidChange: vscode.Event<void>;
}
