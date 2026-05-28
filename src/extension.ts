import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitDiffTreeProvider } from './treeProvider';
import { getGitRepoRoot, getFilterPrefix, getDiffEntries, detectBaseBranch, execAsync, isValidBranchName } from './gitService';
import { GitStatusDecorationProvider } from './decorationProvider';
import { TreeNode, StatusDisplayMode } from './types';

const TEMP_DIR = path.join(os.tmpdir(), 'xlens-diff');

let provider: GitDiffTreeProvider | undefined;
let decorationProvider: GitStatusDecorationProvider | undefined;
let treeView: vscode.TreeView<TreeNode> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let repoRoot: string | undefined;
let detectedBaseBranch: string | undefined;
let configCache: Config | undefined;

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
        autoReveal: config.get<boolean>('autoReveal', true),
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

function getResolvedBaseBranch(): string {
    const cfg = getConfig();
    return cfg.baseBranch || detectedBaseBranch || 'master';
}

export async function activate(context: vscode.ExtensionContext) {
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
    });
    context.subscriptions.push(treeView);

    // Initial load
    await doRefresh();

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.refresh', () => doRefresh()),
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
        const baseBranch = getResolvedBaseBranch();
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) { return; }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        const filterPrefix = getFilterPrefix(workspacePath, repoRoot, cfg.filterPrefix);

        const entries = await getDiffEntries(repoRoot, baseBranch, filterPrefix);
        provider.refresh(entries);
        decorationProvider?.updateStatuses(provider.getStatusMap());
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
