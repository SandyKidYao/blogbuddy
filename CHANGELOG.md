# Change Log

All notable changes to the "blogbuddy" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- **English and Chinese interface.** BlogBuddy follows VS Code's display language: Simplified Chinese shows Chinese, every other language shows English. This covers commands, settings, margin notes (tooltips, errors), the properties panel, the slash menu, the find bar and the status bar. The slash menu also matches English keywords in either language (`/h1`, `/table`). Answers from the agent stay in the language you write in, as before.

## [0.2.0] - 2026-11-12

### Changed

- **BB Editor is built on CodeMirror 6** instead of Milkdown. The text you edit is the file's Markdown, shown as live preview: marks are hidden and the text styled, except on the line being edited, where they reappear faintly. Tables render until you click into them; task boxes can be ticked; code blocks are highlighted by the language after the fence.
- **BB Editor edits VS Code's document for the file** (a custom text editor). Saving, the unsaved dot, Save As, Revert and hot exit are VS Code's own; a text editor open on the same file stays in step with BB Editor as either one is typed in; changes on disk arrive as edits to just the lines that changed, so the caret, undo history and margin notes stay where they were.
- Saves never rewrite untouched text — there is no conversion between the editor and the file.
- **Saving follows VS Code's `files.autoSave` setting.** BB Editor no longer saves on its own a moment after typing, nor before asking a margin note (the agent is told when the file on disk is behind the editor); `Cmd+S` saves.
- `Cmd+Shift+B` swaps BB Editor and the text editor in place, like Reopen Editor With: unsaved changes go along, nothing is saved.
- The frontmatter is part of the document again (line numbers count it); it is still shown and edited as the properties head, and ordinary typing cannot reach into it. Its source view is now a small code editor with YAML (or TOML) highlighting, Tab indenting and its own undo.
- `Cmd+F` searches the whole document with the editor's own find bar.
- **Margin notes are easier to see.** A note is a tinted band under its block, its colour its state — amber unread or working, grey read, red failed — with the question in bold and the answer in text colour; the rail beside its blocks takes the same colour. An open note is a tinted card; pending changes are counted in coloured chips (`~1 +1 −1`), and accept / reject are bordered buttons, accept in green.

### Removed

- The external-change banner, the draft-recovery tab and BB Editor's own file watching and conflict handling — VS Code handles these for its documents.

## [0.1.0] - 2026-11-10

A change of direction: BlogBuddy is now BB Editor plus **margin notes**. The inline `<bb-*>` tags and the API-key setup are gone; AI help comes from the agent CLI you already use, working beside the text instead of inside it.

### Added

- **Margin notes.** In BB Editor, `Cmd+B Cmd+B` (or the `※` left of a block) leaves a sentence beside the current block. The caret returns at once; the answer arrives silently as a one-line summary under the block and expands in place. Follow-ups stay in the same note; `∎` dismisses it. The note UI speaks in signs rather than words: scope in Markdown's own markers (`¶`, `## Title`, `-`, `¶×3`), progress as `⌕ query` / `↗ host` / `✎`, buttons as glyphs.
- **Block-based scope.** A note is about whole blocks: the block under the caret, a heading's entire section, or the blocks a selection spans. Text selected inside a block is passed along as a quote.
- **Proposed changes, block by block.** When asked to change text, the agent returns a rewrite that is shown over the document while the note is open — rewritten in place (`~`), rewritten heavily (old above new), added (`+`), removed (`−`), moved (`⤷`, `↑` / `↓`), and item-level changes inside lists. Accept or reject each block on its right, or all at once. Accepting is an ordinary edit (`Cmd+Z` undoes it); the file never changes before that.
- **Your own agent, read-only.** Notes are answered by Claude Code or Codex, run headless with file-reading and web-search tools only. New setting `blogbuddy.agent` (`auto` / `claude` / `codex`).
- **Notes persist** per document in the extension's storage and re-attach to their blocks by text after the file changes on disk.
- **Unread counter** beside the Zen / Editor toggle.

### Changed

