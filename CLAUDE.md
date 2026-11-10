# BlogBuddy Development Guidelines for Claude

## Project Identity & Mission
This is a VS Code extension with two parts: BB Editor, a WYSIWYG Markdown editor, and margin notes (旁注) — a sentence the writer leaves beside a block, answered in the background by the agent CLI they already use (Claude Code or Codex). The core philosophy is maintaining user flow without context switching: the document is the main thing, conversations hang off its blocks, and nothing interrupts the writer.

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
│   ├── editorCommand.ts   # BB Editor webview panel lifecycle & HTML
│   └── ...
├── core/             # Business Layer
│   ├── notes.ts             # Margin-note prompt, reply contract, NoteAssistant
│   └── blockDiff.ts         # Pure block diff: rewrite → block operations (shared with the webview)
├── services/         # Foundation Layer: Infrastructure
│   ├── AgentService.ts      # The single door to AI: runs the agent CLI headless and read-only
│   ├── agentProtocol.ts     # CLI arguments and output parsing per agent (pure)
│   ├── NoteStore.ts         # Notes per document, in extension storage
│   ├── WebviewBridge.ts     # Webview ↔ Extension Host message routing
│   └── webviewProtocol.ts   # Typed message protocol definitions
└── utils/            # Foundation Layer: Utilities

media/webview/         # Webview frontend (browser, bundled separately)
├── index.ts              # Milkdown editor init, message handling, URI conversion
├── notes-plugin.ts       # Margin notes: positions, decorations, applying proposals
├── notes-view.ts         # Margin notes: summary line / card, gutters, ask box
├── notes-model.ts        # Margin-note types shared by the two above
├── bb-slash-plugin.ts    # Slash menu (block types)
└── styles.css            # Editor styles
```

### Layer Interaction Rules
- **Commands**: Can call Core and Services, handles UI concerns only
- **Core**: Can use Services/Utils, contains business logic and AI prompts
- **Services/Utils**: Pure technical services, no business logic

### BB Editor (Webview) Architecture

The BB Editor is a WYSIWYG Markdown editor running inside a VS Code webview panel.

**Dual build system** (`esbuild.js`):

- Extension host: Node.js CJS → `dist/extension.js`
- Webview: Browser IIFE → `dist/webview.js` + `dist/webview.css`

**Message flow** (typed in `webviewProtocol.ts`):

```text
Webview (browser)              Extension Host (Node.js)
  index.ts                       WebviewBridge.ts
    │                                │
    │── note-ask (scope Markdown) ─→ │ → NoteAssistant.ask() → AgentService
    │← note-progress / done / error│   (the host never edits the document)
    │── notes-save ────────────────→ │ → NoteStore (extension storage)
    │← notes-load ─────────────────│
    │                                │
    │── file-upload (base64) ──────→ │ → fs.writeFile() → webviewUri
    │← file-uploaded ──────────────│
    │                                │
    │── save / auto-save ──────────→ │ → reattach frontmatter → fs.writeFile()
    │← saved ──────────────────────│
    │                                │
    │← load (content + baseUri) ───│   (frontmatter stripped)
```

**Key patterns**:

- **Frontmatter handling**: `extractFrontmatter()` strips YAML/TOML on load, `storedFrontmatter` is reattached on save/auto-save
- **Image/file upload**: Files sent as base64 to host, saved to disk via `handleFileUpload()`, webview URI returned; `preprocessMarkdown`/`postprocessMarkdown` convert between relative paths and webview URIs (handles `%2B` encoding). Save directory resolved by `resolveAssetDir()` — defaults to document directory, configurable via `blogbuddy.assetDir` (relative paths only, must stay within document directory)
- **Margin notes**: the block is the unit. A note covers whole top-level blocks (a block, a heading's section, or a selected range) and is tracked by the start positions of its first and last block. Everything a note shows is decorations — the document changes only when the writer accepts a change, as one ordinary undoable transaction
- **Proposals**: the agent returns a rewrite of the note's blocks between `<bb-replace>` tags; `buildSequence()` turns it into block operations (keep / mod / add / del / move) and `locate()` finds where each still applies by block text, so the writer can keep editing around a pending proposal
- **UI placement**: information on the left (rail, change signs, summary line under the block), actions on the right (per-block accept / reject, and the note's own buttons at the right end of its rows)
- **Signs, not words**: note UI uses glyphs (`※ ⌃ ∎ ± ✓ × ↻ ↺`, scope as Markdown's own markers, progress as `⌕ ↗ $ ✎ …`); words appear only in tooltips and in failure messages
- **Milkdown presets**: Uses both `commonmark` and `gfm` presets — GFM adds tables, strikethrough, task lists, autolinks

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