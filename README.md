# XLens

[![](https://img.shields.io/visual-studio-marketplace/v/l8ng.vscode-xlens?style=flat-square&logo=visualstudiocode&label=marketplace)](https://marketplace.visualstudio.com/items?l8ng.vscode-xlens)
[![](https://img.shields.io/github/license/straydragon/vscode-xlens?style=flat-square&color=blue)](https://github.com/straydragon/vscode-xlens/blob/main/LICENSE)

在 monorepo 子项目中只看当前目录下有变化的文件。

---

打开 `services/user-service/` 这类子文件夹时，VS Code 的源代码管理视图会显示整个仓库的变更。XLens 在 Explorer 边栏加一个树视图，只显示当前工作区下的变更文件，按目录结构组织。点击打开文件，右键和基线分支做 diff。

## 工作方式

```
git diff <base-branch> --name-status -- <workspace-prefix>
```

基线分支按 master → main → develop → trunk 顺序自动检测，路径前缀从工作区相对 git root 的位置算。都留空就显示整个仓库的变更。

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `gitDiffExplorer.baseBranch` | `""` | 基线分支，空则自动检测 |
| `gitDiffExplorer.filterPrefix` | `""` | 路径前缀，空则自动检测 |
| `gitDiffExplorer.autoRefresh` | `true` | 文件保存或 git 状态变化时自动刷新 |
| `gitDiffExplorer.refreshDebounce` | `2000` | 自动刷新防抖（毫秒） |
| `gitDiffExplorer.autoReveal` | `false` | 切换编辑器时自动在树中展开对应路径 |
| `gitDiffExplorer.statusDisplay` | `"badge"` | git 状态显示方式：`badge` / `description` / `hidden` |

## 命令

| 命令 | 触发位置 |
|------|----------|
| Refresh | 树视图标题栏 |
| Change Base Branch | 树视图标题栏，从候选列表选择 |
| Open Diff | 文件右键，和基线分支比较 |
| Open File | 文件点击 / 右键 |
| Copy Relative Path | 文件/文件夹右键 |
| Reveal in File Explorer | 文件/文件夹右键 |
| New File | 文件夹右键，自动创建中间目录 |
| Reveal in XLens Changed Files | 编辑器标题右键 / 树视图标题栏 |

## 文件状态标记

树视图和 Explorer 中会显示 git 状态标记：

| 标记 | 状态 | 颜色 |
|------|------|------|
| A | Added | 绿 |
| M | Modified | 黄 |
| D | Deleted | 红 |
| R | Renamed | 蓝 |
| C | Copied | 绿 |
| ? | Untracked | 默认 |

通过 `statusDisplay` 切换显示方式：`badge` 走 FileDecoration API（彩色角标），`description` 在文件名后显示文字，`hidden` 关闭。

## License

MIT
