<div align="center">
  <img src="icon.png" alt="XLens" width="160" height="160"/>

  # XLens

  [![](https://img.shields.io/visual-studio-marketplace/v/l8ng.vscode-xlens?style=flat-square&logo=visualstudiocode&label=marketplace)](https://marketplace.visualstudio.com/items?itemName=l8ng.vscode-xlens)
  [![](https://img.shields.io/open-vsx/v/l8ng/vscode-xlens?style=flat-square&logo=open-vsx&label=open-vsx)](https://open-vsx.org/extension/l8ng/vscode-xlens)
  [![](https://img.shields.io/github/license/straydragon/vscode-xlens?style=flat-square&color=blue)](https://github.com/straydragon/vscode-xlens/blob/main/LICENSE)
  [![](https://img.shields.io/badge/VS_Code-%5E1.105.1-blue?style=flat-square&logo=visualstudiocode)](https://code.visualstudio.com)

  monorepo 子项目里只看自己目录的变更文件

  [配置](#配置) · [命令](#命令) · [状态标记](#文件状态标记) · [CHANGELOG](CHANGELOG.md)
</div>

---

打开 `services/user-service/` 这类子文件夹时，VS Code 的源代码管理视图显示整个仓库的变更。XLens 在 Explorer 边栏加一个树视图，只显示当前工作区下的变更文件，按目录结构组织。点击打开文件，右键和基线分支做 diff。

```
 Explorer
 ▸ OPEN EDITORS
 ▾ XLENS: CHANGED FILES
   📁 src
   ├── 📁 services
   │   ├── 📄 auth.ts         M
   │   └── 📄 user.ts         A
   ├── 📄 index.ts            M
   └── 📄 old-util.ts         D
   📄 config → config-v2.ts   R
   📄 notes.md                ?
```

## 工作方式

```
git diff <base-branch> --name-status -- <workspace-prefix>
```

基线分支按 master → main → develop → trunk 顺序自动检测，路径前缀从工作区相对 git root 的位置算。都留空就显示整个仓库的变更。

## Range Review（区间评审）

除了对比基线与工作区，XLens 支持在两个 ref 之间做区间评审：

- 点击树视图标题栏的 `Select Diff Range` 按钮，或在 Change Base Branch / Set Range 选择器中选择 **Set Diff Range...**
- 依次选择 **From**（基线）和 **To**（对比对象）两个 ref：支持本地 / 远程分支、tag、最近 commit，或直接输入 commit SHA
- 默认值：From = 自动检测的基线分支（main/master），To = HEAD
- 视图显示 `git diff <from> <to>` 的变更文件（默认 PR 式 three-dot 语义：`A...B` 只显示目标侧自分叉以来的变更；无共同祖先时自动回退为完整对比，可用 `xlens.gitDiffView.rangeDiffMode` 切换为 two-dot 完整差异）；文件右键 **Open Diff** 对比两个 ref 中的文件内容（重命名文件自动回退旧路径）
- 文件节点显示 GitHub 风格的行数统计（如 `+12 −3`）
- 视图标题显示当前 range（如 `XLens: v1.0.0 → v1.1.0`）；选择 **Clear Range** 恢复与基线分支的对比
- range 随工作区持久化，下次打开自动恢复；range 中引用的 ref 失效（删除 / 强推）时自动回退并提示

### Range Preset

在 range 模式下保存 preset 时，当前 range 会一并存入 preset（Presets 选择器中显示 `range: A → B`）。激活该 preset 即可回顾当时评审的变更范围；回顾时重新选择 range 会同步更新该 preset 的 range。

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `xlens.gitDiffView.baseBranch` | `""` | 基线分支，空则自动检测 |
| `xlens.gitDiffView.filterPrefix` | `""` | 路径前缀，空则自动检测 |
| `xlens.gitDiffView.autoRefresh` | `true` | 文件保存或 git 状态变化时自动刷新 |
| `xlens.gitDiffView.refreshDebounce` | `2000` | 自动刷新防抖（毫秒） |
| `xlens.gitDiffView.autoReveal` | `false` | 切换编辑器时自动在树中展开对应路径 |
| `xlens.gitDiffView.statusDisplay` | `"badge"` | git 状态显示方式：`badge` / `description` / `hidden` |
| `xlens.gitDiffView.rangeDiffMode` | `"three-dot"` | range 对比语义：`three-dot`（PR 式 `A...B`，默认）/ `two-dot`（完整差异 `A B`） |

## 命令

命令 ID 统一为 `xlens.gitDiffView.*` / `xlens.preset.*` 前缀。

| 命令 | 触发位置 |
|------|----------|
| Presets | XLens 树视图标题栏 |
| Refresh (`xlens.gitDiffView.refresh`) | 树视图标题栏 |
| Expand All (`xlens.gitDiffView.expandAll`) | 树视图标题栏 |
| Change Base Branch / Set Range | 树视图标题栏 |
| Select Diff Range (`xlens.gitDiffView.selectRange`) | 树视图标题栏 |
| Open Diff | 文件右键 |
| Open File | 文件点击 / 右键 |
| Copy Relative Path | 文件/文件夹右键 |
| Reveal in File Explorer | 文件/文件夹右键 |
| New File | 文件夹右键 |
| Reveal in XLens | 编辑器标题右键 / 树视图标题栏 |

### Presets

- **Save Current Files as Preset**：保存当前所有变更文件
- **Create Custom Preset**：弹出临时 Webview 页面，展示完整项目文件树（可折叠、可勾选、可搜索）：
  - 点击文件夹会在三种状态间循环：未勾选 → **[-] 跟踪目录** → **[x] 递归全选文件** → 未勾选；部分选中时点击会直接全选
  - 工具栏提供 **Expand all / Collapse all** 批量折叠展开
  - 目录路径会在每次刷新时重新解析，自动适应新增、删除、重命名
  - 整行点击即可勾选，操作更方便
  - 文件按扩展名显示 VS Code 风格颜色图标（TypeScript、JavaScript、图片、PDF 等常见类型）
  - Confirm 后命名保存

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
