import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigService } from './ConfigService';
import { changesFromEdits, editsFromChanges, SyncLog, textOf, type RangeEdit } from './textSync';
import type {
    HostMessage,
    WebviewFileUploadMessage,
    WebviewMessage,
    WebviewNoteAskMessage,
    WebviewPushMessage,
} from './webviewProtocol';

/** What the agent came back with for one margin note. */
export interface NoteAnswerMessage {
    reply: string;
    replacement?: string;
    agent: string;
    seconds: number;
}

/** Answers a margin note. Injected by the command layer so this bridge stays a message router. */
export type NoteAsker = (
    ask: WebviewNoteAskMessage,
    onStep: (step: string) => void,
    signal: AbortSignal,
) => Promise<NoteAnswerMessage>;

export interface BridgeOptions {
    askNote?: NoteAsker;
    loadNotes?: (filePath: string) => unknown[];
    saveNotes?: (filePath: string, notes: unknown[]) => void;
    onToggleLayoutMode?: () => void;
    /** The text the writer has selected, for the status bar. */
    onSelection?: (text: string) => void;
}

const MAX_STORED_NOTES = 500;

/**
 * Connects one BB Editor webview to the TextDocument it edits.
 *
 * The TextDocument is the single source of truth: VS Code owns saving (by the
 * writer's files.autoSave setting, or ⌘S), dirty state, hot exit and reloading
 * from disk. This bridge never saves on its own; it keeps the webview's copy
 * in step with the document (see textSync) and routes the editor's other
 * requests — margin notes, uploads, the selection.
 */
