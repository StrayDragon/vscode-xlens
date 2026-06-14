# XLens Performance Audit & v0.3.0 Roadmap

## Performance Hotspots (current v0.2.0)

### 🔴 P1: Double-loading preset JSON on every refresh

**Location**: `getResolvedBaseBranch()` + `buildPresetTree()`

When in preset mode, `doRefresh()` calls:
1. `getResolvedBaseBranch()` → calls `loadPreset()` to read baseBranch override
2. `provider.refresh(entries)` → `rebuildTree()` → `buildPresetTree()` → calls `loadPreset()` again

Same JSON file is read + parsed twice per refresh cycle. In a monorepo with preset of 1000 files, that's ~100KB+ of JSON parsed twice.

**Fix**: Load preset once at refresh start, pass it down.

---

### 🔴 P2: `fs.existsSync()` for every clean preset file

**Location**: `buildPresetTree()` + `markCleanNodes()`

When a file is in the preset but NOT in `git diff` (clean), we call `fs.existsSync()`.
For a preset of 500 files where 400 are clean, that's 400 sync filesystem calls.
Each call involves a syscall to stat. On network filesystems / WSL, this can be very slow.

**Fix**: 
- Batch check via reading parent directory listings (cheaper than per-file stat)
- Or use `git ls-files` / `git status --porcelain` to check file existence in bulk
- Or don't check existence at all: assume it exists, and only check when user opens it

---

### 🟡 P3: Recursive `fs.readdirSync` in File Explorer add

**Location**: `collectGitTrackedFiles()`

When user right-clicks a folder in VS Code File Explorer and chooses "Add to XLens Preset",
we recursively scan the entire directory tree with sync I/O. For large monorepos this can freeze the extension host for seconds.

Also, the function is named "gitTracked" but doesn't actually filter by git — it collects ALL files.

**Fix**:
- Use `git ls-files -- <prefix>` to list git-tracked files within the folder (single git invocation, no FS recursion)
- Result is accurate and fast

---

### 🟡 P4: `collectFilePathsFromNodes` nested loop

**Location**: `collectFilePathsFromNodes()`

When user multi-selects a folder in XLens tree → "Add to Preset", we iterate all `livePaths` for each folder node to find files under it. O(nodes × totalFiles).

**Fix**: Build a prefix-tri or sorted array to binary-search. Or since the tree already has `nodeByPath`, walk the tree instead of scanning the flat list.

---

### 🟡 P5: `getChildren()` sorts on every call

**Location**: `getChildren()`

VS Code calls `getChildren()` separately for every expanded folder on each tree change. Each call creates a new sorted array. For a deeply expanded tree with many folders containing 50+ files, cumulative overhead adds up.

**Fix**: Maintain pre-sorted arrays in folder nodes. Re-sort only when the folder's children change.

---

### 🟢 P6: Tree rebuild on every git state change

**Location**: `doRefresh()` → `rebuildTree()`

With `autoRefresh: true` (default) and git extension watching, every tiny git state change triggers a full tree rebuild. This is intentional but worth noting: on very large repos, debounce helps but not enough.

**Fix for future**: Incremental diff — diff the old `DiffEntry[]` against new, only update changed nodes.

---

### 🟢 P7: `path.join(repoRoot, ...)` allocations in `getFileTreeItem`

VS Code calls `getTreeItem()` lazily for visible items. Each call creates a new `vscode.Uri.file(path.join(repoRoot, element.relativePath))`. This is cheap but called frequently.

**Fix**: Cache the URI on the node itself (add `uri?: vscode.Uri` to FileNode).

---

## Summary: v0.3.0 Performance Optimizations

| Priority | Issue | Impact | Fix |
|----------|-------|--------|-----|
| P1 | Double-load preset JSON | Medium | Load once, pass to both consumers |
| P2 | `fs.existsSync` per clean file | High on preset with many clean files | Use `git ls-files` or batch dir scanning |
| P3 | Recursive sync I/O for folder add | High on large folders | Use `git ls-files -- <prefix>` |
| P4 | Nested loop in folder collection | Low | Walk tree instead of scanning flat list |
| P5 | Sort on every getChildren call | Low | Pre-sort in folder node |
| P6 | Full tree rebuild on every change | Low (debounced) | Incremental diff (future) |
| P7 | URI allocation per getTreeItem | Negligible | Cache URI on node |

---

## v0.3.0 Feature Roadmap

### 1. Preset ordering / reordering
- Drag-and-drop to reorder files within a preset
- Sort options: alphabetically, by status (changed first), by last modified

### 2. Preset import/export
- Export preset as `.json` (already easy since it's just a file)
- Import from clipboard or file
- "Duplicate preset" command

### 3. Smart preset suggestions
- Auto-suggest "Files you've edited in the last hour"
- "Files from the last commit"
- "Files changed since branch diverged from base"

### 4. Batch operations
- "Open all files in preset" command
- "Open all changed files in preset as diff views"
- "Copy all paths in preset" (to clipboard, for CLI use)

### 5. Visual improvements
- File count badge on preset list items
- Coloring/filtering: gray out clean files entirely (optional), highlight R/C status
- Show last modified timestamp next to each file

### 6. Auto-preset from git history
- `git log --name-only` integration: create preset from any commit
- Auto-detect: "Save current changes as 'branch-{name}'"

### 7. Multi-preset view
- View multiple presets simultaneously (union/intersection modes)
- Color-code files by which preset they belong to

### 8. Keyboard shortcut for quick add
- `Cmd+Shift+A` in editor → "Add current file to XLens preset" shortcut

---

## Performance Verification Checklist (pre-release)

- [ ] 100 file diff, Live mode: < 50ms refresh
- [ ] 1000 file diff, Live mode: < 200ms refresh
- [ ] 100 file preset (50 clean), Preset mode: < 100ms refresh
- [ ] 1000 file preset (500 clean), Preset mode: < 300ms refresh
- [ ] Tree expand/collapse animation smooth
- [ ] File Explorer "Add to XLens Preset" on large folder: < 1s
- [ ] No extension host freezes / "Extension is slow" warnings
- [ ] Memory: statusMap + nodeByPath + tree at peak < 50MB for 5000 files
