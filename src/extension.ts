import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitDiffTreeProvider } from './treeProvider';
import { getGitRepoRoot, getFilterPrefix, getDiffEntries, detectBaseBranch, execAsync, isValidBranchName, listRepoFiles, expandDirsToTrackedFiles } from './gitService';
import { GitStatusDecorationProvider } from './decorationProvider';
import { TreeNode } from './types';
import {
    listPresets,
    loadPreset,
    createPreset,
    deletePreset,
    renamePreset,
    addFilesToPreset,
    removeFilesFromPreset,
    addDirsToPreset,
    removeDirsFromPreset,
    updatePresetDescription,
} from './presetService';
import { readGitDiffViewConfig, affectsGitDiffViewConfiguration, updateGitDiffViewSetting, migrateLegacyGitDiffViewConfig } from './config';
import { pickFilesForCustomPreset } from './presetPicker';

const TEMP_DIR = path.join(os.tmpdir(), 'xlens-diff');

let provider: GitDiffTreeProvider | undefined;
let decorationProvider: GitStatusDecorationProvider | undefined;
let treeView: vscode.TreeView<TreeNode> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let repoRoot: string | undefined;
let detectedBaseBranch: string | undefined;
let configCache: Config | undefined;
let contextRef: vscode.ExtensionContext | undefined;

type Config = ReturnType<typeof readGitDiffViewConfig>;