- `Cmd+B Cmd+B` in BB Editor now opens the ask box. A single `Cmd+B` still bolds immediately.
- The slash menu lists block types only.

### Removed

- All `<bb-*>` inline tags (`bb`, `bb-expd`, `bb-impv`, `bb-tslt`, `bb-tldr`, `bb-mmd`, `bb-kwd`, `bb-tag`) and the `BlogBuddy: Hi BB` command, in both the text editor and BB Editor.
- **AI Reader View** — the `<bb-render-*>` tags, the Reader panel, HTML export and `.bbreader.md` (including `BlogBuddy: Create .bbreader.md Template`).
- Settings `blogbuddy.apiKey`, `blogbuddy.baseURL`, `blogbuddy.model`, `blogbuddy.reader.inlineAssets`, and the `BLOGBUDDY_*` / `OPENAI_*` environment-variable fallbacks.
- Commands **Select Model**, **Show Config Diagnostics**, **Show / Reset Usage Statistics**, **Refresh Pricing Data**, and the config-source status bar item.
- The `openai` dependency.

---

## [0.0.19] - 2026-10-27

### Added

- **Markdown source line numbers in BB Editor.** A gutter shows each block's line in the underlying `.md` file (frontmatter included), so positions match the text editor and error messages.
- **Heading level hints.** Hovering an H1–H6 heading shows its level and source line.
- **Live word count.** The status bar shows words, selected words, characters and lines for the focused BB Editor; plain Markdown editors use the same label and tooltip.
- **Unsaved draft recovery.** If the BB Editor closes with edits that can't be written safely (external conflict, file deleted or read-only), the draft opens in a new untitled tab instead of being lost.

### Changed

- **`Cmd+B` / `Ctrl+B` bolds immediately.** It only waits for the `Cmd+B Cmd+B` chord when a BB tag is in reach, and the chord no longer touches formatting.
- **Removed the Explorer context-menu entry** for opening the BB Editor (the title-bar icon and `Cmd+Shift+B` remain), and shortened the settings descriptions.
- **Fixed transparent areas inside the extension icon.**

### Fixed

- **External edits are no longer overwritten by a stale auto-save.** Every save is checked against the file on disk and the document version; a clean editor follows external changes, a dirty one asks whether to reload or keep its version. Body and frontmatter are saved as one snapshot.
- **Switching to the Markdown source no longer drops the latest keystrokes**, and AI processing no longer loses the original text — AI output is a separate suggestion that only replaces the source when accepted, and keeps streaming when the block is moved.
- **Save As onto an existing file** no longer reports a false conflict after you confirmed the overwrite.
- **A deleted or unreadable file** is reported once instead of a repeating "save failed".
- **Using the AI Reader in an unsaved document** keeps the render tag and asks you to save first.
- **BB tags spanning formatted text or several paragraphs** are located exactly, and IME composition no longer cancels a command by timing out.
- **Less work per keystroke on long documents.** Drafts, statistics and saves share one serialization, and file watching uses a single watcher plus a metadata poll.

---

## [0.0.18] - 2026-08-18

### Added

- **`Cmd+F` / `Ctrl+F` search in BB Editor.** The panel now enables VS Code's built-in find widget, so in-document search works like any text editor.
- **Two-way switching between BB Editor and Markdown source.** A new `$(code)` title-bar button and the same `Cmd+Shift+B` / `Ctrl+Shift+B` chord (now a toggle) swap the active BB Editor back to a plain text editor in the same column — previously the only way back was reopening the file. Pending edits are flushed to disk before the swap (with a `flush-noop` fast path when nothing changed).

### Fixed

- **Opening a file in BB Editor no longer rewrites it on disk.** Loading content into Milkdown fired the same auto-save path as a user edit, so merely viewing a file dirtied it in git. A post-load serialization baseline now suppresses saves until the document actually diverges (explicit `Cmd+S` always writes; an undo back to the baseline after a real edit still writes).
- **Saving no longer reformats the whole document.** The WYSIWYG round-trip used to restyle every line (bullets, `_emphasis_` → `*emphasis*`, punctuation escapes, soft-wrap joins, table padding). Saves now do a block-level merge against the on-disk body: blocks the user didn't edit are written back byte-identical; only genuinely edited blocks take the serializer's output. Guarded by unit tests against the dangerous inverse (a real edit — removing a hard break, converting code to a paragraph — must never be mistaken for a formatting difference and reverted). The serializer is also configured for low-churn `-` bullets and `---` rules, and the old `compactMarkdown` house-style pass is retired.