export class WebviewBridge implements vscode.Disposable {
    private readonly sync: SyncLog;
    /** Bumped when the two sides start over; pushes from an earlier session are turned away. */
    private epoch = 0;
    private ready = false;
    private noteRuns = new Map<string, AbortController>();
    private disposables: vscode.Disposable[] = [];
    private disposed = false;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly document: vscode.TextDocument,
        private readonly options: BridgeOptions = {},
    ) {
        this.sync = new SyncLog(textOf(document.getText()));
        this.disposables.push(
            webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg).catch(error => {
                this.post({ type: 'notice', message: error instanceof Error ? error.message : '操作失败，请重试。' });
            })),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document === this.document) { this.onDocumentChange(event.contentChanges); }
            }),
        );
    }

    get filePath(): string | undefined {
        return this.document.uri.scheme === 'file' ? this.document.uri.fsPath : undefined;
    }

    post(message: HostMessage): void {
        if (this.disposed) { return; }
        void this.webview.postMessage(message);
    }

    // ---- Keeping the webview in step with the document ----

    /** Every change to the document, whoever made it, goes to the webview as numbered updates. */
    private onDocumentChange(contentChanges: readonly vscode.TextDocumentContentChangeEvent[]): void {
        if (!contentChanges.length) { return; }
        const changes = changesFromEdits(this.sync.doc, contentChanges.map(change => ({
            startLine: change.range.start.line, startCharacter: change.range.start.character,
            endLine: change.range.end.line, endCharacter: change.range.end.character,
            text: change.text,
        })));
        const { version, updates } = this.sync.record(changes);
        if (this.ready) { this.post({ type: 'updates', epoch: this.epoch, version, updates }); }
    }

    /**
     * The document as it is now: on ready, and whenever the two sides have lost
     * track. The first one also brings back the notes kept beside the document.
     */
    private sendInit(): void {
        const first = !this.ready;
        this.epoch++;
        this.sync.reset(textOf(this.document.getText()));
        this.ready = true;
        this.post({
            type: 'init', epoch: this.epoch, version: this.sync.version, text: this.sync.doc.toString(), baseUri: this.baseUri(),
            notes: first ? (this.filePath && this.options.loadNotes?.(this.filePath)) || [] : undefined,
        });
    }

    /** Write the webview's changes into the document. The document's own change event confirms them. */
    private async handlePush(msg: WebviewPushMessage): Promise<void> {
        const epoch = this.epoch;
        const reply = (ok: boolean): void => { if (epoch === this.epoch) { this.post({ type: 'push-result', epoch, ok }); } };
        const before = this.sync.doc;
        const changes = msg.epoch === epoch ? this.sync.accept(msg.version, msg.updates) : undefined;
        if (!changes) { reply(false); return; }

        const edit = new vscode.WorkspaceEdit();
        const eol = this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        for (const change of editsFromChanges(before, changes, eol)) {
            edit.replace(this.document.uri, rangeOf(change), change.text);
        }
        let ok = false;
        try { ok = await vscode.workspace.applyEdit(edit); } catch { ok = false; }

        if (!ok) {
            // The document moved on before the edit landed (VS Code checks its version):
            // the webview rebases over the updates it is about to receive and pushes again.
            this.sync.abandon();
            reply(false);
            return;
        }
        if (this.sync.writing) {
            // The change event normally arrives before applyEdit resolves; give it a moment.
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (this.sync.writing) {
            // Our edit never showed up as itself: start the webview over from the document.
            this.sync.abandon();
            if (!this.disposed) { this.sendInit(); }
            return;
        }
        reply(true);
    }

    private baseUri(): string | undefined {
        const filePath = this.filePath;
        return filePath ? this.webview.asWebviewUri(vscode.Uri.file(path.dirname(filePath))).toString() : undefined;
    }

    // ---- Messages ----

    private async handleMessage(msg: WebviewMessage): Promise<void> {
        if (this.disposed || !msg || typeof msg !== 'object') { return; }
        switch (msg.type) {
            case 'ready':
                this.sendInit();
                break;
            case 'push':
                await this.handlePush(msg);
                break;
            case 'resync':
                this.sendInit();
                break;
            case 'save':
                // ⌘S: saves the active editor — this one — and asks for a name when it is untitled.
                await vscode.commands.executeCommand('workbench.action.files.save');
                break;
            case 'note-ask':
                await this.handleNoteAsk(msg);
                break;
            case 'note-cancel':
                this.noteRuns.get(msg.requestId)?.abort();
                break;
            case 'notes-save':
                if (this.filePath && Array.isArray(msg.notes) && msg.notes.length <= MAX_STORED_NOTES) {
                    this.options.saveNotes?.(this.filePath, msg.notes);
                }
                break;
            case 'file-upload':
                await this.handleFileUpload(msg);
                break;
            case 'toggle-layout-mode':
                this.options.onToggleLayoutMode?.();
                break;
            case 'selection':
                if (Number.isSafeInteger(msg.from) && Number.isSafeInteger(msg.to)) {
                    // Offsets in the webview's text; the mirror may trail it by a keystroke, which a count can bear.
                    const clamp = (pos: number): number => Math.min(Math.max(pos, 0), this.sync.doc.length);
                    this.options.onSelection?.(this.sync.doc.sliceString(clamp(Math.min(msg.from, msg.to)), clamp(Math.max(msg.from, msg.to))));
                }
                break;
        }
    }

    /**
     * Hand a margin note to the agent. The document itself is never touched
     * here: the answer (and any proposed rewrite) goes back to the webview,
     * where the writer decides what to accept.
     */
    private async handleNoteAsk(msg: WebviewNoteAskMessage): Promise<void> {
        const id = msg.requestId;
        if (typeof id !== 'string' || typeof msg.question !== 'string' || typeof msg.scopeMarkdown !== 'string'
            || !Array.isArray(msg.history) || !this.options.askNote) {
            this.post({ type: 'note-error', requestId: id, message: '这条旁注没有发出去，请重试。' });
            return;
        }
        const run = new AbortController();
        this.noteRuns.set(id, run);
        try {
            // Nothing is saved for the agent: the blocks in question travel with the note,
            // and the prompt says when the file on disk is behind the editor.
            const answer = await this.options.askNote(msg, step => {
                if (!run.signal.aborted) { this.post({ type: 'note-progress', requestId: id, step }); }
            }, run.signal);
            if (!run.signal.aborted) { this.post({ type: 'note-done', requestId: id, ...answer }); }
        } catch (error) {
            if (!run.signal.aborted) {
                this.post({ type: 'note-error', requestId: id, message: error instanceof Error ? error.message : '没有得到回答，请重试。' });
            }
        } finally {
            this.noteRuns.delete(id);
        }
    }

    private async resolveAssetDir(docDir: string): Promise<string> {
        const assetDir = ConfigService.getInstance().getAllConfig().assetDir?.trim();
        if (!assetDir) { return docDir; }

        // Only allow relative paths (resolved from document directory)
        if (path.isAbsolute(assetDir)) {
            vscode.window.showWarningMessage('assetDir must be a relative path. Saving to document directory.');
            return docDir;
        }
        const resolved = path.resolve(docDir, assetDir);
        // Ensure resolved path is within docDir (prevent ../ escaping)
        const relative = path.relative(docDir, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            vscode.window.showWarningMessage('assetDir must be within the document directory. Saving to document directory.');
            return docDir;
        }
        await fs.mkdir(resolved, { recursive: true });
        return resolved;
    }

    private async handleFileUpload(msg: WebviewFileUploadMessage): Promise<void> {
        const filePath = this.filePath;
        if (!filePath) {
            this.post({ type: 'file-upload-error', uploadId: msg.uploadId, message: '先保存文档，再插入文件。' });
            return;
        }
        try {
            const docDir = path.dirname(filePath);
            const dir = await this.resolveAssetDir(docDir);
            const finalName = await getUniqueFileName(dir, path.basename(msg.fileName));
            const fullPath = path.join(dir, finalName);
            await fs.writeFile(fullPath, Buffer.from(msg.dataBase64, 'base64'));
            this.post({
                type: 'file-uploaded',
                uploadId: msg.uploadId,
                relativePath: path.relative(docDir, fullPath),
                isImage: msg.mimeType.startsWith('image/'),
                fileName: finalName,
            });
        } catch (error) {
            this.post({ type: 'file-upload-error', uploadId: msg.uploadId, message: error instanceof Error ? error.message : 'Upload failed' });
        }
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        for (const run of this.noteRuns.values()) { run.abort(); }
        this.noteRuns.clear();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}

function rangeOf(edit: RangeEdit): vscode.Range {
    return new vscode.Range(edit.startLine, edit.startCharacter, edit.endLine, edit.endCharacter);
}

async function getUniqueFileName(dir: string, name: string): Promise<string> {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let candidate = name;
    let counter = 1;
    while (true) {
        try {
            await fs.access(path.join(dir, candidate));
            candidate = `${base}-${counter}${ext}`;
            counter++;
        } catch {
            return candidate;
        }
    }
}
