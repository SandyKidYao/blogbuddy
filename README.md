<div align="center">

<img src="images/logo.png" alt="BlogBuddy" width="180">

# BlogBuddy

**A Markdown editor for VS Code where your agent works in the margin.**
Leave a sentence beside a paragraph. Keep writing. Read the answer when you're ready.

[![Version](https://img.shields.io/badge/version-0.2.0-FFD900.svg)](https://github.com/SandyKidYao/blogbuddy)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC.svg)](https://marketplace.visualstudio.com/items?itemName=FulcrumStudio.blogbuddy)

[中文 README](docs/README_CN.md) · [Full guide](docs/help.md) · [Changelog](CHANGELOG.md)

</div>

---

## The premise

You're writing. You want a fact checked, a second opinion, a paragraph tightened. A chat pane makes the conversation the main thing and your document an attachment: copy the text over, explain the context, wait, carry the useful part back.

**BlogBuddy turns that around.** The document stays the main thing, and conversations hang off the blocks they are about. Press `Cmd+B Cmd+B`, type a sentence, press Enter — the caret is back where you were. The answer arrives quietly under that block, and you read it when you reach a stopping point.

There is no API key to configure. BlogBuddy borrows the agent you already use: **Claude Code** or **Codex**, run in the background.

---

## Margin notes

A margin note is a sentence you leave beside some blocks, plus what the agent says back. Notes are never written into your Markdown file.

**Asking**

- `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B` in BB Editor (or click the faint `※` to the left of a block). A one-line box opens: type, press `↵`.
- The block is the unit. What you ask about depends on where the caret is:

| Caret or selection | The note is about |
|---|---|
| In a paragraph, list, code block, quote or table | That block |
| In a heading | The whole section under it |
| A selection across several blocks | Those blocks |
| A selection inside one block | That block, with the selected words quoted |

The box shows what you are about to ask about in Markdown's own signs: `¶` a paragraph, `## Title` a section, `-` a list, ` ``` ` code, `>` a quote, `¶×3` three blocks, `“…”` the selected words.

**While you keep writing**

- A one-line summary appears under the block, with a rail to its left. Marching dashes mean the agent is working; the line shows what it is doing in signs — `⌕ query` searching, `↗ host` reading a page, a file name, `✎` writing.
- When the answer lands, only that line changes: the rail turns solid and the line shows the first words of the answer. Nothing pops up, and the caret is never moved.
- A small counter at the top-right shows unread notes; click it to jump to the next one.

**Reading and following up**

- Click the line to expand the thread in place. The last row starts with `※`: type there to follow up; the agent keeps the note's earlier turns.
- `∎` dismisses a note once you are done with it; `⌃` just folds it back to one line.

**Changes are proposals**

When you ask for changes ("tighten this", "fix typos", "reorganise this section"), the agent never touches the file. It hands back a rewrite, and BB Editor shows the difference block by block while the note is open:

| Sign (left) | Meaning |
|---|---|
| `~` | Rewritten in place — deletions and insertions marked in the text |
| `−` above `+` | Heavily rewritten — old block above, new block below |
| `+` | New block |
| `−` | Block removed |
| `⤷` and `↑` / `↓` | Block moved: shown in full at its new place, collapsed to one line at the old one |

- Accept or reject each changed block with `✓` / `×` on its right. The note counts what is left in the same signs (`~2 +1 −1 ⤷1`) and has its own `✓` / `×` for all of it.
- Accepting is an ordinary edit — `Cmd+Z` undoes it. Until you accept, the file on disk is unchanged and auto-save is unaffected.
- You can keep editing around a proposal. If you edit a block the proposal wanted to change, that one change is dropped rather than applied over your edit.

**What the agent can do**

- It runs read-only: it can read files in your workspace and search the web, and it cannot write or run commands that change anything.
- Each question starts one background run of your agent and uses that agent's own account and quota.
- Notes are kept in VS Code's extension storage, per document — nothing is added to your repository.

---

## BB Editor — live preview over your Markdown

An editor for `.md` files, built on [CodeMirror 6](https://codemirror.net). What you edit is the file's own text: Markdown's marks are hidden and the text is styled, except on the line you are editing, where the marks come back (faintly) so you can change them directly. Open it with `Cmd+Shift+B` / `Ctrl+Shift+B` — on a `.md` file in the Explorer, or with a `.md` already open in VS Code's text editor to swap it for BB Editor in place. The same chord switches back to the Markdown source.

- **Live preview with GFM** — headings, emphasis, links, lists, task lists (click a box to tick it), quotes, rules, images, fenced code; tables render as tables until you click into them
- **The file is the document** — BB Editor edits VS Code's own document for the file. Nothing is rewritten on save; the unsaved dot, Save / Save As, Revert and hot exit work as in any editor; changes made on disk, by another extension, or in a text editor showing the same file appear as you type, and yours appear there
- **Slash menu (`/`)** — block types, written as Markdown
- **Frontmatter head** — the file's own `---` fences, with `title` · `date` · `tags` · `categories` · `author` · `slug` · `draft` · `description` edited in place; raw YAML one click away
- **Source line numbers** — the file's line numbers beside the text
- **Code highlighting** — by the language named after the fence (JS/TS, Python, Go, Rust, Java, C/C++, SQL, YAML, JSON, HTML/CSS, Shell, Diff, TOML …); colours follow VS Code's light / dark theme
- **Find (`Cmd+F`)** — across the whole document
- **IME-safe** — CJK composition reaches the document only once it is committed
- **Arrow ligatures** — `->` → `→`, `=>` → `⇒` outside code and IME
- **Paste-to-disk assets** — images and files dropped into the editor are written next to the document (or under `blogbuddy.assetDir`) and inserted as relative paths
- **Zen / Editor mode** — the small `Z` / `E` button at the top-right. Zen is a centered, distraction-free column whose chrome fades while you type; Editor is full width with line numbers and the frontmatter head
- **Saving is VS Code's** — with `files.autoSave` on, your edits are saved like any other file's; with it off they wait for `Cmd+S` (which asks for a name for an untitled document). Switching between BB Editor and the text editor (`Cmd+Shift+B`) happens in place and carries unsaved changes along

---

## Quick start

1. Install **BlogBuddy** from the VS Code Marketplace.
2. Make sure **Claude Code** (`claude`) or **Codex** (`codex`) is installed and signed in. BlogBuddy uses whichever it finds, Claude Code first.
3. Open a `.md` file and press `Cmd+Shift+B` to open it in BB Editor.
4. Put the caret in a paragraph, press `Cmd+B Cmd+B`, ask something, and keep writing.

---

## Reference

### Keybindings

| Where | Shortcut | Action |
|---|---|---|
| Explorer (on a `.md` file) or Markdown text editor | `Cmd+Shift+B` / `Ctrl+Shift+B` | Open BB Editor |
| BB Editor | `Cmd+Shift+B` / `Ctrl+Shift+B` | Back to the Markdown source |
| BB Editor | `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B` | Ask about the current block, section or selection |
| BB Editor | `Cmd+B` / `Ctrl+B` | Bold |
| BB Editor | `/` | Slash menu |
| BB Editor | `Cmd+S` | Save immediately |
| BB Editor | `Backspace` (at start of heading) | Convert heading back to paragraph |

### Settings

| Key | Description |
|---|---|
| `blogbuddy.agent` | Which agent answers margin notes: `auto` (default — Claude Code, then Codex), `claude`, or `codex` |
| `blogbuddy.assetDir` | Relative subdirectory for BB Editor uploads (e.g. `assets`). Empty = alongside the document |

### Commands

| Command | Purpose |
|---|---|
| `BlogBuddy: Open BB Editor` | Open the current `.md` in BB Editor |
| `BlogBuddy: Reopen as Markdown Source` | Switch the focused BB Editor back to the text editor |

### Status bar

**Word count** for Markdown files and BB Editor — Chinese characters and English words counted separately and summed, with selection, characters and lines in the tooltip.

---

## Notes

> **Development status.** BlogBuddy is in active development. Features may move, break, or change between versions.
>
> **Coming from an earlier version?** The `<bb-*>` tags, the AI Reader View, and the API key / model settings are gone. Everything AI now happens through margin notes in BB Editor, using your own agent CLI.

<details>
<summary><strong>"没有找到 claude 或 codex 命令"</strong></summary>

BlogBuddy looks for the agent on VS Code's `PATH`, your login shell's `PATH`, and the usual install locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, …). If it still cannot find one, check that `claude --version` or `codex --version` works in a new terminal, then restart VS Code.

</details>

---

## Made for

Bloggers and technical writers who live in Markdown, already work with an agent, and would rather not leave the page to talk to it.

## Feedback

Bug or feature request → [open an issue](https://github.com/SandyKidYao/blogbuddy/issues).

---

<div align="center">
<sub>Built with care for people who write in Markdown.</sub>
</div>
