# BlogBuddy Development Guidelines for Claude

## Project Identity & Mission
This is a VS Code extension with two parts: BB Editor, a live-preview Markdown editor, and margin notes (旁注) — a sentence the writer leaves beside a block, answered in the background by the agent CLI they already use (Claude Code or Codex). The core philosophy is maintaining user flow without context switching: the document is the main thing, conversations hang off its blocks, and nothing interrupts the writer.

## Core Architecture

### 3-Layer Architecture
```
┌─────────────────┐
│   Commands      │ ← View Layer: VS Code Integration & UI
├─────────────────┤
│   Core          │ ← Business Layer: Features & Logic  
├─────────────────┤
│ Services/Utils  │ ← Foundation Layer: Infrastructure
└─────────────────┘
```

**Layer Responsibilities:**

- **Commands Layer**: Handle VS Code integration, UI interactions, and user events. Never contain business logic.
- **Core Layer**: Implement feature processing, agent prompts, and business rules. Transform requests to responses.
- **Services/Utils Layer**: Provide infrastructure services, external integrations, and utility functions.

### File Organization
```
src/
├── commands/          # View Layer: Platform integration & UI
│   ├── editorCommand.ts   # BB Editor: custom text editor provider, open / open-source commands, HTML
│   └── ...
├── core/             # Business Layer
│   ├── notes.ts             # Margin-note prompt, reply contract, NoteAssistant
│   └── blockDiff.ts         # Pure block diff: rewrite → block operations (shared with the webview)
├── services/         # Foundation Layer: Infrastructure
│   ├── AgentService.ts      # The single door to AI: runs the agent CLI headless and read-only
│   ├── agentProtocol.ts     # CLI arguments and output parsing per agent (pure)
│   ├── NoteStore.ts         # Notes per document, in extension storage
│   ├── WebviewBridge.ts     # One editor's webview ↔ its TextDocument: sync, notes, uploads
│   ├── textSync.ts          # Document sync core (pure): positions, CRLF, versions, echo of own pushes
│   └── webviewProtocol.ts   # Typed message protocol definitions
└── utils/            # Foundation Layer: Utilities

media/webview/         # Webview frontend (browser, bundled separately) — CodeMirror 6
├── index.ts              # Editor setup, host messages, keys, stats
├── sync.ts               # Webview side of document sync (@codemirror/collab client)
├── live-preview.ts       # Markdown shown as styled text; marks back on the caret's line; tables
├── frontmatter.ts        # Frontmatter node, the panel as the document's head, edit guard
├── frontmatter-panel.ts  # Properties panel (fields / raw YAML); builds its own DOM
├── blocks.ts             # Top-level Markdown blocks (the unit of notes and proposals)
├── notes.ts              # Margin notes: positions, decorations, applying proposals, diff highlighting
├── notes-view.ts         # Margin notes: summary line / card, gutters, ask box (engine-agnostic)
├── notes-model.ts        # Margin-note types
├── md-render.ts          # Markdown → DOM for tables, answers and proposed blocks
├── commands.ts / slash.ts / upload.ts / line-numbers.ts / code-languages.ts
├── styles.css            # Layout, frontmatter, notes, notices
└── editor.css            # The editor's typography
```

### Layer Interaction Rules
- **Commands**: Can call Core and Services, handles UI concerns only
- **Core**: Can use Services/Utils, contains business logic and AI prompts
- **Services/Utils**: Pure technical services, no business logic

### BB Editor (Webview) Architecture

BB Editor is a CodeMirror 6 live-preview Markdown editor in a webview, registered as a custom text editor (`blogbuddy.editor`, priority `option`) over VS Code's TextDocument.

**Dual build system** (`esbuild.js`):

- Extension host: Node.js CJS → `dist/extension.js`
- Webview: Browser IIFE → `dist/webview.js` + `dist/webview.css`

**Message flow** (typed in `webviewProtocol.ts`):

```text
Webview (browser)              Extension Host (Node.js)
  index.ts / sync.ts             WebviewBridge.ts ──── TextDocument (the authority)
    │                                │
    │← init (text, version, epoch)─│   on ready (with the notes kept for it), and after the two sides lose track
    │── push (collab updates) ─────→ │ → SyncLog.accept → WorkspaceEdit
    │← updates (numbered) ─────────│ ← onDidChangeTextDocument (anyone's change)
    │← push-result ────────────────│
    │── save ──────────────────────→ │ → workbench.action.files.save
    │                                │
    │── note-ask (scope Markdown) ─→ │ → NoteAssistant.ask() → AgentService
    │← note-progress / done / error│   (the host never edits the document)
    │── notes-save ────────────────→ │ → NoteStore (extension storage)
    │                                │
    │── selection (offsets) ───────→ │ → EditorStatus → status bar (counts come from the TextDocument)
    │── file-upload (base64) ──────→ │ → fs.writeFile() → relative path
    │← file-uploaded ──────────────│
```

**Key patterns**:

