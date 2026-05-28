# XLens

Developer lens for monorepo workflows — changed files tree, diff explorer, and more.

## Features

- **Filtered tree view**: Shows only changed files relative to your current workspace folder, not the entire repo
- **Status icons**: Visual indicators for Added (green), Modified (yellow), Deleted (red), Renamed (blue)
- **Auto-detect base branch**: Tries master → main → develop → trunk automatically
- **Quick file access**: Click to open file, inline diff button to compare with base branch
- **Auto-refresh**: Tree updates automatically on file save, git state changes, or config changes

## Usage

1. Open a subfolder of a git repository (e.g., `services/user-service/`)
2. Click the XLens icon in the Activity Bar
3. The tree shows files changed relative to the auto-detected base branch

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `xlens.baseBranch` | `""` (auto) | Base branch to compare against (empty = auto-detect) |
| `xlens.filterPrefix` | `""` | Manual filter prefix (auto-detected from workspace path if empty) |
| `xlens.autoRefresh` | `true` | Auto-refresh on file/git state changes |
| `xlens.refreshDebounce` | `2000` | Debounce interval in ms for auto-refresh |

## Commands

- **Refresh** — Manually refresh the changed files tree
- **Change Base Branch** — Quick pick to switch the comparison branch
- **Open Diff** — Open diff view for a file (inline button on each row)
- **Open File** — Open the current version of a file (default click action)
- **Copy Relative Path** — Copy the file's relative path to clipboard

## License

MIT
