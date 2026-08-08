import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitDiffTreeProvider } from './treeProvider';
import { getGitRepoRoot, getFilterPrefix, getDiffEntries, detectBaseBranch, execAsync, isValidBranchName, listBranches, listRepoFiles, expandDirsToTrackedFiles, resolveRef, listTags, listRemoteBranches, listRecentCommits, getCommitsAheadOfUpstream, DiffTarget } from './gitService';
import { dirPaths as extractDirPaths, filePaths as extractFilePaths } from './types';
import { GitStatusDecorationProvider } from './decorationProvider';
import { TreeNode, Preset, DiffRange } from './types';
import {
    listPresets,
    loadPreset,
    createPreset,
    deletePreset,
    renamePreset,
    addPathsToPreset,
    removePathsFromPreset,
    updatePresetDescription,
    updatePresetRange,
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
/** View-level two-ref range (workspace state). Only applies outside preset mode. */
let diffRange: DiffRange | undefined;
let configCache: Config | undefined;
let contextRef: vscode.ExtensionContext | undefined;

type Config = ReturnType<typeof readGitDiffViewConfig>;

function readConfig(): Config {
    return readGitDiffViewConfig();
}

function getConfig(): Config {
    return configCache ?? readConfig();
}

/** Load the currently active preset (if in preset mode). */
function getActivePreset(): Preset | undefined {
    if (!repoRoot || !provider || provider.getViewMode() !== 'preset') { return undefined; }
    const name = provider.getActivePresetName();
    if (!name) { return undefined; }
    try {
        return loadPreset(repoRoot, name);
    } catch {
        return undefined;
    }
}

/**
 * Resolve the effective diff target.
 * Priority: preset.range → preset.baseBranch → view-level range → config baseBranch → auto-detected → HEAD.
 */
function getResolvedDiffTarget(preset?: Preset): DiffTarget {
    const cfg = getConfig();
    if (preset) {
        if (preset.range) {
            return { kind: 'range', from: preset.range.from, to: preset.range.to, mode: cfg.rangeDiffMode };
        }
        if (preset.baseBranch) {
            return { kind: 'base', ref: preset.baseBranch };
        }
    }
    if (diffRange) {
        return { kind: 'range', from: diffRange.from, to: diffRange.to, mode: cfg.rangeDiffMode };
    }
    return { kind: 'base', ref: cfg.baseBranch || detectedBaseBranch || 'HEAD' };
}

async function setContextKey(key: string, value: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', key, value);
}

// ── Helper: collect descendant file paths from a folder node ──

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

/** Collect repo-relative paths from Explorer URIs.
 *  Directories get a trailing `/`, files don't. */
async function collectPathsFromUris(
    uris: vscode.Uri[],
    repoRoot: string,
): Promise<string[]> {
    const result = new Set<string>();

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
            result.add(rel.replace(/\\/g, '/') + '/');
        } else {
            result.add(rel.replace(/\\/g, '/'));
        }
    }

    return [...result].sort();
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
        const diffLabel = p.range
            ? `range: ${p.range.from} → ${p.range.to}`
            : p.baseBranch
                ? `base: ${p.baseBranch}`
                : 'default base';
        items.push({
            label: `$(${isActive ? 'pin' : 'circle-outline'}) ${p.name}`,
            description: p.description ? p.description.substring(0, 60) : `${p.fileCount} files${p.dirCount ? ` · ${p.dirCount} dir${p.dirCount !== 1 ? 's' : ''}` : ''}`,
            detail: `${p.fileCount} file${p.fileCount !== 1 ? 's' : ''}${p.dirCount ? ` · ${p.dirCount} tracked dir${p.dirCount !== 1 ? 's' : ''}` : ''} · ${diffLabel}`,
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

    await savePresetWithFiles(selection.paths, 'Preset name for watched files');
}

async function savePresetWithFiles(paths: string[], namePrompt: string): Promise<void> {
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
        const activePreset = getActivePreset();
        const target = getResolvedDiffTarget(activePreset);
        const range = target.kind === 'range' ? { from: target.from, to: target.to } : undefined;
        const preset = createPreset(repoRoot, name, paths, description ?? undefined, undefined, range);
        await switchToPreset(preset.name);
        const fileCount = preset.fileCount;
        const dirCount = preset.dirCount ?? 0;
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
    } else if (diffRange) {
        const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;
        treeView.title = `XLens: ${truncate(diffRange.from, 15)} → ${truncate(diffRange.to, 15)}`;
    } else {
        treeView.title = 'XLens';
    }
}

// ── Diff range helpers ────────────────────────────────────────