function readConfig(): Config {
    return readGitDiffViewConfig();
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

/** Split Explorer URIs into repo-relative directory paths and file paths.
 *  Directories are returned as-is (to be tracked as stable dirs), NOT expanded. */
async function collectPathsFromUris(
    uris: vscode.Uri[],
    repoRoot: string,
): Promise<{ dirPaths: string[]; filePaths: string[] }> {
    const files = new Set<string>();
    const dirs = new Set<string>();

    for (const uri of uris) {
        const absPath = uri.fsPath;
        if (!absPath.startsWith(repoRoot)) { continue; }
        const rel = path.relative(repoRoot, absPath);
        if (rel.startsWith('..') || rel === '') { continue; }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(absPath);
        } catch { continue; }

        if (stat.isDirectory()) {
            dirs.add(rel);
        } else {
            files.add(rel);
        }
    }

    return { dirPaths: [...dirs].sort(), filePaths: [...files].sort() };
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
            description: p.description ? p.description.substring(0, 60) : `${p.fileCount} files${p.dirCount ? ` · ${p.dirCount} dir${p.dirCount !== 1 ? 's' : ''}` : ''}`,
            detail: `${p.fileCount} file${p.fileCount !== 1 ? 's' : ''}${p.dirCount ? ` · ${p.dirCount} tracked dir${p.dirCount !== 1 ? 's' : ''}` : ''} · ${p.baseBranch ? `base: ${p.baseBranch}` : 'default base'}`,
            presetName: p.name,
        });
    }

    // Actions separator
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    items.push({
        label: '$(save) Save Current Files as Preset...',
        description: 'Save all changed files',
        presetName: '__save__',
    });

    items.push({
        label: '$(list-selection) Create Custom Preset...',
        description: 'Browse project files and pick what to watch',
        presetName: '__custom__',
    });

    if (isPresetMode && activeName) {
        items.push({
            label: '$(edit) Edit Preset Description...',
            presetName: '__edit_desc__',
        });
        items.push({
            label: '$(pencil) Rename Preset...',
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
        case '__custom__':
            await createCustomPreset();
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

async function createCustomPreset(): Promise<void> {
    if (!repoRoot) { return; }

    const cfg = getConfig();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) { return; }

    const filterPrefix = getFilterPrefix(
        workspaceFolders[0].uri.fsPath,
        repoRoot,
        cfg.filterPrefix,
    );

    let allFiles: string[];
    try {
        allFiles = await listRepoFiles(repoRoot, filterPrefix);
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    const selection = await pickFilesForCustomPreset(allFiles);
    if (!selection) { return; }

    await savePresetWithFiles(selection.files, 'Preset name for watched files', selection.dirs);
}

async function savePresetWithFiles(files: string[], namePrompt: string, dirs?: string[]): Promise<void> {
    if (!repoRoot || !provider) { return; }

    const name = await vscode.window.showInputBox({
        prompt: namePrompt,
        placeHolder: 'e.g. feature-auth',
        validateInput: (val) => {
            if (!val.trim()) { return 'Name is required'; }
            return undefined;
        },
    });
    if (!name) { return; }

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
        const preset = createPreset(repoRoot, name, files, description ?? undefined, undefined, dirs);
        await switchToPreset(preset.name);
        const fileCount = preset.files.length;
        const dirCount = (preset.dirs ?? []).length;
        if (dirCount > 0) {
            vscode.window.showInformationMessage(
                `XLens: Preset "${name}" saved — ${fileCount} file(s) · ${dirCount} tracked dir${dirCount !== 1 ? 's' : ''}.`,
            );
        } else {
            vscode.window.showInformationMessage(
                `XLens: Preset "${name}" saved with ${fileCount} file(s).`,
            );
        }
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function saveCurrentAsPreset(): Promise<void> {
    if (!repoRoot || !provider) { return; }

    const entries = provider.getCurrentEntries();
    if (entries.length === 0) {
        vscode.window.showWarningMessage('XLens: No changed files to save.');
        return;
    }

    await savePresetWithFiles(entries.map(e => e.path), 'Preset name');
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

function registerAllCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('xlens.gitDiffView.refresh', () => doRefresh()),
        vscode.commands.registerCommand('xlens.gitDiffView.expandAll', async () => {
            if (!provider || !treeView) { return; }
            const nodes = provider.getAllNodes();
            for (const node of nodes) {
                if (node.type !== 'folder') { continue; }
                await treeView.reveal(node, { select: false, focus: false, expand: true }).then(undefined, () => {});
            }
        }),
        vscode.commands.registerCommand('xlens.showPresets', () => showPresetsQuickPick()),
        vscode.commands.registerCommand('xlens.preset.switchToLive', () => switchToLive()),
        vscode.commands.registerCommand('xlens.preset.addFiles', async (clicked: TreeNode, selected?: TreeNode[]) => {
            if (!repoRoot || !provider) { return; }

            const nodes: TreeNode[] = selected && selected.length > 0 ? selected : [clicked];
            // Folders → tracked directories (stable). Files → explicit tracked paths.
            const dirPaths = nodes.filter(n => n.type === 'folder').map(n => n.relativePath);
            const filePaths = collectFilePathsFromNodes(nodes.filter(n => n.type === 'file'));
            if (dirPaths.length === 0 && filePaths.length === 0) {
                vscode.window.showInformationMessage('XLens: Nothing to add.');
                return;
            }

            let targetPreset: string;

            if (provider.getViewMode() === 'preset' && provider.getActivePresetName()) {
                targetPreset = provider.getActivePresetName()!;
            } else {
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
                    description: `${p.fileCount} file${p.fileCount !== 1 ? 's' : ''}${p.dirCount ? ` · ${p.dirCount} dir${p.dirCount !== 1 ? 's' : ''}` : ''}`,
                    presetName: p.name,
                }));

                const pick = await vscode.window.showQuickPick(picks, {
                    placeHolder: 'Select preset to add to...',
                });
                if (!pick) { return; }
                targetPreset = pick.presetName;
            }

            try {
                if (filePaths.length > 0) {
                    addFilesToPreset(repoRoot, targetPreset, filePaths);
                }
                if (dirPaths.length > 0) {
                    addDirsToPreset(repoRoot, targetPreset, dirPaths);
                }

                if (provider.getViewMode() === 'preset' && provider.getActivePresetName() === targetPreset) {
                    await doRefresh();
                }

                const parts: string[] = [];
                if (filePaths.length > 0) { parts.push(`${filePaths.length} file(s)`); }
                if (dirPaths.length > 0) { parts.push(`${dirPaths.length} dir(s)`); }
                vscode.window.showInformationMessage(
                    `XLens: Added ${parts.join(' and ')} to preset "${targetPreset}".`,
                );
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('xlens.preset.addFilesFromExplorer', async (clicked: vscode.Uri, selected?: vscode.Uri[]) => {
            if (!repoRoot || !provider) { return; }

            const uris: vscode.Uri[] = selected && selected.length > 0 ? selected : [clicked];
            // Directories → tracked dirs (stable); files → explicit tracked paths.
            const { dirPaths, filePaths } = await collectPathsFromUris(uris, repoRoot);
            if (dirPaths.length === 0 && filePaths.length === 0) {
                vscode.window.showInformationMessage('XLens: Nothing to add.');
                return;
            }

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
                description: `${p.fileCount} file${p.fileCount !== 1 ? 's' : ''}${p.dirCount ? ` · ${p.dirCount} dir${p.dirCount !== 1 ? 's' : ''}` : ''}`,
                presetName: p.name,
            }));

            const total = dirPaths.length + filePaths.length;
            const pick = await vscode.window.showQuickPick(picks, {
                placeHolder: `Add ${total} item(s) to preset...`,
            });
            if (!pick) { return; }

            try {
                if (filePaths.length > 0) {
                    addFilesToPreset(repoRoot, pick.presetName, filePaths);
                }
                if (dirPaths.length > 0) {
                    addDirsToPreset(repoRoot, pick.presetName, dirPaths);
                }

                if (provider.getViewMode() === 'preset' && provider.getActivePresetName() === pick.presetName) {
                    await doRefresh();
                }

                const parts: string[] = [];
                if (filePaths.length > 0) { parts.push(`${filePaths.length} file(s)`); }
                if (dirPaths.length > 0) { parts.push(`${dirPaths.length} dir(s)`); }
                vscode.window.showInformationMessage(
                    `XLens: Added ${parts.join(' and ')} to preset "${pick.presetName}".`,
                );
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('xlens.preset.removeFiles', async (clicked: TreeNode, selected?: TreeNode[]) => {
            if (!repoRoot || !provider) { return; }
            const activeName = provider.getActivePresetName();
            if (!activeName) { return; }

            const nodes: TreeNode[] = selected && selected.length > 0 ? selected : [clicked];
            const folderNodes = nodes.filter((n): n is Extract<TreeNode, { type: 'folder' }> => n.type === 'folder');
            const fileNodes = nodes.filter((n): n is Extract<TreeNode, { type: 'file' }> => n.type === 'file');

            let preset: ReturnType<typeof loadPreset>;
            try {
                preset = loadPreset(repoRoot, activeName);
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
            const explicitSet = new Set(preset.files);
            const trackedDirSet = new Set((preset.dirs ?? []) as string[]);
            const trackedDirs = (preset.dirs ?? []).map((d: string) => d.endsWith('/') ? d : d + '/');

            // Folders: if the folder itself is a tracked dir, untrack it; otherwise pull
            // out the explicit (non-dir-derived) descendant files for removal.
            const dirsToUntrack: string[] = [];
            const filesToRemove: string[] = [];
            for (const f of folderNodes) {
                if (trackedDirSet.has(f.relativePath)) {
                    dirsToUntrack.push(f.relativePath);
                } else {
                    const descendants = new Set<string>();
                    collectDescendantFiles(f, descendants);
                    for (const d of descendants) {
                        if (explicitSet.has(d)) { filesToRemove.push(d); }
                    }
                }
            }

            // Files: only explicitly-tracked ones are removable individually. Files that
            // appear here merely because an ancestor directory is tracked can't be removed
            // individually (they'd reappear on the next refresh) — point the user at the dir.
            const dirCovered: string[] = [];
            for (const fn of fileNodes) {
                if (explicitSet.has(fn.relativePath)) {
                    filesToRemove.push(fn.relativePath);
                } else if (trackedDirs.some((d: string) => fn.relativePath + '/' === d || fn.relativePath.startsWith(d))) {
                    dirCovered.push(fn.relativePath);
                }
            }

            if (dirsToUntrack.length === 0 && filesToRemove.length === 0) {
                vscode.window.showInformationMessage(
                    dirCovered.length > 0
                        ? `XLens: ${dirCovered.length} file(s) are covered by a tracked directory — right-click the directory to untrack.`
                        : 'XLens: Nothing removable selected.',
                );
                return;
            }

            try {
                const removedFiles = [...new Set(filesToRemove)];
                const removedDirs = [...new Set(dirsToUntrack)];
                if (removedFiles.length > 0) {
                    removeFilesFromPreset(repoRoot, activeName, removedFiles);
                }
                if (removedDirs.length > 0) {
                    removeDirsFromPreset(repoRoot, activeName, removedDirs);
                }
                await doRefresh();
                const parts: string[] = [];
                if (removedFiles.length > 0) { parts.push(`${removedFiles.length} file(s)`); }
                if (removedDirs.length > 0) { parts.push(`${removedDirs.length} dir(s)`); }
                let msg = `XLens: Removed ${parts.join(' and ')} from preset "${activeName}".`;
                if (dirCovered.length > 0) {
                    msg += ` ${dirCovered.length} file(s) covered by a tracked directory stayed.`;
                }
                vscode.window.showInformationMessage(msg);
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('xlens.gitDiffView.openDiff', async (node: TreeNode) => {
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
        vscode.commands.registerCommand('xlens.gitDiffView.openFile', (node?: TreeNode) => {
            if (!repoRoot || !node || node.type !== 'file') { return; }
            const filePath = path.join(repoRoot, node.relativePath);
            vscode.window.showTextDocument(vscode.Uri.file(filePath));
        }),
        vscode.commands.registerCommand('xlens.gitDiffView.copyPath', (node: TreeNode) => {
            vscode.env.clipboard.writeText(node.relativePath);
            vscode.window.showInformationMessage(`Copied: ${node.relativePath}`);
        }),
        vscode.commands.registerCommand('xlens.gitDiffView.changeBaseBranch', async () => {
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
                await updateGitDiffViewSetting('baseBranch', input.label);
                doRefresh();
            }
        }),
        vscode.commands.registerCommand('xlens.gitDiffView.newFile', async (node: TreeNode) => {
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
        vscode.commands.registerCommand('xlens.gitDiffView.revealInExplorer', (node: TreeNode) => {
            if (!repoRoot) { return; }
            const filePath = path.join(repoRoot, node.relativePath);
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(filePath)).then(undefined, () => {});
        }),
        vscode.commands.registerCommand('xlens.gitDiffView.revealActiveFile', async () => {
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
}

export async function activate(context: vscode.ExtensionContext) {
    contextRef = context;
    configCache = readConfig();

    await migrateLegacyGitDiffViewConfig(context);
    registerAllCommands(context);

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
            if (affectsGitDiffViewConfiguration(e)) {
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
                // Resolve tracked directories to their current file set, then merge
                // with explicit files. This is the key to handling renames/deletes:
                // directories are re-expanded on every refresh.
                const dirFiles = await expandDirsToTrackedFiles(repoRoot, preset.dirs ?? []);
                const merged = new Set<string>(preset.files);
                for (const f of dirFiles) { merged.add(f); }
                provider.setPresetResolvedFiles([...merged].sort());
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
