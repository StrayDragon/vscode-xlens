# Change Log

All notable changes to the "vscode-xlens" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Fix: 点击 XLens 文件节点改用 `vscode.open`，与资源管理器一致地打开编辑器（此前自定义 openFile 在部分情况下无法跳转）
- Fix: Open Diff 临时文件名会净化 ref 中的 `/`（如 `origin/main`），避免写成不存在的子目录导致 ENOENT
- Change Base Branch 选择器新增 **Unpushed commits...**：一键将 range 设为 `upstream → HEAD`，查看当前分支尚未 push 的已提交变更；无 upstream 时报错，ahead=0 时仍进入 range 并提示已同步
- Range Review 默认使用 PR 式 three-dot 语义（`A...B`）：分叉分支下只显示目标侧变更；无共同祖先时自动回退完整对比；可用 `xlens.gitDiffView.rangeDiffMode` 切换 two-dot
- Range Review 文件节点显示 GitHub 风格行数统计（`+a −d`，来自 numstat），与状态徽标并存
- XLens Explorer 支持 Range Review：可在两个 ref（本地/远程分支、tag、任意 commit）之间做区间对比，支持 Open Diff 对比两端的文件内容
- Preset 可保存 diff range（`from → to`）：range 模式下保存的 preset 自动携带当前 range，激活即可回顾当时的评审范围；回顾时重选 range 会同步更新 preset
- Change Base Branch 选择器整合 Set Diff Range / Clear Range / Unpushed commits 入口，视图标题显示当前 range
- Preset picker: folder checkbox cycles through unchecked → track directory ([-]) → select all files recursively ([x]) → unchecked; partial selection clicks to select-all
- Preset picker: click any row to select/unselect; selected rows are highlighted
- Preset picker: files show VS Code-style extension-based colored icons (TypeScript, JavaScript, images, PDF, etc.)
- Preset directories are re-resolved on every refresh and now include untracked files, so renames/deletes/new files under tracked dirs are picked up automatically
- Preset JSON no longer persists `fileCount` (it is derived from `files.length` at load time)
- Preset names now support Chinese and other Unicode characters
- Preset picker toolbar adds Expand all / Collapse all buttons
- XLens Explorer view title bar adds Expand All button next to Collapse All