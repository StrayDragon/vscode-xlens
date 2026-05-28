import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { GitDiffTreeProvider } from './treeProvider';
import { getGitRepoRoot, getFilterPrefix, getDiffEntries, detectBaseBranch } from './gitService';
import { TreeNode } from './types';

function execAsync(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

const TEMP_DIR = path.join(os.tmpdir(), 'xlens-diff');

let provider: GitDiffTreeProvider | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let repoRoot: string | undefined;
let detectedBaseBranch: string | undefined;

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

    provider = new GitDiffTreeProvider(repoRoot);

    // Auto-detect base branch (master → main → develop → trunk)
    detectedBaseBranch = await detectBaseBranch(repoRoot);

    const treeView = vscode.window.createTreeView('gitDiffExplorerView', {
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

            // Get base branch file content via git show
            let baseContent: string;
            try {
                baseContent = await execAsync(
                    `git show ${baseBranch}:${node.relativePath}`,
                    repoRoot,
                );
            } catch {
                // File doesn't exist on base branch (newly added)
                vscode.window.showInformationMessage(
                    `XLens: This file does not exist on ${baseBranch}. Opening current version instead.`,
                );
                vscode.window.showTextDocument(vscode.Uri.file(currentPath));
                return;
            }

            // Write base content to temp file for diff
            fs.mkdirSync(TEMP_DIR, { recursive: true });
            const safeName = node.relativePath.replace(/[\/\\]/g, '_');
            const tempPath = path.join(TEMP_DIR, `${baseBranch}...${safeName}`);
            fs.writeFileSync(tempPath, baseContent);

            const baseUri = vscode.Uri.file(tempPath);
            const currentUri = vscode.Uri.file(currentPath);
            const title = `${node.relativePath} (${baseBranch} ↔ Current)`;
            vscode.commands.executeCommand('vscode.diff', baseUri, currentUri, title);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.openFile', (node: TreeNode) => {
            if (!repoRoot || node.type !== 'file') { return; }
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
            const config = vscode.workspace.getConfiguration('gitDiffExplorer');
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
            const filePath = path.join(repoRoot, node.relativePath, fileName);
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
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(filePath));
        }),
    );

    // Reveal the active editor file in XLens tree (works from editor tab context menu or command palette)
    context.subscriptions.push(
        vscode.commands.registerCommand('gitDiffExplorer.revealActiveFile', async () => {
            if (!provider || !repoRoot) { return; }
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

    // Reveal current file in tree when editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || !provider || !repoRoot) { return; }
            const config = vscode.workspace.getConfiguration('gitDiffExplorer');
            if (!config.get<boolean>('autoReveal', true)) { return; }
            const filePath = editor.document.uri.fsPath;
            const rel = path.relative(repoRoot, filePath);
            provider.setActivePath(rel || undefined);
            const node = provider.findNodeByAbsPath(filePath);
            if (node) {
                treeView.reveal(node, { select: true, focus: false, expand: 3 }).then(undefined, () => {});
            }
        }),
    );

    // Watch for file saves
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()),
    );

    // Watch for config changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gitDiffExplorer')) {
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

function getResolvedBaseBranch(): string {
    const config = vscode.workspace.getConfiguration('gitDiffExplorer');
    const configBranch = config.get<string>('baseBranch', '');
    return configBranch || detectedBaseBranch || 'master';
}

function scheduleRefresh() {
    const config = vscode.workspace.getConfiguration('gitDiffExplorer');
    if (!config.get<boolean>('autoRefresh', true)) { return; }

    const debounce = config.get<number>('refreshDebounce', 2000);
    if (refreshTimer) { clearTimeout(refreshTimer); }
    refreshTimer = setTimeout(() => doRefresh(), debounce);
}

async function doRefresh() {
    if (!provider || !repoRoot) { return; }

    const config = vscode.workspace.getConfiguration('gitDiffExplorer');
    const baseBranch = getResolvedBaseBranch();
    const manualPrefix = config.get<string>('filterPrefix', '');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) { return; }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const filterPrefix = getFilterPrefix(workspacePath, repoRoot, manualPrefix);

    try {
        const entries = await getDiffEntries(repoRoot, baseBranch, filterPrefix);
        provider.refresh(entries);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`XLens: ${message}`);
        provider.clear();
    }
}

export function deactivate() {
    if (refreshTimer) { clearTimeout(refreshTimer); }
    // Clean up temp files
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
