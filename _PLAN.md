# XLens Presets — Implementation Plan

## Overview

Add a **Presets** mechanism to XLens: named file watch-lists that act as a filtered view
on top of the live `git diff`. Users can save a snapshot of currently changed files as a
preset, then switch to that preset to focus on a subset of files. Preset files still show
live git status and support diffing.

Also rename the tree view from "XLens: Changed Files" → "XLens".

---

## Architecture

```
                    ┌─────────────────┐
                    │   Live Git Diff  │   git diff --name-status
                    │  (DiffEntry[])   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼                             ▼
     Live Mode (default)            Preset Mode
     show all DiffEntry[]           filter DiffEntry[] ∩ preset.files[]
              │                             │
              └──────────┬──────────────────┘
                         ▼
                TreeProvider.buildTree()
                         │
                         ▼
                   TreeView UI
```

- **Live Mode**: current behavior — all changed files from `git diff baseBranch`
- **Preset Mode**: show only preset files that exist + have changes (plus stale entries
  for files that are in preset but no longer changed / deleted)
- Both modes support Open Diff, Open File, copy path, etc.

### Preset JSON format (`.xlens/preset/{name}.json`)

```json
{
  "name": "feature-auth",
  "description": "Authentication module files I'm tracking",
  "baseBranch": "main",
  "files": [
    "src/auth/login.ts",
    "src/auth/signup.ts",
    "src/auth/token.ts"
  ],
  "createdAt": "2026-01-15T10:30:00Z",
  "updatedAt": "2026-01-16T08:00:00Z"
}
```

- `files` is a flat array of repo-relative paths (no status stored — status is always live)
- `baseBranch` is optional; when set, it overrides the global base branch for this preset
- `description` supports markdown-like plain text

### Storage layout

```
repo-root/
└── .xlens/
    ├── .gitkeep
    └── preset/
        ├── feature-auth.json
        ├── bugfix-login.json
        └── ...
```

- `.xlens/.gitkeep` ensures the dir exists; users choose to `.gitignore` or commit
- `PresetService` handles CRUD on this directory

---

## New files

| File | Purpose |
|------|---------|
| `src/presetService.ts` | Read/write/manage `.xlens/preset/*.json` files |
| _None other_ | Everything else is modifications to existing files |

---

## Detailed Changes

### 1. `src/types.ts` — New types

- [ ] Add `PresetMeta` type (lightweight, for listing):
  - `name: string`, `description: string`, `fileCount: number`, `baseBranch?: string`,
    `createdAt: string`, `updatedAt: string`
- [ ] Add `Preset` type (full, for loading):
  - extends `PresetMeta` + `files: string[]`
- [ ] Add `ViewMode = 'live' | 'preset'` type
- [ ] Add `PresetFileNode` interface or extend `FileNode` with `inPreset: boolean` and
  `currentGitStatus?: GitFileStatus` (for preset files that are unchanged/deleted)

### 2. `src/presetService.ts` — New module

- [ ] `ensurePresetDir(repoRoot: string): void`
  - Creates `.xlens/preset/` + `.xlens/.gitkeep` if missing
- [ ] `listPresets(repoRoot: string): PresetMeta[]`
  - Reads all `.json` files from `.xlens/preset/`, returns metadata (name, description, etc.)
  - Gracefully handles malformed JSON files (skip, log warning)
- [ ] `loadPreset(repoRoot: string, name: string): Preset`
  - Reads a single preset JSON, validates fields
  - Throws if not found or invalid
- [ ] `savePreset(repoRoot: string, preset: Preset): void`
  - Writes to `.xlens/preset/{name}.json`
  - Auto-sets `updatedAt`