async function clearViewRange(showMessage = true): Promise<void> {
    diffRange = undefined;
    await contextRef?.workspaceState.update('xlensDiffRange', undefined);
    if (showMessage) {
        vscode.window.showInformationMessage('XLens: Range cleared, back to live diff.');
    }
    doRefresh();
    updateViewTitle();
}

/** Two-step ref picker: branches / tags / remote branches / recent commits / free input. */
async function pickRef(prompt: string, current: string): Promise<string | undefined> {
    if (!repoRoot) { return undefined; }

    let branches: string[] = [];
    let tags: string[] = [];
    let remoteBranches: string[] = [];
    let commits: { sha: string; subject: string }[] = [];
    try {
        [branches, tags, remoteBranches, commits] = await Promise.all([
            listBranches(repoRoot),
            listTags(repoRoot),
            listRemoteBranches(repoRoot),
            listRecentCommits(repoRoot, 15),
        ]);
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }

    type RefPickItem = vscode.QuickPickItem & { value?: string };
    const items: RefPickItem[] = [];

    items.push({ label: `$(check) ${current}`, description: 'current', value: current });

    const localBranches = branches.filter(b => b !== current);
    if (localBranches.length > 0) {
        items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator });
        for (const b of localBranches) {
            items.push({ label: b, value: b });
        }
    }

    const visibleTags = tags.filter(t => t !== current).slice(0, 30);
    if (visibleTags.length > 0) {
        items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator });
        for (const t of visibleTags) {
            items.push({ label: t, value: t });
        }
    }

    const visibleRemote = remoteBranches.filter(rb => rb !== current).slice(0, 30);
    if (visibleRemote.length > 0) {
        items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
        for (const rb of visibleRemote) {
            items.push({ label: rb, value: rb });
        }
    }

    if (commits.length > 0) {
        items.push({ label: 'Recent commits', kind: vscode.QuickPickItemKind.Separator });
        for (const c of commits) {
            items.push({ label: c.sha, description: c.subject, value: c.sha });
        }
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(symbol-method) Enter commit SHA / ref...', value: '__input__' });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${prompt} (current: ${current})`,
        matchOnDescription: true,
    });
    if (!pick) { return undefined; }

    if (pick.value === '__input__') {
        const input = await vscode.window.showInputBox({
            prompt: `${prompt}: branch name, tag, or commit SHA`,
            placeHolder: 'e.g. main, v1.0.0, a1b2c3d',
            validateInput: (val) => {
                if (!val.trim()) { return 'Required'; }
                if (!isValidBranchName(val.trim())) { return 'Invalid characters'; }
                return undefined;
            },
        });
        if (!input) { return undefined; }
        return input.trim();
    }

    return pick.value;
}

/** Persist a view-level range and keep an active preset's range in sync when it already has one. */
async function applyViewRange(from: string, to: string): Promise<boolean> {
    if (!repoRoot) { return false; }

    try {
        await resolveRef(repoRoot, from);
        await resolveRef(repoRoot, to);
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }

    diffRange = { from, to };
    await contextRef?.workspaceState.update('xlensDiffRange', diffRange);

    const activeName = provider?.getActivePresetName();
    if (activeName) {
        try {
            const preset = loadPreset(repoRoot, activeName);
            if (preset.range) {
                updatePresetRange(repoRoot, activeName, diffRange);
                vscode.window.showInformationMessage(`XLens: Preset "${activeName}" range updated to ${from} → ${to}.`);
            }
        } catch { /* ignore */ }
    }

    doRefresh();
    updateViewTitle();
    return true;
}