---

## [0.0.17] - 2026-05-28

### Changed

- **Open-BB-Editor shortcut moved to `Cmd+Shift+B` / `Ctrl+Shift+B`**, and the scope expanded. The previous `Cmd+B` / `Ctrl+B` only fired when a `.md` was selected in the Explorer — too easy to overlook, and stole a key that VS Code users reach for as Bold or Toggle Sidebar. The new chord works in two places: a `.md` selected in the Explorer **and** a `.md` already open in VS Code's text editor (where one keystroke swaps the active editor for the BB Editor in place, matching the title-bar BB icon).
- **Refreshed extension icon.** Replaced the noisy distressed-texture mark with a clean transparent-background BB icon downsized from the master artwork.

### Fixed

- **HTML `<img>` tags now render as actual images in BB Editor.** Previously a Markdown file with raw `<img src="…">` (very common in README hero blocks) showed the literal HTML source where the image should be. The webview now rewrites relative `<img src>` paths to webview URIs on load (and strips them back on save), and a small ProseMirror NodeView renders the `html` node as a real `<img>` when its value is a standalone `<img>` tag — the original source is preserved verbatim on save, so width/alt/etc. round-trip.
- **Layout-only HTML wrappers are no longer surfaced as code.** `<div align="center">`, `</div>`, `<span>`, `<section>` and other structural tags used purely for alignment/grouping in Markdown are now rendered invisibly, and their wrapping paragraph collapses if it contained nothing else — the README's centered hero block no longer leaves visible HTML tags around the logo. As above, the source HTML is untouched on save.

---

## [0.0.16] - 2026-05-27

### Changed

- **Reader design intelligence, expanded.** The Reader's aesthetic prompt now carries a 20-tone catalog (up from 12), and every tone is pinned to a concrete starting point — a system-font pairing, a real-hex palette, and one signature layout move — so renders commit to a direction instead of drifting back to a generic default. Eight reading-friendly tones were added: swiss-international, glassmorphism, claymorphism, bento-grid, e-ink-paper, academia-scholarly, memphis-postmodern, and cyberpunk-terminal.
- **Smarter tone selection.** A new "Choosing a tone" layer maps a document's subject and voice to a tone family (e.g. engineering docs → didactic / industrial / e-ink / terminal; essays → editorial / academia / organic / zine), giving the anti-convergence logic something concrete to vary against across regenerations. Fonts stay system-only (no network), and contrast-risky tones carry explicit AA guardrails. Distilled from the ui-ux-pro-max style library.

### Fixed

- CI publish workflow no longer trips the Node.js 20 deprecation warning — bumped `actions/checkout` and `actions/setup-node` to v5 (Node 24 runtime) and the build's Node from 20.x to 22.x LTS.

---

## [0.0.15] - 2026-05-20

### Added

- **Zen / Read layout toggle** in BB Editor — a small `Z` / `R` button at the top-right flips the editor between Zen mode (the existing 860px centered "page" layout, focused on writing) and Read mode (full-viewport, more comfortable for long reads). State is global and persists across sessions; multiple open BB Editor panels stay in sync.

### Changed

- **Frontmatter Properties panel** now opens collapsed by default. The toggle in the panel header still expands it on demand. Most edits happen in the body — the prior expand-on-load behaviour stole vertical space on every document open.

### Removed

- **"View source" button** in the Frontmatter Properties header. It only appeared when the document had frontmatter, which made discoverability inconsistent for users who had come to rely on it. Open the raw source via VS Code's regular Markdown editor (`Open With…` → Text Editor) when needed.

---

## [0.0.14] - 2026-05-20

### Changed