- [ ] `createPreset(repoRoot: string, name: string, files: string[], description?: string, baseBranch?: string): Preset`
  - Creates a new preset with current timestamp
  - Sanitizes name for filesystem safety (replace `/`, `\`, `..` etc.)
- [ ] `deletePreset(repoRoot: string, name: string): void`
  - Removes the JSON file
- [ ] `renamePreset(repoRoot: string, oldName: string, newName: string): void`
  - Renames the file + updates `name` field inside
- [ ] `addFilesToPreset(repoRoot: string, presetName: string, files: string[]): Preset`
  - Merges new files (dedup), saves
- [ ] `removeFilesFromPreset(repoRoot: string, presetName: string, files: string[]): Preset`
  - Removes specified files, saves
- [ ] `updatePresetDescription(repoRoot: string, presetName: string, description: string): Preset`
- [ ] `updatePresetBaseBranch(repoRoot: string, presetName: string, baseBranch: string | undefined): Preset`
- [ ] `sanitizePresetName(name: string): string`
  - Strip path separators, `..`, null bytes, leading dots; trim whitespace

### 3. `src/treeProvider.ts` — Extended for preset mode

- [ ] Add state fields:
  - `viewMode: ViewMode = 'live'`
  - `activePresetName: string | undefined`
  - `presetFiles: string[]` (cached list of file paths in active preset)
  - `currentEntries: DiffEntry[]` (cache of latest `git diff` result)
- [ ] Add public methods:
  - `setViewMode(mode: ViewMode, presetName?: string)` — switch mode, trigger refresh
  - `getViewMode(): ViewMode`
  - `getActivePresetName(): string | undefined`
- [ ] Modify `refresh(entries)`:
  - Store `entries` as `currentEntries`
  - If `viewMode === 'preset'`, load preset files and **merge**:
    - For each file in preset: if it exists in `currentEntries`, show with live status
    - If it exists in `currentEntries` but with a *different* status — show live status (preset
      is just a filter, not an override)
    - If the file is **not** in `currentEntries` (unchanged/clean): add as a special entry
      with status `'clean'` or similar — show dimmed, with tooltip "No longer changed"
    - If file doesn't exist on disk at all: show as `'deleted'` with warning icon
    - If file exists on disk but not in git diff: show as `'unchanged'` with a subtle icon
  - Build tree from the merged list
- [ ] Add a new `'clean'` pseudo-status in types or handle inline
- [ ] Update `getFileTreeItem`:
  - For clean/unchanged files: dimmed label, different icon/decoration, tooltip
  - For `contextValue`: **all** files shown in preset mode get `_inPreset` suffix
    (e.g., `file_m_inPreset`), regardless of whether they have live git changes or not.
    This ensures "Remove from Preset" always appears on every preset file.
- [ ] Update `getFolderTreeItem`:
  - In preset mode, show preset name or indicator in description
- [ ] Consider: when in preset mode, show the preset name in the tree root or as a banner node

### 4. `src/extension.ts` — New commands + preset integration

- [ ] **Enable multi-select** on TreeView: add `canSelectMany: true` option when calling `createTreeView`
- [ ] **State persistence**: Use `context.workspaceState` to store `activePreset: string | null`
  (persists across VS Code restarts)
- [ ] On activate, restore `activePreset` from workspace state
- [ ] New command: `xlens.showPresets` → Quick Pick menu (button on view title)
  - [ ] Quick Pick items:
    - `● Live Git Diff` (checked if active)
    - Separator
    - List of presets (with descriptions as detail)
    - Separator
    - `💾 Save Current Files as Preset...`
    - `✏️  Edit Preset Description...` (only if a preset is active)
    - `✏️  Rename Preset...` (only if a preset is active)
    - `🗑  Delete Preset...`
  - [ ] Selecting a preset switches to it
  - [ ] Selecting Live switches back to live mode
  - [ ] "Save Current Files as Preset..." → input box for name → input box for description
    (optional) → save → switch to the new preset
  - [ ] "Delete Preset..." → secondary Quick Pick listing all presets → confirm → delete
    → switch to live if deleting the active one
  - [ ] "Edit Description..." → input box pre-filled with current description
  - [ ] "Rename..." → input box pre-filled with current name → rename file + update
- [ ] New command: `xlens.preset.addFilesFromExplorer` (native File Explorer context menu)
  - Registered with `vscode.commands.registerCommand` receiving `uri: vscode.Uri` (or `uris: vscode.Uri[]` for multi-select)
  - Computes repo-relative paths from selected files/folders
  - For folders: recursively collect all tracked files under the folder
  - Shows Quick Pick to choose target preset → adds files → shows confirmation toast
  - If no presets exist yet: prompt to create one first ("No presets yet. Create one?")

- [ ] New command: `xlens.preset.addFiles` (context menu, multi-select)
  - Works on selected tree nodes (files + folders)
  - **When a preset is active**: auto-adds to the active preset
  - **When in Live mode**: shows a Quick Pick to choose which preset to add to
  - For folders: add all files under that folder that are in the current diff list
  - Dedup, save preset, refresh tree
- [ ] New command: `xlens.preset.removeFiles` (context menu, multi-select)
  - Only visible when a preset is **active**
  - Removes selected files from the preset
  - Save preset, refresh tree
- [ ] New command: `xlens.preset.switchToLive`
  - Simple command to switch back to live mode (useful for keyboard shortcut)
- [ ] Modify `doRefresh()`:
  - After `getDiffEntries()`, store in provider
  - If preset mode, also load preset and cross-reference
- [ ] base branch resolution in preset mode:
  - If active preset has `baseBranch` set, use that (takes precedence over global config)
  - Otherwise fall back to global config / detected
- [ ] `getResolvedBaseBranch()` should accept optional preset baseBranch override parameter
- [ ] Update view title to show current mode:
  - Live: "XLens" (or include base branch name)
  - Preset: "XLens: 📌 {presetName}"

### 5. `package.json` — Commands, menus, configuration

- [ ] View rename: `"name": "XLens"` (was "XLens: Changed Files")
- [ ] New commands in `contributes.commands`:
  - `xlens.showPresets` — title: "Presets", icon: `$(list-tree)`
  - `xlens.preset.addFiles` — title: "Add to Preset", icon: `$(add)`
  - `xlens.preset.addFilesFromExplorer` — title: "Add to XLens Preset", icon: `$(add)`
  - `xlens.preset.removeFiles` — title: "Remove from Preset", icon: `$(remove)`
  - `xlens.preset.switchToLive` — title: "XLens: Switch to Live View"
- [ ] Menu contributions:
  - `view/title`: Add `xlens.showPresets` button (before refresh button, group `navigation`)
  - `explorer/context`: Add `xlens.preset.addFilesFromExplorer` — when `resourceScheme == file`
    (group `2_workspace` or similar, so it sits near other extension actions)
  - `view/item/context`:
    - `xlens.preset.addFiles` — when `view == gitDiffExplorerView` (always visible; command handler decides target preset)
    - `xlens.preset.removeFiles` — when `view == gitDiffExplorerView && viewItem =~ /_inPreset/`
- [ ] New context key: `xlens:presetActive` — set by extension when entering/leaving preset mode
  via `vscode.commands.executeCommand('setContext', 'xlens:presetActive', true/false)`
- [ ] New configuration:
  - `gitDiffExplorer.presetsPath` — custom path for preset storage (default: `.xlens/preset`)

### 6. `src/decorationProvider.ts` — (minimal changes)

- [ ] When in preset mode and a file is in the preset but has no live git status:
  - Could show a subtle decoration (e.g., `●` with tooltip "Tracked by preset, not changed")
  - Decision: keep it simple for v1 — only decorate files with actual git status. Files that
    appear in the tree only because they're in the preset but are clean → no decoration.

### 7. `src/test/extension.test.ts` — Tests

- [ ] Test preset CRUD (save, load, list, delete, rename)
- [ ] Test preset file add/remove (including dedup)
- [ ] Test name sanitization
- [ ] Test preset mode filtering logic
- [ ] Test mode switching with workspace state persistence

---

## UX Flow Examples

### Flow 1: Create a preset from current changes

1. User has 15 changed files visible in XLens
2. Clicks "Presets" button on view title → Quick Pick
3. Selects "💾 Save Current Files as Preset..."
4. Input box: "Preset name" → types `feature-auth`
5. Input box: "Description (optional)" → types `Auth module refactor`
6. Preset is saved, view switches to preset mode showing the same 15 files
7. Title bar now shows "XLens: 📌 feature-auth"

### Flow 2: Switch between presets

1. User is in preset `feature-auth`
2. Clicks Presets button → picks `bugfix-login`
3. Tree refreshes showing only files from `bugfix-login` with live git status
4. Some files show as "clean" (no longer changed) — dimmed
5. Can still diff those files (they have a base version)

### Flow 3: Add files to current preset

1. User is in preset `feature-auth`
2. Switches to Live mode (to see all changed files)
3. Creates some new files, they appear in the tree
4. Multi-selects them (Ctrl/Cmd+click), right-click → "Add to Preset"
5. Quick Pick: "Which preset?" → selects `feature-auth`
6. Files added, tree refreshes
7. Switches back to `feature-auth` — new files are there

Alternatively (simpler): only allow "Add to Preset" when a preset is active, but allow the
user to first select files in Live, then switch to a preset, then use "Add to Preset" on
the same files... That's awkward.

Better approach:
- "Add to Preset" command always shows a Quick Pick of existing presets (when not in preset
  mode), or auto-adds to the active preset (when in preset mode)
- This way you can select files in Live mode, right-click → "Add to Preset" → pick which one

### Flow 4: Remove files from preset

1. User is in preset `feature-auth`
2. Multi-selects files they no longer want to track
3. Right-click → "Remove from Preset"
4. Files removed, tree refreshes
5. If a file was only visible because of the preset (clean/unchanged), it disappears
6. If a file has live git changes, it still appears if we show all changed files... Wait, no —
   in preset mode, **only** preset files are shown. So removing a file from preset removes it
   from the tree entirely.

### Flow 5: Add files from native File Explorer

1. User browses files in VS Code's native File Explorer
2. Selects one or more files/folders (multi-select with Ctrl/Cmd+click)
3. Right-click → "Add to XLens Preset"
4. Quick Pick: "Select preset..." → shows all existing presets
5. Optionally: "+ Create new preset..." at the bottom of the list
6. If "Create new preset" chosen → input box for name → description → preset created
7. Files added, toast notification: "Added 5 file(s) to preset 'feature-auth'"
8. If user is currently viewing that preset in XLens, tree auto-refreshes

---

## Edge Cases & Decisions

| Edge Case | Decision |
|-----------|----------|
| Preset file deleted from disk | Show as "Deleted from disk" with warning icon, still in tree |
| Preset file has different status than when saved | Show live status (preset is just a filter) |
| Preset file is clean (not in `git diff`) | Show dimmed, tooltip "Not changed since {baseBranch}" |
| Preset name conflicts | Prompt to overwrite or choose different name |
| Empty preset (0 files) | Show a tree item "No files tracked" with hint to add files |
| Switching branches while in preset mode | Preset files persist; re-run git diff against new branch |
| Malformed preset JSON | Skip on listing, show error on load attempt, offer to recreate |
| Preset name with special chars | Sanitize: `/[^a-zA-Z0-9._-]/g` → `_`, trim, ensure non-empty |
| User deletes `.xlens/preset/` externally | Next operation recreates it; active preset resets to live |
| Multiple workspace folders | Same behavior — presets are per-repo, stored in each repo's `.xlens/` |
| Large presets (1000+ files) | JSON read is fast; merge logic is O(n) — acceptable |
| File Explorer add on a folder | Recursively collect all git-tracked files under that folder; skip `.gitignore`'d and untracked files |
| File Explorer add when no presets exist | Show "No presets yet. Create one?" → input box → create → add files in one flow |

---

## Implementation Order (TODO)

### Phase 1: Foundation ✅
- [x] **1.1** Update `types.ts` — add `PresetMeta`, `Preset`, `ViewMode`
- [x] **1.2** Create `src/presetService.ts` — full CRUD for presets
- [x] **1.3** Rename view in `package.json` to "XLens"
- [x] **1.4** Add preset commands to `package.json` (commands + menus section)
- [x] **1.5** Register new context key `xlens:presetActive`

### Phase 2: Tree Provider Preset Support ✅
- [x] **2.1** Add `viewMode`, `activePresetName`, merge logic to `treeProvider.ts`
- [x] **2.2** Handle preset-only file display (clean, deleted, unchanged states)
- [x] **2.3** Add `contextValue` suffixes for preset context menus

### Phase 3: Extension Integration ✅
- [x] **3.1** Create `xlens.showPresets` command (Quick Pick menu)
- [x] **3.2** Create `xlens.preset.addFiles` command (XLens tree view context menu)
- [x] **3.3** Create `xlens.preset.addFilesFromExplorer` command (native File Explorer context menu)
- [x] **3.4** Create `xlens.preset.removeFiles` command
- [x] **3.5** Create `xlens.preset.switchToLive` command
- [x] **3.6** Wire workspace state persistence for active preset
- [x] **3.7** Update `doRefresh()` to handle preset mode
- [x] **3.8** Update view title to reflect current mode

### Phase 4: Polish & Edge Cases ✅
- [x] **4.1** "Save Current Files as Preset" flow
- [x] **4.2** "Delete Preset" flow with confirmation
- [x] **4.3** "Rename Preset" flow
- [x] **4.4** "Edit Description" flow
- [x] **4.5** Handle empty preset gracefully
- [x] **4.6** Handle deleted preset files (on disk)
- [x] **4.7** Pre-setup `.xlens/.gitkeep` on extension activate

### Phase 5: Testing
- [ ] **5.1** Unit tests for `presetService.ts`
- [ ] **5.2** Integration test for mode switching
- [ ] **5.3** Test preset with baseBranch override

---

## Notes

- We intentionally keep the view ID as `gitDiffExplorerView` to avoid breaking user
  workspace layouts. Only the display name changes.
- The `'clean'` pseudo-status does **not** get added to `GitFileStatus`. It's handled at
  the tree provider level as a separate rendering path.
- Multi-select in VS Code tree views uses the built-in `canSelectMany` property on
  `TreeViewOptions` (VS Code 1.72+). We have engine `^1.105.1` so this is supported.
- The "Add to Preset" command when no preset is active should show a Quick Pick to choose
  the target preset.
