import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { WebviewBridge } from '../services/WebviewBridge';
import { NoteAssistant } from '../core/notes';
import { ConfigService } from '../services/ConfigService';
import { NoteStore } from '../services/NoteStore';
import { editorStatus } from '../services/EditorStatus';
import type { LayoutMode } from '../services/webviewProtocol';

const VIEW_TYPE = 'blogbuddy.editor';

export function registerEditorCommand(context: vscode.ExtensionContext) {
    const provider = new BBEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        }),
        vscode.commands.registerCommand('blogbuddy.openEditor', (uri?: vscode.Uri) => openEditor(uri)),
        // Reverse of openEditor: swap the focused BB Editor back to a plain text
        // editor in the same column. Wired to the title-bar icon and ⌘⇧B.
        vscode.commands.registerCommand('blogbuddy.openSource', () => provider.openSourceForActive()),
    );
}

/**
 * Swap the active editor for another editor of the same document, in place —
 * VS Code's own "Reopen Editor With". Unsaved changes stay in the document;
 * nothing is saved and nothing asks. Returns false when the command is not
 * available (it is not part of the documented API).
 */
async function reopenActiveWith(editorId: string): Promise<boolean> {
    try {
        await vscode.commands.executeCommand('reopenActiveEditorWith', editorId);
        return true;
    } catch {
        return false;
    }
}

/** Open a Markdown document in BB Editor, in place of the text editor showing it. */
async function openEditor(uri?: vscode.Uri): Promise<void> {
    // Keybindings don't pass the selected file URI, so try fallbacks
    if (!uri) {
        const active = vscode.window.activeTextEditor?.document;
        if (active && (active.languageId === 'markdown' || active.uri.fsPath.endsWith('.md'))) {
            uri = active.uri;
        } else {
            const picked = await vscode.window.showOpenDialog({ filters: { Markdown: ['md'] }, canSelectMany: false });
            if (!picked?.length) { return; }
            uri = picked[0];
        }
    }

    // Shown in a text editor already: bring that one to the front and replace it.
    const uriStr = uri.toString();
    const textTab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .find(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr);
    if (textTab) {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { viewColumn: textTab.group.viewColumn, preview: false });
        if (await reopenActiveWith(VIEW_TYPE)) { return; }
    }
    // Not open, or the in-place swap is unavailable: open BB Editor beside whatever is there.
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, textTab?.group.viewColumn ?? vscode.ViewColumn.Active);
}

interface OpenEditor {
    panel: vscode.WebviewPanel;
    bridge: WebviewBridge;
    document: vscode.TextDocument;
}

class BBEditorProvider implements vscode.CustomTextEditorProvider {
    // Layout mode (Zen / Editor) is a global UI preference — every open BB
    // Editor shows the same mode. Stored as a boolean (true = Editor) under the
    // key used before the rename, so existing choices carry over.
    private static readonly EDITOR_MODE_KEY = 'blogbuddy.editorWideMode';

    private readonly editors = new Set<OpenEditor>();
    /** The most recently focused BB Editor — the target of blogbuddy.openSource. */
    private active: OpenEditor | undefined;
    private readonly noteStore: NoteStore;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.noteStore = new NoteStore(context.globalState);
    }

    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        const docFolder = document.uri.scheme === 'file' ? vscode.Uri.file(path.dirname(document.uri.fsPath)) : undefined;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
        panel.webview.options = {
            enableScripts: true,
            // Images may sit beside the document or anywhere in its workspace.
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                ...(docFolder ? [docFolder] : []),
                ...(workspaceFolder ? [workspaceFolder] : []),
            ],
        };
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon.png');

        const statusId = crypto.randomUUID();
        const bridge: WebviewBridge = new WebviewBridge(panel.webview, document, {
            askNote: (ask, onStep, signal) => {
                const docPath = bridge.filePath;
                const folder = docPath && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(docPath))?.uri.fsPath;
                return NoteAssistant.ask({
                    question: ask.question, scopeKind: ask.scopeKind, scopeMarkdown: ask.scopeMarkdown,
                    quote: ask.quote, history: ask.history, filePath: docPath, unsavedChanges: document.isDirty,
                    cwd: folder || (docPath ? path.dirname(docPath) : os.homedir()),
                }, ConfigService.getInstance().getAllConfig().agent, onStep, signal);
            },
            loadNotes: file => this.noteStore.load(file),
            saveNotes: (file, notes) => this.noteStore.save(file, notes),
            onToggleLayoutMode: () => void this.toggleLayoutMode(),
            onSelection: text => editorStatus.select(statusId, text),
        });
        const editor: OpenEditor = { panel, bridge, document };
        this.editors.add(editor);
        if (panel.active) { this.active = editor; }
        editorStatus.open(statusId, document);
        editorStatus.activate(statusId, panel.active);

        const disposables: vscode.Disposable[] = [
            panel.onDidChangeViewState(event => {
                if (event.webviewPanel.active) { this.active = editor; }
                editorStatus.activate(statusId, event.webviewPanel.active);
            }),
        ];
        panel.onDidDispose(() => {
            this.editors.delete(editor);
            if (this.active === editor) { this.active = undefined; }
            editorStatus.remove(statusId);
            bridge.dispose();
            disposables.forEach(d => d.dispose());
        });

        panel.webview.html = this.html(panel.webview);
    }

    /** Swap the focused BB Editor for a text editor on the same document, in place. */
    async openSourceForActive(): Promise<void> {
        const editor = this.active;
        if (!editor) { return; }
        if (!editor.panel.active) { editor.panel.reveal(editor.panel.viewColumn); }
        if (await reopenActiveWith('default')) { return; }
        // Without the in-place swap, open the text editor and leave BB Editor open:
        // closing an editor of a document with unsaved changes could lose them.
        await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, 'default', editor.panel.viewColumn);
    }

    private layoutMode(): LayoutMode {
        // Editor Mode is the default; Zen is opt-in.
        return this.context.globalState.get<boolean>(BBEditorProvider.EDITOR_MODE_KEY, true) ? 'editor' : 'zen';
    }

    /** Flip between Zen and Editor mode, persist it, and show it in every open BB Editor. */
    private async toggleLayoutMode(): Promise<void> {
        const next: LayoutMode = this.layoutMode() === 'zen' ? 'editor' : 'zen';
        await this.context.globalState.update(BBEditorProvider.EDITOR_MODE_KEY, next === 'editor');
        for (const editor of this.editors) { editor.bridge.post({ type: 'set-layout-mode', mode: next }); }
    }

    private html(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
        const nonce = getNonce();
        // The webview reads its translations from this inert JSON before drawing anything.
        const strings = JSON.stringify(vscode.l10n.bundle ?? {}).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   font-src ${webview.cspSource};
                   img-src ${webview.cspSource} data: https:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>BB Editor</title>
</head>
<body class="bb-mode-${this.layoutMode()}">
    <button id="mode-toggle" class="bb-mode-toggle" type="button" aria-label="${attribute(vscode.l10n.t('Switch between Zen Mode and Editor Mode'))}">
        <span class="bb-mode-toggle__label bb-mode-toggle__label-zen">Z</span>
        <span class="bb-mode-toggle__label bb-mode-toggle__label-editor">E</span>
    </button>
    <div id="editor-layout"><div id="editor"></div></div>
    <div id="status" class="bb-notice" role="status" aria-live="polite" hidden></div>
    <script id="bb-l10n" type="application/json">${strings}</script>
    <script id="editor-script" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

/** Text safe inside a double-quoted HTML attribute. */
function attribute(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
