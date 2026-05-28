import * as vscode from 'vscode';
import * as path from 'path';
import { GitFileStatus, StatusDisplayMode } from './types';

const STATUS_DECORATIONS: Record<GitFileStatus, { badge: string; color: string; tooltip: string }> = {
    A: { badge: 'A', color: 'charts.green',    tooltip: 'Added' },
    M: { badge: 'M', color: 'charts.yellow',   tooltip: 'Modified' },
    D: { badge: 'D', color: 'charts.red',      tooltip: 'Deleted' },
    R: { badge: 'R', color: 'charts.blue',     tooltip: 'Renamed' },
    C: { badge: 'C', color: 'charts.green',    tooltip: 'Copied' },
    T: { badge: 'T', color: 'charts.yellow',   tooltip: 'Type Changed' },
    U: { badge: 'U', color: 'charts.yellow',   tooltip: 'Unmerged' },
    '?': { badge: '?', color: 'charts.foreground', tooltip: 'Untracked' },
};

export class GitStatusDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private statusMap = new Map<string, GitFileStatus>();
    private repoRoot: string;
    private displayMode: StatusDisplayMode = 'badge';

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
    }

    setDisplayMode(mode: StatusDisplayMode): void {
        if (this.displayMode !== mode) {
            this.displayMode = mode;
            this._onDidChangeFileDecorations.fire(undefined);
        }
    }

    updateStatuses(statusMap: Map<string, GitFileStatus>): void {
        this.statusMap = statusMap;
        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (this.displayMode !== 'badge') {
            return undefined;
        }

        const relPath = path.relative(this.repoRoot, uri.fsPath);
        if (relPath.startsWith('..')) {
            return undefined;
        }

        const status = this.statusMap.get(relPath);
        if (!status) {
            return undefined;
        }

        const def = STATUS_DECORATIONS[status];
        return {
            badge: def.badge,
            color: new vscode.ThemeColor(def.color),
            tooltip: def.tooltip,
        };
    }
}
