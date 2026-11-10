# BlogBuddy — Complete Guide

[中文版本](help_CN.md) · [README](../README.md) · [Changelog](../CHANGELOG.md)

BlogBuddy is a VS Code extension with two parts: **BB Editor**, a WYSIWYG Markdown editor, and **margin notes**, a way to work with your agent without leaving the page. This guide is the reference — setup, how notes behave, the editor, settings and troubleshooting.

---

## Quick start

1. Install **BlogBuddy** from the VS Code Marketplace.
2. Install and sign in to **Claude Code** (`claude`) or **Codex** (`codex`). BlogBuddy has no API key of its own; it runs the agent CLI you already have.
3. Open a `.md` file and press `Cmd+Shift+B` (Mac) / `Ctrl+Shift+B` (Win/Linux) to open it in BB Editor.
4. Put the caret in a paragraph and press `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B`. Type a sentence, press Enter, keep writing.

---

## Margin notes

A margin note is a sentence you leave beside one or more blocks, and the agent's answer to it. Notes belong to the document but are never written into the Markdown file.

### Asking

Press `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B` (a single `Cmd+B` still toggles bold). With the mouse, click the faint `※` that appears to the left of a block when you hover it.

A one-line box opens: `※`, your sentence, a sign for what you are asking about, and `↵`. Press Enter to send, `Esc` to cancel. After sending, the caret is exactly where it was.

### What a note is about

The block is the unit — a paragraph, a list, a code block, a quote, a table.

| Caret or selection | Scope | Sign in the ask box |
|---|---|---|
| Inside a block | That block | `¶` paragraph · `-` / `1.` list · ` ``` ` code · `>` quote · `\|` table |
| In a heading | The heading and everything under it, up to the next heading of the same or a higher level | `## heading text` |
| Selection spanning several blocks | Those blocks | `¶×N` |
| Selection inside one block | That block; the selected words are passed along as a quote | 「*selected text*」 |

While the ask box is open, a dashed rail on the left shows exactly which blocks are covered.

The agent receives the Markdown of those blocks, your sentence, earlier turns of the same note, and the path of the document so it can read the rest for context. Unsaved edits are flushed to disk first.

### While the agent works

- A one-line summary sits under the block (under the heading, for a section note): your question, then what the agent is doing right now.
- A rail runs down the left of the blocks the note covers. Marching dashes = working.
- You can open the line to watch progress, or press `×` there to cancel the run.

Progress is shown in signs: the agent's name while it starts, `…` thinking, a file name when it reads a file, `⌕ query` searching (the web or your files), `↗ host` reading a web page, `$ command` (Codex), `✎` writing the answer.

The line is added the moment you send — which is your own action — so nothing shifts under you later.

### When the answer arrives

Only that line changes: it now shows the first words of the answer, and the rail turns solid. There is no notification and the caret does not move. In Zen Mode, notes dim further while you are typing.

The counter at the top-right shows how many notes are unread and whether any are still running. Click it to open the next unread note.

| Rail | Line starts with | State |
|---|---|---|
| Marching dashes | spinner | The agent is working |
| Solid | `●` | Answered, unread |
| Faint | `※` | Read |
| Solid or faint | `±` | Carries changes you have not decided on |
| Red | `!` | The run failed — open the note to see why and retry |

### Reading, following up, finishing

Click the line (or the rail) to expand the thread in place; `⌃` folds it back, as does `Esc` in the follow-up row. The last row of an open note starts with `※`, like every question above it: type there and press Enter to follow up in the same note. `∎` at the end of that row removes the note for good.

### Proposed changes

Ask for a change and the agent returns a rewrite of the note's blocks. BB Editor compares it with what is there block by block and, while the note is open, draws the difference over the document. The file is not modified.

| Left gutter | What you see | Meaning |
|---|---|---|
| `~` (blue) | Deletions struck through, insertions highlighted, in place | Block rewritten lightly |
| `−` (red) then `+` (green) | Old block dimmed above, new block below | Block rewritten heavily |
| `+` (green) | A new block with a tinted background | Block added |
| `−` (red) | The block dimmed | Block removed |
| `⤷` (blue) | The block in full at its new place | Block moved here |
| `↑` / `↓` (blue) | The block collapsed to one line | Where the moved block used to be |

Inside a list that was rewritten as a list, the signs sit on the individual items.

**Deciding**

- With several changed blocks, each has `✓` (accept) and `×` (reject) in the right gutter.
- The note itself counts what is left in the gutter's signs — `~2 +1 −1 ⤷1` means two rewrites, one addition, one removal, one move (a single rewrite shows characters instead: `−77 +8`) — and has `✓` / `×` at the right for all of it.
- Accepting applies an ordinary edit. `Cmd+Z` undoes it; accepting everything is one undo step.
- Once decided, the note shows `✓4 ×1` (accepted, rejected). `↺` brings rejected changes back.
- `≠1` means one change no longer applies because you edited its block (see below).
- Collapse the note and the markings disappear; the proposal stays with the note until you decide.

**If you keep editing**

Changes are located by the text of the blocks they apply to, so you can edit elsewhere — even add blocks inside the same section — and the rest still lines up. If you edit a block that a change targets, that change is marked as no longer applicable instead of being applied over your words.

**If the answer arrives while the note is open**

The markings are not switched on under your cursor. The note shows `±` at the right; click it when you want to look.

### The signs at a glance

