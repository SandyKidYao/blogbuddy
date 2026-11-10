<div align="center">

<img src="../images/logo.png" alt="BlogBuddy" width="180">

# BlogBuddy

**VS Code 里的 Markdown 编辑器，你的 Agent 在页边干活。**
在一段文字旁留一句话，接着写，忙完了再看回答。

[![Version](https://img.shields.io/badge/version-0.1.0-FFD900.svg)](https://github.com/FulcrumStd/blogbuddy)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC.svg)](https://marketplace.visualstudio.com/items?itemName=FulcrumStudio.blogbuddy)

[English README](../README.md) · [完整指南](help_CN.md) · [更新日志](../CHANGELOG.md)

</div>

---

## 出发点

你在写东西，想查证一个说法、听听别的看法、把一段话收紧。聊天框会把对话变成主体，文档成了附件：把文字复制过去，交代背景，等它回答，再把有用的部分搬回来。

**BlogBuddy 把这件事反过来。** 文档始终是主体，对话挂在它所针对的块旁边。按 `Cmd+B Cmd+B`，输入一句话，回车，光标立刻回到原处。回答会安静地出现在那个块下方，等你写到一个段落再看。

不需要配置 API key。BlogBuddy 借用你已经在用的 Agent：**Claude Code** 或 **Codex**，在后台运行。

---

## 旁注

旁注是你留在某些块旁边的一句话，加上 Agent 的回答。旁注不会写进你的 Markdown 文件。

**提问**

- 在 BB Editor 里按 `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B`（或点块左侧淡淡的 `※`）。出现一行输入框：输入，按 `↵`。
- 以块为单位。问的是什么，取决于光标在哪里：

| 光标或选区 | 旁注针对的范围 |
|---|---|
| 在段落、列表、代码块、引用或表格里 | 这个块 |
| 在标题上 | 标题下的整节 |
| 选区跨了几个块 | 这几个块 |
| 选区在一个块之内 | 这个块，并引用选中的文字 |

输入框里用 Markdown 自己的记号标出你要问的范围：`¶` 是段落，`## 标题` 是整节，`-` 是列表，` ``` ` 是代码，`>` 是引用，`¶×3` 是三个块，`“…”` 是选中的文字。

**你接着写的时候**

- 块下方出现一行摘要，左侧有一条竖条。流动的虚线表示 Agent 在处理，摘要行用符号显示它正在做什么：`⌕ 关键词` 是搜索，`↗ 域名` 是读网页，文件名是读文件，`✎` 是在写回答。
- 回答到达时只有这一行变化：竖条变实，摘要行显示回答的开头。不弹通知，也不移动光标。
- 右上角的小计数显示未读旁注数，点击跳到下一条。

**阅读和追问**

- 点摘要行，在原地展开对话。最后一行以 `※` 开头：在那里输入就是追问，Agent 会带上这条旁注之前的内容。
- 看完了点 `∎`，旁注就从文档旁移除；`⌃` 只是把它收回成一行。

**修改以建议的形式出现**

当你要求改动（"收紧一点"、"检查错别字"、"把这一节重新组织一下"），Agent 不会动文件。它交回一份修改稿，BB Editor 在旁注展开时按块显示差异：

| 左侧记号 | 含义 |
|---|---|
| `~` | 原地改写，增删直接标在文字上 |
| `−` 在上，`+` 在下 | 大幅改写，旧块在上、新块在下 |
| `+` | 新增的块 |
| `−` | 删除的块 |
| `⤷` 和 `↑` / `↓` | 移动的块：新位置显示全文，原位置缩成一行 |

- 每个改动的块右侧有 `✓` / `×`，可以单独接受或放弃。旁注里用同一套记号统计还剩什么（`~2 +1 −1 ⤷1`），并有一组针对全部改动的 `✓` / `×`。
- 接受就是一次普通的编辑，`Cmd+Z` 可以撤销。在你接受之前，磁盘上的文件不变，自动保存不受影响。
- 有建议挂着的时候你可以照常编辑。如果你改了建议想改的那个块，这一处会失效，不会覆盖你的修改。

**Agent 能做什么**

- 它以只读方式运行：可以读工作区里的文件、联网搜索，不能写文件，也不能执行会改动东西的命令。
- 每次提问会在后台启动一次你的 Agent，用的是那个 Agent 自己的账号和额度。
- 旁注按文档保存在 VS Code 的扩展存储里，不会在你的仓库里产生任何文件。

---

## BB Editor：尊重 Markdown 的所见即所得

基于 [Milkdown](https://milkdown.dev) 的 `.md` 富文本编辑器。用 `Cmd+Shift+B` / `Ctrl+Shift+B` 打开：可以在资源管理器里选中 `.md` 文件，也可以在 VS Code 文本编辑器里打开着 `.md` 时直接原地切换。同一个快捷键切回 Markdown 源码。

- **完整 GFM 的所见即所得**：表格、删除线、任务列表、自动链接、引用、代码块
- **斜杠菜单（`/`）**：块类型
- **Frontmatter 头部**：就是文件里的 `---` 围栏，`title`、`date`、`tags`、`categories`、`author`、`slug`、`draft`、`description` 原地编辑，一键切到原始 YAML
- **源码行号**：每个块显示它在 `.md` 文件里的行号
- **Prism 语法高亮**：20 多种语言，配色跟随 VS Code 的浅色、深色和高对比主题
- **输入法安全**：中日韩输入法组字过程不会进入自动保存
- **箭头连字**：`->` → `→`，`=>` → `⇒`，代码和组字中除外
- **安静的保存**：没改过的块保留原始字节，Git diff 保持很小
- **外部修改提示**：有未保存修改时文件被外部改动，会让你选择加载外部版本或保留当前版本
- **粘贴即落盘**：拖入或粘贴的图片和文件写到文档旁（或 `blogbuddy.assetDir` 下），以相对路径插入
- **Zen / Editor 模式**：右上角的 `Z` / `E` 小按钮。Zen 是居中的专注栏，打字时界面元素淡出；Editor 是全宽，带行号和 frontmatter 头部
- **自动保存**，`Cmd+S` 立即保存

---

## 快速开始

1. 从 VS Code 插件市场安装 **BlogBuddy**。
2. 确认 **Claude Code**（`claude`）或 **Codex**（`codex`）已安装并登录。BlogBuddy 用它找到的第一个，先找 Claude Code。
3. 打开一个 `.md` 文件，按 `Cmd+Shift+B` 进入 BB Editor。
4. 把光标放进一段文字，按 `Cmd+B Cmd+B`，问一句，然后接着写。

---

## 参考

### 快捷键

| 位置 | 快捷键 | 作用 |
|---|---|---|
| 资源管理器（选中 `.md`）或 Markdown 文本编辑器 | `Cmd+Shift+B` / `Ctrl+Shift+B` | 打开 BB Editor |
| BB Editor | `Cmd+Shift+B` / `Ctrl+Shift+B` | 回到 Markdown 源码 |
| BB Editor | `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B` | 对当前块、整节或选区提问 |
| BB Editor | `Cmd+B` / `Ctrl+B` | 加粗 |
| BB Editor | `/` | 斜杠菜单 |
| BB Editor | `Cmd+S` | 立即保存 |
| BB Editor | `Backspace`（在标题开头） | 把标题变回段落 |

### 设置

| 设置项 | 说明 |
|---|---|
| `blogbuddy.agent` | 由哪个 Agent 回答旁注：`auto`（默认，先 Claude Code 后 Codex）、`claude` 或 `codex` |
| `blogbuddy.assetDir` | BB Editor 上传资源的相对子目录（如 `assets`）。留空则与文档同目录 |

### 命令

| 命令 | 用途 |
|---|---|
| `BlogBuddy: Open BB Editor` | 用 BB Editor 打开当前 `.md` |
| `BlogBuddy: Reopen as Markdown Source` | 把当前 BB Editor 切回文本编辑器 |

### 状态栏

Markdown 文件和 BB Editor 的**字数统计**：中文字符和英文单词分别计数后相加，提示里有选中字数、字符数和行数。

---

## 说明

> **开发状态。** BlogBuddy 仍在积极开发中，功能可能调整或变化。
>
> **从旧版本升级？** `<bb-*>` 标签、AI Reader View，以及 API key 和模型相关的设置都已移除。现在所有 AI 协作都通过 BB Editor 里的旁注进行，使用你自己的 Agent 命令行工具。

<details>
<summary><strong>"没有找到 claude 或 codex 命令"</strong></summary>

BlogBuddy 会在 VS Code 的 `PATH`、登录 shell 的 `PATH` 和常见安装位置（`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 等）里找 Agent。如果还是找不到，先确认在新开的终端里 `claude --version` 或 `codex --version` 能运行，然后重启 VS Code。

</details>

---

## 适合谁

用 Markdown 写博客和技术文档、已经在用 Agent、又不想为了和它说话而离开页面的人。

## 反馈

Bug 或功能建议 → [提交 issue](https://github.com/FulcrumStd/blogbuddy/issues)。

---

<div align="center">
<sub>为用 Markdown 写作的人用心打造。</sub>
</div>