- **Document sync**: the editor's text is exactly the TextDocument's text (line breaks as `\n`; positions travel as line + character, so CRLF files stay CRLF). The webview pushes @codemirror/collab updates against the version it has seen; the host writes them with a WorkspaceEdit (VS Code refuses an edit to a document that moved on) and broadcasts every document change as numbered updates, recognizing its own write so the webview can confirm it. Incoming changes are narrowed to what differs. Never write files from the webview, and never bypass the TextDocument on the host. BB never saves on the writer's behalf — saving is `files.autoSave` or ⌘S. Switching between BB Editor and the text editor uses VS Code's in-place reopen (`reopenActiveEditorWith`), never close-one-open-other, which can drop unsaved changes
- **Frontmatter**: part of the document, parsed as one `Frontmatter` node; shown as the properties panel (a block widget) and edited through it — fields, or the raw text in a small nested CodeMirror editor (YAML / TOML highlighting). What counts as frontmatter and the Lezer config live in `src/utils/frontmatter.ts`, shared with the host; the config reads the parser's non-public `input` for lookahead, and `src/test/utils/frontmatter.test.ts` fails if an upgrade takes it away. A transaction filter keeps ordinary typing and the caret out of it; unfiltered transactions (undo, remote updates, the panel's own edits) pass
- **Theme**: CSS follows the classes VS Code puts on the webview body (`vscode-light`, `vscode-dark`, …); no theme messages
- **Block widgets** (panel, note cards, proposed blocks, tables) must not carry vertical margins — CodeMirror measures border boxes, and a margin shifts every click below
- **Image/file upload**: Files sent as base64 to host, saved via `handleFileUpload()`, inserted as Markdown with the path relative to the document; images resolve against the document folder only when displayed. Save directory resolved by `resolveAssetDir()` — defaults to document directory, configurable via `blogbuddy.assetDir` (relative paths only, must stay within document directory)
- **Margin notes**: the block is the unit. A note covers whole top-level Markdown blocks (a block, a heading's section, or a selected range) and is tracked by the start positions of its first and last block. Everything a note shows is decorations — the document changes only when the writer accepts a change, as one ordinary undoable transaction
- **Proposals**: the agent returns a rewrite of the note's blocks between `<bb-replace>` tags; `buildSequence()` turns it into block operations (keep / mod / add / del / move) and `locate()` finds where each still applies by block text (a block's text is its Markdown), so the writer can keep editing around a pending proposal
- **UI placement**: information on the left (rail, change signs, summary line under the block), actions on the right (per-block accept / reject, and the note's own buttons at the right end of its rows)
- **Signs, not words**: note UI uses glyphs (`※ ⌃ ∎ ± ✓ × ↻ ↺`, scope as Markdown's own markers, progress as `⌕ ↗ $ ✎ …`); words appear only in tooltips and in failure messages
- **Interface text**: English in the code, translated per VS Code's display language. Host files that use the VS Code API call `vscode.l10n.t`; modules without it (core, agent services) and the webview call `l10n.t` from `@vscode/l10n` (the host configures it in `activate`; the webview reads the bundle the host embeds in its HTML, `media/webview/l10n.ts`). Chinese goes in `l10n/bundle.l10n.zh-cn.json`, manifest text in `package.nls(.zh-cn).json`. Pass arguments as `{0}`, never a template string; look strings up when used, not at module load. `src/test/l10n.test.ts` fails on a missing or unused translation and on Chinese written into interface code. The agent prompt stays as it is
- **Markdown**: `@codemirror/lang-markdown` (Lezer, CommonMark + GFM) plus the `Frontmatter` extension; the same parser splits an agent's rewrite into blocks and renders Markdown to DOM (`md-render.ts`, no `innerHTML`)

## Development Principles

### Design Philosophy
- **Simplicity First**: Choose the simplest solution that works
- **Single Responsibility**: Each module has one clear purpose
- **Interface Consistency**: Use common patterns across similar components
- **Dependency Direction**: Upper layers depend on lower layers only

### Code Standards
- Always define interfaces before implementation
- Use TypeScript strictly - avoid `any`, prefer `unknown` with type checking
- Centralized error handling with user-friendly messages
- All AI calls go through a single service (`AgentService`), which only ever runs the agent read-only
- Configuration should be reactive and type-safe

### Development Workflow

**For Complex Tasks:**
1. **Analyze**: Understand requirements and identify affected layers
2. **Design**: Plan the implementation approach and data flow
3. **Confirm**: Discuss the approach before proceeding
4. **Implement**: Follow the agreed plan in phases
5. **Test**: Verify with different configurations and edge cases

**For Simple Tasks:**
- Brief analysis is acceptable
- Can proceed directly to implementation
- Still follow existing patterns and principles

## Best Practices

### AI Integration
- Support multiple agent CLIs through one interface (`agentProtocol.ts` holds what differs)
- Include appropriate context in prompts
- The agent must never modify the workspace; changes come back as proposals for the writer to accept
- Surface agent failures on the note that asked, with a way to retry

### Extension Development
- Register all disposables properly
- Use progress indicators for long operations
- Handle document changes safely
- Maintain consistency with platform conventions

### Error Handling
- Never crash the extension - graceful degradation
- Provide actionable error messages
- Use consistent error handling patterns
- Validate inputs before processing

## File Creation Guidelines

### 🚫 **Do NOT Create Unnecessary Files**

**Prohibited:**
- Example/demo files (`xxx.example.ts`, `example.ts`)
- Test documentation files (`xxx.test.md`, `test-guide.md`)
- Documentation files (unless explicitly requested)

**Why:**
- Code bloat and maintenance burden
- Confusion about actual implementation
- Repository pollution

**Acceptable:**
- ✅ Core implementation files (actual features)
- ✅ Configuration files when necessary
- ✅ Types and interfaces that are used
- ✅ Documentation when explicitly requested

**Before Creating Any File:**
1. Is this absolutely necessary for functionality?
2. Can this be included in existing files?
3. Did the user explicitly request this?

Remember: The application's strength lies in seamless integration and consistent user experience. Every change should enhance the core workflow while maintaining architectural integrity.