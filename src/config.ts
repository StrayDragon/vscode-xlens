import * as vscode from 'vscode';
import { StatusDisplayMode } from './types';

/** Current XLens git diff view settings namespace */
export const XLENS_GIT_DIFF_VIEW_SECTION = 'xlens.gitDiffView';

const LEGACY_SECTION = 'gitDiffExplorer';
const MIGRATION_FLAG = 'xlensGitDiffViewConfigMigrated';

const CONFIG_KEYS = [
    'baseBranch',
    'filterPrefix',
    'autoRefresh',
    'refreshDebounce',
    'autoReveal',
    'statusDisplay',
] as const;

export interface GitDiffViewConfig {
    autoReveal: boolean;
    autoRefresh: boolean;
    refreshDebounce: number;
    baseBranch: string;
    filterPrefix: string;
    statusDisplay: StatusDisplayMode;
}

export async function migrateLegacyGitDiffViewConfig(
    context: vscode.ExtensionContext,
): Promise<void> {
    if (context.globalState.get<boolean>(MIGRATION_FLAG)) {
        return;
    }

    const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);
    const current = vscode.workspace.getConfiguration(XLENS_GIT_DIFF_VIEW_SECTION);

    for (const key of CONFIG_KEYS) {
        if (!legacy.has(key)) {
            continue;
        }

        const value = legacy.get(key);
        if (value === undefined) {
            continue;
        }

        if (!current.has(key)) {
            await current.update(key, value, vscode.ConfigurationTarget.Global);
        }

        await legacy.update(key, undefined, vscode.ConfigurationTarget.Global);
        await legacy.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        await legacy.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }

    await context.globalState.update(MIGRATION_FLAG, true);
}

export function readGitDiffViewConfig(): GitDiffViewConfig {
    const config = vscode.workspace.getConfiguration(XLENS_GIT_DIFF_VIEW_SECTION);
    return {
        autoReveal: config.get<boolean>('autoReveal', false),
        autoRefresh: config.get<boolean>('autoRefresh', true),
        refreshDebounce: config.get<number>('refreshDebounce', 2000),
        baseBranch: config.get<string>('baseBranch', ''),
        filterPrefix: config.get<string>('filterPrefix', ''),
        statusDisplay: config.get<StatusDisplayMode>('statusDisplay', 'badge'),
    };
}

export function affectsGitDiffViewConfiguration(event: vscode.ConfigurationChangeEvent): boolean {
    return event.affectsConfiguration(XLENS_GIT_DIFF_VIEW_SECTION);
}

export async function updateGitDiffViewSetting(
    key: keyof GitDiffViewConfig,
    value: GitDiffViewConfig[keyof GitDiffViewConfig],
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
): Promise<void> {
    const config = vscode.workspace.getConfiguration(XLENS_GIT_DIFF_VIEW_SECTION);
    await config.update(key, value, target);
}
