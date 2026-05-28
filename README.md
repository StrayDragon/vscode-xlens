# Git Diff Explorer

Tree view of changed files filtered to current workspace path — designed for monorepos.

## Features

- **Filtered tree view**: Shows only changed files relative to your current workspace folder, not the entire repo
- **Status icons**: Visual indicators for Added (green), Modified (yellow), Deleted (red), Renamed (blue)
- **One-click diff**: Click any file to open a diff view comparing the base branch vs current
- **Configurable base branch**: Compare against `master`, `main`, `develop`, or any branch
- **Auto-refresh**: Tree updates automatically on file save, git state changes, or config changes

## Usage

1. Open a subfolder of a git repository (e.g., `services/user-service/`)
2. Click the Git Diff Explorer icon in the Activity Bar
3. The tree shows files changed relative to the configured base branch

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `gitDiffExplorer.baseBranch` | `master` | Base branch to compare against |
| `gitDiffExplorer.filterPrefix` | `""` | Manual filter prefix (auto-detected from workspace path if empty) |
| `gitDiffExplorer.autoRefresh` | `true` | Auto-refresh on file/git state changes |
| `gitDiffExplorer.refreshDebounce` | `2000` | Debounce interval in ms for auto-refresh |

## Commands

- **Refresh** — Manually refresh the changed files tree
- **Change Base Branch** — Quick input to switch the comparison branch
- **Open Diff** — Open diff view for a file (also triggered by clicking a file)
- **Open File** — Open the current version of a file
- **Copy Relative Path** — Copy the file's relative path to clipboard

## License

MIT
