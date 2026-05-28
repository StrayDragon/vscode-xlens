# XLens

在 monorepo 子项目中工作时，只看当前目录下有变化的文件。

## 它有什么用

在大型仓库中打开 `services/user-service/` 这类子文件夹时，VS Code 的源代码管理视图会显示整个仓库的变更，大部分和你无关。XLens 只显示当前工作区下的变更文件。

树状视图直接放在 Explorer 边栏里（和 Timeline、Outline 在一起），会自动跟踪当前打开的文件并展开对应路径。点击文件可以打开，右键可以和基线分支做 diff、在文件管理器中显示，或者直接新建文件。

## 配置

`gitDiffExplorer.baseBranch` 留空会自动检测（按 master → main → develop → trunk 顺序），也可以手动指定。`filterPrefix` 通常不需要管，会根据工作区相对路径自动设置。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `gitDiffExplorer.baseBranch` | `""`（自动检测） | 比较的基线分支 |
| `gitDiffExplorer.filterPrefix` | `""` | 路径过滤前缀（通常自动检测） |
| `gitDiffExplorer.autoRefresh` | `true` | 文件保存或 git 状态变化时自动刷新 |
| `gitDiffExplorer.refreshDebounce` | `2000` | 自动刷新防抖间隔（毫秒） |

## 命令

- 刷新树视图
- 切换基线分支
- 打开文件、和基线分支做 diff
- 复制相对路径
- 在文件管理器中显示
- 新建文件（自动创建所需目录）
- 在 XLens 中定位当前编辑器文件

## License

MIT