- **AI Reader prompt restructured into four layers** — technical safety, aesthetic core, per-preset structural function, and user/style-reference overrides. The new aesthetic core carries a 12-tone catalog (editorial-magazine, brutalist, retro-futuristic, didactic-clinical, …), an explicit **Forbidden list** (Inter / Roboto / Arial / purple-on-white gradients / uniform `border-radius:8px` / "Tailwind default" feel), an anti-convergence rule, and a Self-check (no overflow at 1280px/380px, AA contrast in both schemes, SVG > ~8 nodes → HTML+CSS fallback). Adapted from Anthropic's `frontend-design` skill, tuned for the Reader webview's no-network CSP. Output is measurably less generic and has fewer layout glitches.
- **Reader Regenerate** now feeds the previous attempts' Design Briefs back to the model with a "pick a meaningfully different tone AND font AND palette" steer. Queue is capped at the last 3 attempts; resets on a new `<bb-render-*:>` trigger or when the user changes the refinement prompt between attempts. Earlier regenerates were sampling-temperature rerolls with no signal — this gives concrete avoidance.
- **`.bbreader.md` template** gains an **Aesthetic direction** section (Tone / Feel / Reference sites). Example fonts updated away from Inter (now flagged by the Forbidden list).

### Fixed

- **Slash menu nav in BB Editor** — pressing ↓ past the visible viewport no longer jumps the active highlight back near the top. Root cause: `scrollIntoView` on the active item triggers synthetic `mouseenter` events on items sliding under a stationary cursor, which our hover handler then promoted to active. We now gate `mouseenter` on actual mouse motion (`mousemove`), so scroll-induced enters are ignored while real hover still works.

---

## [0.0.13] - 2026-05-18

### Added

- **AI Reader View** — a new BB command family (`<bb-render-blog:>` / `<bb-render-skim:>` / `<bb-render-expl:>` / `<bb-render:custom prompt>`) that has the AI re-interpret the current Markdown as a full HTML "reading artifact" rendered in a side panel. Source `.md` is never modified.
  - Four presets: **Blog View** (polished article with TOC + callouts), **Skim Mode** (TL;DR + collapsibles), **Explainer** (SVG diagrams + teaching annotations), **Custom** (user prompt drives entirely)
  - Streaming HTML preview inside a sandboxed iframe (Blob URL), with phase indicator, spinner→checkmark transition, live token counter, and editable refinement prompt
  - **Export to self-contained `.html`** with images base64-inlined by default (`blogbuddy.reader.inlineAssets` controls this)
  - Source-changed banner (no auto-regen — renders are slow/metered)
  - BB credit footer injected into every render and exported file
  - Cost guard at ~25k input tokens
- **`.bbreader.md` style reference** — drop a `.bbreader.md` at workspace root; auto-loaded into every Reader render as authoritative style guidance for layout, typography, colors, components. Truncated at 10,000 chars
- **`BlogBuddy: Create .bbreader.md Template`** command — scaffolds a 5-section starter (Visual style / Document structure / Components / Example HTML / Things to avoid) at workspace root
- **`BlogBuddy: Show Usage Statistics`** / **`Reset Usage Statistics`** / **`Refresh Pricing Data`** as standalone palette commands (the prior dialog-based stats menu is gone)

### Changed

- **BB Menu removed** — the `Cmd+Shift+B` popup with just Usage Statistics + Help duplicated VS Code's native command palette. All BB features now live in the palette (`Cmd+Shift+P` `BlogBuddy:`). `Cmd+Shift+B` keybinding freed.
- **Show Usage Statistics** opens content directly (no intermediate "Open in Editor" notification step). The empty-state case (`totalRequests === 0`) shows an info toast instead of opening an empty markdown tab
- **Slash menu nav** in BB Editor clamps at the first/last item instead of wrapping (the old modulo wrap felt like a teleport once the menu had 19 items)
- Renamed Chinese docs to ASCII filenames: `help_中文.md` → `help_CN.md`, `README_中文.md` → `README_CN.md`

### Internal