/** Set range to upstream → HEAD (local commits not yet pushed). */
async function setUnpushedRange(): Promise<void> {
    if (!repoRoot) { return; }

    let info: { upstream: string; ahead: number } | undefined;
    try {
        info = await getCommitsAheadOfUpstream(repoRoot);
    } catch (err) {
        vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    if (!info) {
        vscode.window.showErrorMessage(
            'XLens: Current branch has no upstream tracking branch. Push with -u or set upstream first.',
        );
        return;
    }

    const ok = await applyViewRange(info.upstream, 'HEAD');
    if (!ok) { return; }

    if (info.ahead === 0) {
        vscode.window.showInformationMessage('XLens: No unpushed commits (already in sync with upstream).');
    }
}

/** Set / clear the view-level diff range (workspace state). */
async function selectRangeFlow(): Promise<void> {
    if (!repoRoot) { return; }

    // Step 1: set or clear
    const modeItems: (vscode.QuickPickItem & { action: 'set' | 'clear' })[] = [
        {
            label: '$(git-compare) Set Range...',
            description: 'Compare two refs (branches / tags / commits)',
            action: 'set',
        },
    ];
    if (diffRange) {
        modeItems.push({
            label: '$(circle-outline) Clear Range (back to live diff)',
            action: 'clear',
        });
    }
    const modePick = await vscode.window.showQuickPick(modeItems, {
        placeHolder: diffRange ? `Current range: ${diffRange.from} → ${diffRange.to}` : 'XLens: Diff Range',
    });
    if (!modePick) { return; }

    if (modePick.action === 'clear') {
        await clearViewRange();
        return;
    }

    // Step 2: from ref
    const from = await pickRef('From (base)', diffRange?.from ?? detectedBaseBranch ?? 'HEAD');
    if (!from) { return; }

    // Step 3: to ref
    const to = await pickRef('To (compare)', diffRange?.to ?? 'HEAD');
    if (!to) { return; }

    await applyViewRange(from, to);
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
            // Folders → tracked directories (trailing `/`). Files → explicit tracked paths.
            const paths: string[] = [];
            for (const n of nodes) {
                if (n.type === 'folder') {
                    paths.push(n.relativePath + '/');
                } else {
                    paths.push(n.relativePath);
                }
            }
            if (paths.length === 0) {
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
                addPathsToPreset(repoRoot, targetPreset, paths);

                if (provider.getViewMode() === 'preset' && provider.getActivePresetName() === targetPreset) {
                    await doRefresh();
                }

                vscode.window.showInformationMessage(
                    `XLens: Added ${paths.length} item(s) to preset "${targetPreset}".`,
                );
            } catch (err) {
                vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),
        vscode.commands.registerCommand('xlens.preset.addFilesFromExplorer', async (clicked: vscode.Uri, selected?: vscode.Uri[]) => {
            if (!repoRoot || !provider) { return; }

            const uris: vscode.Uri[] = selected && selected.length > 0 ? selected : [clicked];
            const paths = await collectPathsFromUris(uris, repoRoot);
            if (paths.length === 0) {
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

            const pick = await vscode.window.showQuickPick(picks, {
                placeHolder: `Add ${paths.length} item(s) to preset...`,
            });
            if (!pick) { return; }

            try {
                addPathsToPreset(repoRoot, pick.presetName, paths);

                if (provider.getViewMode() === 'preset' && provider.getActivePresetName() === pick.presetName) {
                    await doRefresh();
                }

                vscode.window.showInformationMessage(
                    `XLens: Added ${paths.length} item(s) to preset "${pick.presetName}".`,
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
            const explicitSet = new Set(extractFilePaths(preset.paths));
            const trackedDirSet = new Set(extractDirPaths(preset.paths).map(d => d.slice(0, -1)));
            const trackedDirs = extractDirPaths(preset.paths);

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
                const toRemove = [...new Set([...filesToRemove, ...dirsToUntrack.map(d => d + '/')])];
                if (toRemove.length > 0) {
                    removePathsFromPreset(repoRoot, activeName, toRemove);
                }
                await doRefresh();
                const totalRemoved = toRemove.length;
                let msg = `XLens: Removed ${totalRemoved} item(s) from preset "${activeName}".`;
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
            const target = getResolvedDiffTarget(getActivePreset());
            const currentPath = path.join(repoRoot, node.relativePath);

            if (target.kind === 'range') {
                // Range mode: diff <from> ↔ <to> via two temp files
                let fromSha: string;
                let toSha: string;
                try {
                    fromSha = await resolveRef(repoRoot, target.from);
                    toSha = await resolveRef(repoRoot, target.to);
                } catch (err) {
                    vscode.window.showErrorMessage(`XLens: ${err instanceof Error ? err.message : String(err)}`);
                    return;
                }

                // From side: try the new path first, fall back to oldPath for renames
                const fromCandidates = node.status === 'R' && node.oldPath
                    ? [node.relativePath, node.oldPath]
                    : [node.relativePath];
                let fromContent = '';
                for (const p of fromCandidates) {
                    try {
                        fromContent = await execAsync(`git show ${fromSha}:${p}`, repoRoot);
                        break;
                    } catch { /* try next candidate */ }
                }
                let toContent = '';
                try {
                    toContent = await execAsync(`git show ${toSha}:${node.relativePath}`, repoRoot);
                } catch {
                    // File added in this range (or deleted on the from side) — empty side is fine
                }

                fs.mkdirSync(TEMP_DIR, { recursive: true });
                const safeName = node.relativePath.replace(/[\/\\]/g, '_');
                const fromPath = path.join(TEMP_DIR, `${target.from}...${safeName}`);
                const toPath = path.join(TEMP_DIR, `${target.to}...${safeName}`);
                fs.writeFileSync(fromPath, fromContent);
                fs.writeFileSync(toPath, toContent);

                const title = `${node.relativePath} (${target.from} ↔ ${target.to})`;
                vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(fromPath), vscode.Uri.file(toPath), title).then(undefined, () => {});
                return;
            }

            const baseBranch = target.ref;
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
        vscode.commands.registerCommand('xlens.gitDiffView.selectRange', () => selectRangeFlow()),
        vscode.commands.registerCommand('xlens.gitDiffView.changeBaseBranch', async () => {
            const target = getResolvedDiffTarget(getActivePreset());
            const currentLabel = target.kind === 'range' ? `${target.from} → ${target.to}` : target.ref;
            if (!repoRoot) { return; }
            const branches = await listBranches(repoRoot);

            type BasePickItem = vscode.QuickPickItem & { branch?: string; action?: 'range' | 'clear' | 'unpushed' };
            const items: BasePickItem[] = [];

            // Range actions at the top — "change base branch OR pick a two-ref range"
            items.push({
                label: '$(git-compare) Set Diff Range...',
                description: 'Compare two refs (branches / tags / commits)',
                action: 'range',
            });
            items.push({
                label: '$(cloud-upload) Unpushed commits...',
                description: 'Compare upstream → HEAD (local commits not yet pushed)',
                action: 'unpushed',
            });
            if (diffRange) {
                items.push({
                    label: `$(circle-outline) Clear Range (${diffRange.from} → ${diffRange.to})`,
                    description: 'Back to live diff',
                    action: 'clear',
                });
            }
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

            // Ensure current target label is listed
            if (target.kind === 'base' && !branches.includes(currentLabel)) {
                branches.unshift(currentLabel);
            }
            for (const b of branches) {
                items.push({
                    label: b,
                    description: b === currentLabel ? '$(check) current' : '',
                    branch: b,
                });
            }

            const input = await vscode.window.showQuickPick(items, {
                placeHolder: `Current: ${currentLabel}. Select diff target...`,
            });
            if (!input) { return; }

            if (input.action === 'range') {
                await selectRangeFlow();
                return;
            }
            if (input.action === 'unpushed') {
                await setUnpushedRange();
                return;
            }
            if (input.action === 'clear') {
                await clearViewRange();
                return;
            }
            if (input.branch && input.branch !== currentLabel) {
                // Picking a single base branch exits range mode
                diffRange = undefined;
                await contextRef?.workspaceState.update('xlensDiffRange', undefined);
                detectedBaseBranch = input.branch;
                await updateGitDiffViewSetting('baseBranch', input.branch);
                doRefresh();
                updateViewTitle();
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

    // Restore view-level diff range from workspace state
    const savedRange = context.workspaceState.get<DiffRange>('xlensDiffRange');
    if (savedRange?.from && savedRange?.to) {
        diffRange = savedRange;
    }

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
        let activePreset: Preset | undefined;
        if (provider.getViewMode() === 'preset' && provider.getActivePresetName()) {
            try {
                activePreset = loadPreset(repoRoot, provider.getActivePresetName()!);
                // Resolve tracked directories to their current file set, then merge
                // with explicit files. This is the key to handling renames/deletes:
                // directories are re-expanded on every refresh.
                const dirFiles = await expandDirsToTrackedFiles(repoRoot, extractDirPaths(activePreset.paths));
                const merged = new Set<string>(extractFilePaths(activePreset.paths));
                for (const f of dirFiles) { merged.add(f); }
                provider.setPresetResolvedFiles([...merged].sort());
            } catch { /* ignore */ }
        }

        let target = getResolvedDiffTarget(activePreset);
        // Validate refs; fall back gracefully when stale (deleted/force-pushed refs)
        if (target.kind === 'range') {
            try {
                await resolveRef(repoRoot, target.from);
                await resolveRef(repoRoot, target.to);
            } catch {
                if (activePreset?.range) {
                    vscode.window.showWarningMessage(
                        `XLens: Range ${target.from} → ${target.to} of preset "${activePreset.name}" is no longer valid.`,
                    );
                    target = { kind: 'base', ref: activePreset.baseBranch || detectedBaseBranch || 'HEAD' };
                } else {
                    vscode.window.showWarningMessage(
                        `XLens: Range ${target.from} → ${target.to} is no longer valid, falling back to live diff.`,
                    );
                    await clearViewRange(false);
                    target = getResolvedDiffTarget(activePreset);
                }
            }
        } else if (!isValidBranchName(target.ref)) {
            target = { kind: 'base', ref: 'HEAD' };
        } else {
            try {
                await execAsync(`git rev-parse --verify ${target.ref}`, repoRoot);
            } catch {
                target = { kind: 'base', ref: detectedBaseBranch || 'HEAD' };
            }
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) { return; }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        const filterPrefix = getFilterPrefix(workspacePath, repoRoot, cfg.filterPrefix);

        const entries = await getDiffEntries(repoRoot, target, filterPrefix);
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
    diffRange = undefined;
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
