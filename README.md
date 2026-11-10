<div align="center">

<img src="images/logo.png" alt="BlogBuddy" width="180">

# BlogBuddy

**AI commands that live inside your Markdown.**
Write a tag. Press a chord. Watch it resolve, in place.

[![Version](https://img.shields.io/badge/version-0.0.13-FFD900.svg)](https://github.com/FulcrumStd/blogbuddy)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC.svg)](https://marketplace.visualstudio.com/items?itemName=FulcrumStudio.blogbuddy)
[![BB](https://img.shields.io/badge/created_with-BB-FFD900)](https://github.com/FulcrumStd/blogbuddy)

[中文 README](docs/README_CN.md) · [Full guide](docs/help.md) · [Changelog](CHANGELOG.md)

</div>

---

## The premise

You're writing Markdown. You want AI help — to expand, polish, translate, summarise, diagram. Most tools yank you out to a chat window, then back, then out again.

**BlogBuddy puts the verbs in your prose.** Drop a tag like `<bb-expd:add concrete examples>` into a paragraph, press `Cmd+B Cmd+B`, and the tag (plus the surrounding block) is replaced by streaming AI output — without leaving the cursor.

That's the entire idea. Everything else is doing it well.

---

## The tag, in one screen

```markdown
Machine learning is changing how software gets written.
<bb-expd:make this suitable for a senior engineering audience>
```

Place the cursor in that paragraph. Hit `Cmd+B Cmd+B`. The tag disappears, the paragraph expands, words stream in token by token. Scope is inferred from where the tag sits — same line, full paragraph, or whole document.

---

## The vocabulary

Eight inline commands plus a four-preset reader. All accept an optional refinement after the colon: `<bb-foo:say more about X>`.

| Tag | What it does |
|---|---|
| `<bb:any instruction>` | Free-form. Hand BB any task; it works on the current scope. The flexible escape hatch |
| `<bb-expd:focus>` | Expand and elaborate, keeping tone |
| `<bb-impv:focus>` | Polish for clarity. Inline mode rewrites the block; standalone tag rewrites the whole document into `*_improved.md` |
| `<bb-tslt:target language>` | Translate the document. Outputs `myblog_日本語.md` and a link |
| `<bb-tldr:style>` | Inline TL;DR summary |
| `<bb-mmd:diagram type>` | Generate a fenced Mermaid block. Picks flowchart / sequence / class / state / ER / gantt / pie automatically |
| `<bb-kwd:focus>` | 8–12 SEO-friendly keywords |
| `<bb-tag>` | Insert a "created with BB" attribution badge |
| `<bb-render-blog:>` `<bb-render-skim:>` `<bb-render-expl:>` `<bb-render:prompt>` | AI Reader View — see below |

> **Streaming everywhere.** Output appears as the model writes it. **Context-aware.** BB reads the surrounding document, not just the highlighted text. **Smart scope.** Cursor position alone tells BB whether to rewrite a line, a paragraph, or the whole file.

---

## BB Editor — a WYSIWYG that respects Markdown

A built-in rich-text editor for `.md` files, powered by [Milkdown](https://milkdown.dev). Open it with `Cmd+Shift+B` / `Ctrl+Shift+B` — either on a `.md` file in the Explorer, or with a `.md` already open in VS Code's text editor to swap it for the BB Editor in place. The editor title bar's BB icon does the same. Saves as plain Markdown, with predictable normalisation.

- **WYSIWYG with full GFM** — tables, strikethrough, task lists, autolinks, blockquotes, fenced code
- **Slash menu (`/`)** — block types and every BB command, pre-filled
- **Inline `Cmd+B Cmd+B`** — fire any `<bb-*>` tag without leaving the canvas
- **Streaming AI blocks** — results appear inline as a typed ProseMirror node
- **Frontmatter Properties panel** — `title` · `date` · `tags` · `categories` · `author` · `slug` · `draft` · `description` rendered as typed controls (date picker, chip input, toggle, textarea). Raw YAML remains available as a collapsible fallback
- **Prism syntax highlighting** — 20+ languages; palette tracks VS Code light / dark / high-contrast themes
- **IME-safe** — CJK composition events guard auto-save and BB triggers
- **Arrow ligatures** — `->` → `→`, `=>` → `⇒` outside code and IME
- **Compact save** — bullets normalised to `-`, blank lines collapsed, entities decoded — Git diffs stay quiet
- **External-change banner** — if the file is touched on disk while you have unsaved edits, choose Reload or Keep
- **Paste-to-disk assets** — images and files dropped into the canvas are written next to the document (or under `blogbuddy.assetDir`) and inserted as relative paths
- **Zen / Editor mode** — small `Z` / `E` button at the top-right. Zen Mode is a centered, distraction-free column: no line numbers, frontmatter or column edges, and the toggle fades while you type. Editor Mode is full width with line numbers and the frontmatter head. Choice persists across sessions
- **Auto-save** with `Cmd+S` to flush

---

## AI Reader View — your Markdown, redesigned

Trigger `<bb-render-*>` and the AI re-interprets your document as a complete HTML "reading artifact" — rendered in a side panel, never touching your source file.

| Preset | The brief to the model |
|---|---|
| `<bb-render-blog:>` | Polished article — sticky TOC, callouts, comfortable measure |
| `<bb-render-skim:>` | TL;DR up top, dense visual structure, `<details>` for skippable depth |
| `<bb-render-expl:>` | Teaching artifact — SVG diagrams, code annotations, "why this matters" sidebars |
| `<bb-render:your prompt>` | Custom — your prompt drives the entire creative direction |

- **Live streaming preview** in a sandboxed iframe — watch the HTML compose itself
- **Editable refinement prompt + Regenerate** — tweak without re-typing the tag
- **Self-contained `.html` export** — local images base64-inlined by default (toggle `blogbuddy.reader.inlineAssets` for relative paths instead)
- **`.bbreader.md` style reference** (optional) — drop one at your workspace root describing typography, colors, components; every render uses it as authoritative style guidance. Scaffold via **BlogBuddy: Create .bbreader.md Template**
- **Source-changed banner** — re-render on demand, never automatic (renders are slow and metered)
- **Cost guard** at ~25k input tokens — large docs prompt for confirmation before spending

---

## Quick start

1. Install **BlogBuddy** from the VS Code Marketplace.
2. Set credentials — either `blogbuddy.apiKey` in settings, **or** export `BLOGBUDDY_API_KEY` (or `OPENAI_API_KEY`).
3. *(Optional)* set `blogbuddy.baseURL` for OpenAI-compatible providers (OpenRouter, DeepSeek, your own proxy). Default: `https://api.openai.com/v1`.
4. Run **BlogBuddy: Select Model** from the command palette — picks from `/v1/models`, or enter a custom id.
5. Open a `.md` file, drop a tag, press `Cmd+B Cmd+B`.

---

## Reference

### Keybindings

| Where | Shortcut | Action |
|---|---|---|
| Markdown editor | `Cmd+B Cmd+B` / `Ctrl+B Ctrl+B` | Execute BB on the current block or selection |
| Explorer (on a `.md` file) or open Markdown editor | `Cmd+Shift+B` / `Ctrl+Shift+B` | Open BB Editor (swaps the active Markdown editor in place) |
| BB Editor | `/` | Slash menu (BB commands + block types) |
| BB Editor | `Cmd+B Cmd+B` | Fire an inline `<bb-*>` tag |
| BB Editor | `Cmd+S` | Save immediately |
| BB Editor | `Backspace` (at start of heading) | Convert heading back to paragraph |

### Settings

Only `apiKey` and `model` are required; everything else has sensible defaults.

| Key | Description |
|---|---|
| `blogbuddy.apiKey` | API key. Falls back to `$BLOGBUDDY_API_KEY` → `$OPENAI_API_KEY` |
| `blogbuddy.baseURL` | OpenAI-compatible base URL. Falls back to `$BLOGBUDDY_BASE_URL` → `$OPENAI_BASE_URL` → `https://api.openai.com/v1` |
| `blogbuddy.model` | Model id. Use **BlogBuddy: Select Model** to pick from the provider's list |
| `blogbuddy.assetDir` | Relative subdirectory for BB Editor uploads (e.g. `assets`). Empty = alongside the document |
| `blogbuddy.reader.inlineAssets` | Inline local images as base64 when exporting Reader HTML. Default `true` |

### Commands

Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and type `BlogBuddy:`.

| Command | Purpose |
|---|---|
| `BlogBuddy: Hi BB` | Execute BB on the current scope (same as the chord) |
| `BlogBuddy: Open BB Editor` | Open the current `.md` in BB Editor |
| `BlogBuddy: Select Model` | Fetch `/v1/models` and pick (or enter) a model id |
| `BlogBuddy: Show Config Diagnostics` | Masked report of what the extension actually resolves for each field |
| `BlogBuddy: Show Usage Statistics` | Token usage, request counts, per-model cost (where pricing is available) |
| `BlogBuddy: Reset Usage Statistics` | Clear all counters (with confirmation) |
| `BlogBuddy: Refresh Pricing Data` | Re-fetch pricing data |
| `BlogBuddy: Create .bbreader.md Template` | Scaffold the AI Reader style-reference template |

### Status bar

Two right-side items, both Markdown-only:

- **Word count** — Chinese characters and English words counted separately and summed
- **Config source** — `$(key) BB · cfg | env | default` shows where your `apiKey` resolves from; turns yellow on missing key or model. Hover for the per-field source table; click to open Diagnostics

---

## Notes

> **Development status.** BlogBuddy is in active development. Features may move, break, or change between versions. Please use with judgement in production workflows.
>
> **Experimental.** The free-form `<bb:>` command is the most flexible and the most token-hungry — prefer specialised tags when one fits.

<details>
<summary><strong>macOS — env var not picked up?</strong></summary>

Apps launched from Dock or Spotlight don't inherit your shell config. Two fixes:

- **From Terminal:** `source ~/.zshrc && code .`
- **Persistent:** `launchctl setenv OPENAI_API_KEY 'sk-...'`, then ⌘Q and relaunch VS Code

Run **BlogBuddy: Show Config Diagnostics** to verify what the extension host actually sees.

</details>

---

## Made for

Bloggers and content writers · technical writers who need diagrams and translations · multilingual authors · anyone who'd rather press a key than open a tab.

## Feedback

Bug or feature request → [open an issue](https://github.com/FulcrumStd/blogbuddy/issues).

---

<div align="center">
<sub>Built with care for people who write in Markdown.</sub>
</div>