- Frontmatter parser lifted from `WebviewBridge` into shared `src/utils/frontmatter.ts` (covered by regression tests)
- New `src/utils/assetInliner.ts` with regex-based `<img>` rewriting, path-traversal guard, and 10 unit tests
- Third esbuild context for the Reader webview (`media/webview-reader/` → `dist/webview-reader.js`)
- New protocol unions in `src/services/webviewProtocol.ts` for Reader ↔ host messages (kept separate from BB Editor's existing protocol)

---

## [0.0.12] - 2026-04-24

### Added

- **`BlogBuddy: Select Model` command**: fetches `/v1/models` from the configured base URL and opens a picker; choose an existing model or "Enter custom model…" to type one manually. Surfaces auth / network / base-URL errors directly (with Retry / Enter Manually) instead of silently returning an empty list
- **Environment variable fallback** for credentials. Resolution order (first non-empty wins):
  - `apiKey`: `blogbuddy.apiKey` → `$BLOGBUDDY_API_KEY` → `$OPENAI_API_KEY`
  - `baseURL`: `blogbuddy.baseURL` → `$BLOGBUDDY_BASE_URL` → `$OPENAI_BASE_URL` → `https://api.openai.com/v1` (final default, so a fresh install works out of the box with just an API key)
- **`BlogBuddy: Show Config Diagnostics` command**: opens a masked markdown report showing what the extension host actually resolves for each field (settings vs env vs default), useful for debugging the "I set the env var but it doesn't work" case
- **Config source status bar indicator**: a right-side `$(key) BB · cfg|env|default` item (turns yellow `$(warning) BB: no key` if nothing resolves). Hover for a per-field source table; click to open diagnostics. Also links to Select Model and settings

### Changed

- **Configuration simplified**. Removed the following settings (and their handling code):
  - `blogbuddy.smallModel` — all commands now use the single `blogbuddy.model`
  - `blogbuddy.streaming` — streaming is always on
  - `blogbuddy.documentInfoDisplay` — word count in the status bar is always shown for Markdown files; the `Toggle Document Info Display` command and its `Cmd+Shift+D` keybinding are removed
  - `blogbuddy.mermaidSVG` — Mermaid output is always an inline fenced code block; the Kroki-based SVG rendering path is removed (along with `src/services/KrokiService.ts`)
- **Settings UI polish**: `apiKey` / `baseURL` / `model` now use `markdownDescription` documenting the full resolution order; descriptions include inline clickable command links to Show Config Diagnostics and Select Model (since the model field can't be rendered as a native dropdown — the model list is fetched dynamically from the provider)
- **AI client recreation**: the OpenAI client is now rebuilt when `apiKey` or `baseURL` changes at runtime (previously cached the first-seen credentials until restart)

### Removed / Cleaned up

- `BB.act()` / `Processor.process()` non-streaming paths and the `StreamingProcessor` interface — all processors now expose a single streaming `process()`
- `aiService.chat(..., model?)` / `chatStreaming(..., model?)` per-call model override — both now use `blogbuddy.model` from config
- `src/services/KrokiService.ts` and its Mermaid-to-SVG rendering path

---

## [0.0.11] - 2026-04-24

### Added

- **Syntax highlighting in code blocks**: Fenced code blocks in BB Editor now render colored tokens (Prism-based, 20+ languages including ts/js/python/bash/yaml/rust/go/sql/…); palette adapts to VS Code light and dark/high-contrast themes
- **Typed Properties panel** for YAML frontmatter: `title`, `date`, `tags`, `categories`, `author`, `slug`, `draft`, `description` render as typed controls (text / date picker / chip input / toggle / textarea) with an "Add field" dropdown; raw YAML remains available as a collapsible fallback
- **External file conflict detection**: when the file changes on disk while BB Editor has unsaved edits, a banner offers **Reload from disk** or **Keep my version** instead of silently overwriting
- **View Source button** in the Frontmatter header opens the raw `.md` in a side VS Code editor
- **Arrow ligatures**: typing `->` auto-converts to `→`, `=>` to `⇒`; skipped inside code blocks/inline code and during IME composition

### Improved

- **IME composition protection**: auto-save and `Cmd+B Cmd+B` are suppressed during CJK (Chinese/Japanese/Korean) IME composition, so half-composed pinyin/kana no longer leaks into saves or BB command execution
- **Markdown output normalization** on save: bullets normalized to `-`, list items tightened (no blank lines between siblings), common HTML entities (`&amp;`, `&lt;`, `&gt;`, `&#x20;`, …) decoded, whitespace around `**bold**` markers moved outside, 3+ consecutive blank lines collapsed to 2; fenced code block contents are left untouched. Reduces Git diff noise when round-tripping through BB Editor
- **One-press Backspace** at the start of a heading now converts it directly to a paragraph (no longer steps down h2 → h1 → paragraph)
- **Centralized serialization pipeline**: `save` and `auto-save` share a single `getMarkdown → stripBaseUri → compactMarkdown` path for consistent output

---

## [0.0.10] - 2026-02-26

### Added

- **Frontmatter preview and editing panel**: YAML/TOML frontmatter is exposed as a dedicated collapsible editor at the top of BB Editor; changes auto-save alongside body edits

---

## [0.0.9] - 2026-02-26

### Added

- **GFM support**: BB Editor now supports GitHub Flavored Markdown — tables, strikethrough, task lists, and autolinks render correctly
- **Configurable asset directory**: New `blogbuddy.assetDir` setting to specify a relative subdirectory for uploaded images/attachments (e.g. `assets` or `images/uploads`)

### Improved

- **Editor empty state UX**: Editing area now fills the full viewport height — clicking anywhere in the editor focuses the cursor; added placeholder text ("Start writing, or type / for BB commands...")
- **Page-style visual**: Editor content area has subtle side borders with differentiated background, giving a "page" feel
- **Slash menu**: BB commands now appear first in the menu with English labels; fixed a bug where hover and keyboard selection could highlight two items simultaneously
- **URI encoding fix**: Fixed image display issue when `baseUri` contained `+` characters (encoded as `%2B` by Milkdown)

### Fixed

- Fixed `documentInfoDisplay` setting description — was incorrectly referencing cursor position instead of status bar

---

## [0.0.8] - 2026-02-24

### Added

- **BB Editor**: New WYSIWYG Markdown editor powered by Milkdown
  - Rich-text editing with real-time preview (commonmark, history, block plugins)
  - BB slash commands via `/` menu and `Cmd+B Cmd+B` chord shortcut
  - AI streaming block: inline display of AI processing results
  - Image/attachment paste & drag-drop: saves files to document directory, inserts as relative path
  - Frontmatter preservation: YAML (`---`) and TOML (`+++`) metadata is stripped on load and reattached on save
  - Auto-save with debounce and external file change detection
  - Theme sync with VS Code color theme
  - Open from file explorer context menu, active editor, or file picker
- CSP now allows external HTTPS images (e.g. shields.io badges) in BB Editor

---

## [0.0.7] - 2025-09-15

### Added

- Switching files or closing a file while a BB command is running will automatically terminate the command and display a notification

### Improved

- Improved BB command scope detection: automatically determines whether to process current line or entire paragraph based on BB tag location and content
- Changed locked area warning from status bar message to information popup for better visibility
- Improved the display of locked text content

### Fixed

- Fixed TextBlockProcessor selection handling logic bug where all text selections were being blocked when locked areas existed

## [0.0.6] - 2025-09-11

### Fixed

- Fixed an issue where the translation command would occasionally output formatting markers or tags

## [0.0.5] - 2025-09-10

### Added

- Added a word count feature that displays the document's word count in the status bar; toggle it on or off using `cmd+shift+d` (Mac) or `ctrl+shift+d` (Win/Linux)
- The color scheme will follow the editor theme

## [0.0.4] - 2025-09-08

### Added

- bb-tslt translation command now supports text block mode

### Fixed

- bb-tag command generated the wrong location

## [0.0.3] - 2025-09-03

### Added

- Small model setting for improved performance and cost optimization
- All BB commands except agent mode now use the small model by default

### Improved

- Reduced extension package size by optimizing image assets packaging

## [0.0.2] - 2025-09-01

### Fixed

- Editor block lose locking