| Sign | Where | Meaning |
|---|---|---|
| `※` | Start of a line, left of a block on hover | Something said to the agent; type after it to ask |
| `⌃` | Top right of an open note | Fold the note back to one line |
| `∎` | End of the follow-up row | Finish with the note and remove it |
| `×` | Right of a working note | Cancel the run |
| `↻` | Right of a failed note | Ask again |
| `±` | Right of a note with changes | Show the changes over the text |
| `✓` `×` | Right of a changed block, or of the note's count | Accept / reject |
| `↺` | Right of a decided note | Bring rejected changes back |

Hovering any sign shows what it does.

### What the agent is allowed to do

- **Claude Code** runs with only the read and web tools (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`).
- **Codex** runs in its `read-only` sandbox with web search enabled.
- Its working directory is the workspace folder that contains the document.
- It uses your own agent account, configuration and quota. One question = one run.

### Where notes are kept

In VS Code's extension storage, keyed by the document's path. They survive closing the editor and restarting VS Code, they do not sync to other machines, and nothing is written into your workspace. After the file changes on disk (or on reopening), each note finds its blocks again by their text.

A question still running when the editor closes is stopped; the note comes back marked `!`, with `↻` to ask again.

---

## BB Editor

A WYSIWYG Markdown editor built into the extension. Open it from the Explorer context menu, the BB icon in the editor title bar, or `Cmd+Shift+B` / `Ctrl+Shift+B`; the same chord switches a BB Editor back to the Markdown source. It reads and writes plain Markdown.

### Core editing

- **WYSIWYG with full GFM** — tables, strikethrough, task lists, autolinks, blockquotes, code blocks
- **Slash menu (`/`)** — block types
- **Asset paste** — paste or drag-drop files; saved to the document directory or to `blogbuddy.assetDir`, inserted as relative paths
- **Prism syntax highlighting** — 20+ languages; palette tracks VS Code light / dark / high-contrast themes
- **Arrow ligatures** — `->` → `→`, `=>` → `⇒`; skipped inside code and during IME composition
- **Heading-to-paragraph** — `Backspace` at the start of a heading converts it to a paragraph
- **`Cmd+F`** — find in the document
- **Zen / Editor mode** — the `Z` / `E` button at the top-right. Zen: a centered column with no line numbers or frontmatter, chrome fading while you type. Editor: full width with line numbers and the frontmatter head. The choice is global and persists

### Frontmatter

The document's YAML head is shown between its own `---` fences at the top of the editor (Editor mode). Collapsed, it is a one-line summary; expanded, known keys (`title`, `date`, `tags`, `categories`, `author`, `slug`, `draft`, `description`) are edited in place and `{ }` switches to the raw YAML.

### Saving and reliability

- **Auto-save** about half a second after you stop typing; `Cmd+S` saves at once
- **Quiet saves** — blocks you did not edit keep their original bytes
- **IME composition guard** — CJK input in progress never reaches auto-save
- **External changes** — a clean editor follows the file on disk; with unsaved edits, a banner offers to load the external version or keep yours
- **Draft recovery** — if the editor closes with edits that cannot be written safely, they open in a new untitled tab

---

## Status bar

**Word count** for the active Markdown file or BB Editor: Chinese characters and English words counted separately and summed. The tooltip adds selected words, characters and lines.

---

## Configuration

| Setting | Description |
|---|---|
| `blogbuddy.agent` | Which agent answers margin notes. `auto` (default) uses Claude Code if installed, otherwise Codex; `claude` and `codex` pin one |
| `blogbuddy.assetDir` | Relative subdirectory for BB Editor asset uploads (e.g. `assets`, `images/uploads`). Resolved from the document directory and must stay within it. Empty = alongside the document |

Model choice, login and everything else about the agent are configured in the agent itself.

### Commands

| Command | Purpose |
|---|---|
| `BlogBuddy: Open BB Editor` | Open the current `.md` in BB Editor |
| `BlogBuddy: Reopen as Markdown Source` | Switch the focused BB Editor back to the text editor |

### Shortcuts

| Where | Shortcut | Action |
|---|---|---|
| Explorer / Markdown text editor | `Cmd+Shift+B` / `Ctrl+Shift+B` | Open BB Editor |
| BB Editor | `Cmd+Shift+B` / `Ctrl+Shift+B` | Back to Markdown source |
| BB Editor | `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B` | Ask about the block, section or selection |
| BB Editor | `Cmd+B` / `Ctrl+B` | Bold |
| BB Editor | `/` | Slash menu |
| BB Editor | `Cmd+S` | Save immediately |
| Ask box / follow-up | `Enter` · `Esc` | Send · cancel |

---

## Troubleshooting

### "没有找到 claude 或 codex 命令"

BlogBuddy searches VS Code's `PATH`, your login shell's `PATH`, and common install locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.cargo/bin`). Confirm `claude --version` or `codex --version` works in a fresh terminal, then restart VS Code. If you pinned `blogbuddy.agent` to one that is not installed, set it back to `auto`.

### The note says the agent gave no answer

Open the note: the message includes what the agent printed. The usual causes are not being signed in, or having run out of quota. Run the agent once in a terminal to check, then press `↻`.

### The note shows `≠`

A change no longer applies: the block it targeted was edited after the question was asked. Follow up in the same note to get a fresh proposal against the current text.

### A note sits under the wrong block after the file changed on disk

Notes are re-attached by block text. If the block was rewritten outside the editor, the note falls back to the block at the same position. Dismiss it with `∎` and ask again.

### Coming from 0.0.19 or earlier

The `<bb-*>` tags, the AI Reader View, model selection, usage statistics and the `blogbuddy.apiKey` / `baseURL` / `model` / `reader.inlineAssets` settings were removed. Old settings left in your `settings.json` are ignored and can be deleted.

---

*Built with care for people who write in Markdown.*
