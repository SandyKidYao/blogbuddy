import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { watch, FSWatcher } from 'fs';
import { ConfigService } from './ConfigService';
import { extractFrontmatter } from '../utils/frontmatter';
import { preserveUnchangedBlocks } from '../utils/preserveUnchanged';
import { EditorDocumentStore } from './EditorDocumentStore';
import {
    WebviewMessage,
    HostMessage,
    WebviewNoteAskMessage,
    WebviewSaveMessage,
    WebviewFileUploadMessage,
    WebviewConflictResolveMessage,
    WebviewAutoSaveMessage,
    EditorDocumentStats,
    HostLoadMessage,
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

const MAX_STORED_NOTES = 500;

export class WebviewBridge implements vscode.Disposable {
    private noteRuns = new Map<string, AbortController>();
    private disposables: vscode.Disposable[] = [];
    private filePath?: string;
    private onDirtyChange?: (isDirty: boolean) => void;
    private onReady?: () => void;
    private readonly store: EditorDocumentStore;
    private lastBodyContent = '';
    private nativeWatcher?: FSWatcher;
    private externalTimer?: ReturnType<typeof setTimeout>;
    private externalPoll?: ReturnType<typeof setInterval>;
    private refreshDocument?: () => Promise<void>;
    private storedFrontmatter = '';
    private isDirty = false;
    private editVersion = 0;
    private pendingConflict?: { content: string; id: number };
    private conflictId = 0;
    private reloadId = 0;
    private pendingReload?: { id: number; content: string; revision: number; nextRevision: number; editVersion: number };
    private disposed = false;
    private latestDraft?: WebviewAutoSaveMessage;
    private flushWaiters = new Map<string, (success: boolean) => void>();
    private frozenFlushes = new Set<string>();

    private askNote?: NoteAsker;
    private loadNotes?: (filePath: string) => unknown[];
    private saveNotes?: (filePath: string, notes: unknown[]) => void;
    private onToggleLayoutMode?: () => void;
    private onStatsChange?: (stats: EditorDocumentStats) => void;
    private onRecoverDraft?: (content: string) => void;

    constructor(
        private panel: vscode.WebviewPanel,
        private webview: vscode.Webview,
        options?: {
            filePath?: string;
            onDirtyChange?: (isDirty: boolean) => void;
            onReady?: () => void;
            askNote?: NoteAsker;
            loadNotes?: (filePath: string) => unknown[];
            saveNotes?: (filePath: string, notes: unknown[]) => void;
            onToggleLayoutMode?: () => void;
            onStatsChange?: (stats: EditorDocumentStats) => void;
            onRecoverDraft?: (content: string) => void;
        }
    ) {
        this.filePath = options?.filePath;
        this.store = new EditorDocumentStore(this.filePath || '');
        this.onDirtyChange = options?.onDirtyChange;
        this.onReady = options?.onReady;
        this.askNote = options?.askNote;
        this.loadNotes = options?.loadNotes;
        this.saveNotes = options?.saveNotes;
        this.onToggleLayoutMode = options?.onToggleLayoutMode;
        this.onStatsChange = options?.onStatsChange;
        this.onRecoverDraft = options?.onRecoverDraft;

        this.disposables.push(
            this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg).catch(error => {
                this.setDirty(true);
                this.post({ type: 'saved', success: false, revision: this.store.snapshot.revision, editVersion: this.editVersion,
                    message: error instanceof Error ? error.message : '操作失败，请重试。' });
                if ('flushId' in msg) { this.resolveFlush(msg.flushId, false); }
                this.resumeEdits();
            }))
        );

        this.watchFile();
    }

    setFilePath(filePath: string): void {
        this.filePath = filePath;
        this.store.setPath(filePath);
        this.watchFile();
    }

    get currentFilePath(): string | undefined {
        return this.filePath;
    }

    refreshFromDisk(): void { void this.refreshDocument?.(); }

    /**
     * Ask the webview to flush its (debounced) pending edits to disk and
     * resolve once the write completes. Always requests a flush rather than
     * gating on the dirty flag — the flag can lag the 500ms auto-save
     * debounce. A timeout or failed save keeps the editor available for recovery.
     */
    flushEdits(freeze = false): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
                this.resolveFlush(id, false);
            }, 5000);
            this.flushWaiters.set(id, (success) => {
                clearTimeout(timer);
                resolve(success);
            });
            if (freeze) { this.frozenFlushes.add(id); }
            this.post({ type: 'request-save', flushId: id, freeze });
        });
    }

    private resolveFlush(id: string | undefined, success: boolean): void {
        if (!id) { return; }
        this.flushWaiters.get(id)?.(success);
        this.flushWaiters.delete(id);
        if (this.frozenFlushes.delete(id) && !success) { this.resumeEdits(id); }
    }

    resumeEdits(flushId?: string): void { this.post({ type: 'edit-unlock', flushId }); }

    post(message: HostMessage): void {
        if (this.disposed) { return; }
        this.panel.webview.postMessage(message);
    }

    sendLoad(content: string, filePath?: string): void {
        this.pendingReload = undefined;
        this.post(this.adoptContent(content, filePath));
        // A freshly opened document brings back the notes left beside it.
        this.post({ type: 'notes-load', notes: (this.filePath && this.loadNotes?.(this.filePath)) || [] });
    }

    private adoptContent(content: string, filePath?: string): HostLoadMessage {
        const { revision } = this.store.accept(content);
        const { frontmatter, body } = extractFrontmatter(content);
        this.storedFrontmatter = frontmatter;
        this.lastBodyContent = body;
        this.pendingConflict = undefined;
        this.latestDraft = undefined;
        this.editVersion = 0;
        this.setDirty(false);
        return { type: 'load', content: body, frontmatter, filePath, baseUri: this.getBaseUri(), revision };
    }

    private proposeReload(content: string): void {
        if (this.pendingReload) { return; }
        const revision = this.store.snapshot.revision;
        const id = ++this.reloadId;
        this.pendingReload = { id, content, revision, nextRevision: revision + 1, editVersion: this.editVersion };
        const { frontmatter, body } = extractFrontmatter(content);
        this.post({ type: 'load', content: body, frontmatter, filePath: this.filePath, baseUri: this.getBaseUri(),
            revision: revision + 1, previousRevision: revision, expectedEditVersion: this.editVersion, reloadId: id });
    }

    private getBaseUri(): string | undefined {
        if (!this.filePath) { return undefined; }
        return this.webview.asWebviewUri(
            vscode.Uri.file(path.dirname(this.filePath))
        ).toString();
    }

    private async handleMessage(msg: WebviewMessage): Promise<void> {
        if (this.disposed || !msg || typeof msg !== 'object') { return; }
        switch (msg.type) {
            case 'ready':
                this.onReady?.();
                break;
            case 'note-ask':
                await this.handleNoteAsk(msg);
                break;
            case 'note-cancel':
                this.noteRuns.get(msg.requestId)?.abort();
                break;
            case 'notes-save':
                if (this.filePath && Array.isArray(msg.notes) && msg.notes.length <= MAX_STORED_NOTES) {
                    this.saveNotes?.(this.filePath, msg.notes);
                }
                break;
            case 'save':
                await this.handleSave(msg);
                break;
            case 'open-file':
                await this.handleOpenFile();
                break;
            case 'new-file':
                this.handleNewFile();
                break;
            case 'auto-save':
                await this.persist(msg);
                break;
            case 'file-upload':
                await this.handleFileUpload(msg);
                break;
            case 'dirty':
                if (msg.revision === this.store.snapshot.revision && msg.editVersion >= this.editVersion) {
                    this.editVersion = msg.editVersion;
                    this.setDirty(msg.isDirty);
                }
                break;
            case 'document-change':
                if (msg.revision === this.store.snapshot.revision && msg.editVersion >= this.editVersion
                    && typeof msg.content === 'string' && typeof msg.frontmatter === 'string') {
                    this.editVersion = msg.editVersion;
                    this.latestDraft = { ...msg, type: 'auto-save' };
                    this.setDirty(true);
                }
                break;
            case 'conflict-resolve':
                await this.handleConflictResolve(msg);
                break;
            case 'toggle-layout-mode':
                this.onToggleLayoutMode?.();
                break;
            case 'flush-noop':
                this.resolveFlush(msg.flushId, msg.revision === this.store.snapshot.revision && !this.isDirty);
                break;
            case 'flush-failed':
                this.resolveFlush(msg.flushId, false);
                break;
            case 'reload-applied': {
                const reload = this.pendingReload;
                if (reload?.id === msg.reloadId && reload.nextRevision === msg.revision
                    && reload.revision === this.store.snapshot.revision) {
                    this.pendingReload = undefined;
                    this.adoptContent(reload.content, this.filePath);
                    this.refreshFromDisk();
                }
                break;
            }
            case 'reload-rejected': {
                const reload = this.pendingReload;
                if (reload?.id === msg.reloadId && msg.revision === this.store.snapshot.revision) {
                    this.pendingReload = undefined;
                    if (msg.editVersion >= this.editVersion) {
                        this.editVersion = msg.editVersion;
                        this.latestDraft = { ...msg, type: 'auto-save' };
                    }
                    this.setDirty(true);
                    this.showConflict(reload.content);
                    this.refreshFromDisk();
                }
                break;
            }
            case 'document-stats':
                if (msg.stats && Object.values(msg.stats).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
                    this.onStatsChange?.(msg.stats);
                }
                break;
        }
    }

    /**
     * Minimal-churn body treatment at write time: merge the serialized
     * Markdown against the body currently on disk so blocks the user didn't
     * edit keep their original bytes (the WYSIWYG round-trip alone would
     * restyle the whole file — bullets, emphasis markers, escapes, wraps).
     */
    prepareBodyForWrite(content: string): string {
        return preserveUnchangedBlocks(this.lastBodyContent, content);
    }

    private async handleConflictResolve(msg: WebviewConflictResolveMessage): Promise<void> {
        const pending = this.pendingConflict;
        if (!pending || !this.filePath || msg.revision !== this.store.snapshot.revision || msg.conflictId !== pending.id) { return; }
        const latest = await fs.readFile(this.filePath, 'utf8');
        if (msg.revision !== this.store.snapshot.revision) { return; }
        if (msg.choice === 'reload') {
            this.sendLoad(latest, this.filePath);
        } else if (latest !== pending.content || this.pendingConflict?.id !== pending.id) {
            this.showConflict(latest);
        } else {
            const { revision } = this.store.accept(latest);
            this.lastBodyContent = extractFrontmatter(latest).body;
            this.pendingConflict = undefined;
            this.post({ type: 'rebase', revision });
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
            || !Array.isArray(msg.history) || !this.askNote) {
            this.post({ type: 'note-error', requestId: id, message: '这条旁注没有发出去，请重试。' });
            return;
        }
        const run = new AbortController();
        this.noteRuns.set(id, run);
        try {
            // The agent reads the document from disk for context, so give it the
            // latest text. Best effort: the blocks in question travel with the note.
            if (this.filePath && this.isDirty) { await this.flushEdits(); }
            const answer = await this.askNote(msg, step => {
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

    private setDirty(dirty: boolean): void {
        this.isDirty = dirty;
        this.onDirtyChange?.(dirty);
    }

    private showConflict(content: string): void {
        if (this.pendingConflict?.content !== content) {
            this.pendingConflict = { content, id: ++this.conflictId };
        }
        this.post({ type: 'conflict', conflictId: this.pendingConflict.id, revision: this.store.snapshot.revision });
    }

    private async persist(msg: WebviewSaveMessage | WebviewAutoSaveMessage): Promise<boolean> {
        const flushId = 'flushId' in msg ? msg.flushId : undefined;
        let success = false;
        try {
            if (!this.filePath || msg.revision !== this.store.snapshot.revision || this.pendingConflict) { return false; }
            if (typeof msg.content !== 'string' || typeof msg.frontmatter !== 'string' || !Number.isSafeInteger(msg.editVersion)) { return false; }
            const body = this.prepareBodyForWrite(msg.content);
            const result = await this.store.write({ content: msg.frontmatter + body, revision: msg.revision, editVersion: msg.editVersion });
            if (this.disposed) { return result.kind === 'saved'; }
            if (msg.revision !== this.store.snapshot.revision) { return false; }
            if (result.kind === 'conflict') { this.showConflict(result.content); return false; }
            if (result.kind === 'stale') { return false; }
            this.lastBodyContent = body;
            this.storedFrontmatter = msg.frontmatter;
            if (this.latestDraft && msg.editVersion >= this.latestDraft.editVersion) { this.latestDraft = undefined; }
            if (msg.editVersion >= this.editVersion) { this.setDirty(false); }
            this.post({ type: 'saved', success: true, filePath: this.filePath, revision: msg.revision, editVersion: msg.editVersion, content: body });
            success = true;
            return true;
        } catch (error) {
            // A closing panel can no longer be updated; the caller recovers the draft instead.
            if (this.disposed) { return false; }
            const errMsg = error instanceof Error ? error.message : 'Save failed';
            this.setDirty(true);
            this.post({ type: 'saved', success: false, revision: msg.revision, editVersion: msg.editVersion, message: errMsg });
            return false;
        } finally {
            if (flushId && success && msg.editVersion < this.editVersion && this.flushWaiters.has(flushId)) {
                this.post({ type: 'request-save', flushId, freeze: this.frozenFlushes.has(flushId) });
            } else { this.resolveFlush(flushId, success); }
        }
    }

    private async handleSave(msg: WebviewSaveMessage): Promise<void> {
        if (!this.filePath) {
            const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] }, defaultUri: vscode.Uri.file('untitled.md') });
            if (!uri) { this.resolveFlush(msg.flushId, false); return; }
            await this.store.retarget(uri.fsPath);
            this.setFilePath(uri.fsPath);
        }
        await this.persist(msg);
    }

    private watchFile(): void {
        this.nativeWatcher?.close();
        this.nativeWatcher = undefined;
        if (this.externalTimer) { clearTimeout(this.externalTimer); }
        if (this.externalPoll) { clearInterval(this.externalPoll); }
        this.refreshDocument = undefined;
        if (!this.filePath) { return; }

        const filePath = this.filePath;
        const fileName = path.basename(filePath);
        let unavailable: string | undefined;

        const refresh = async (): Promise<void> => {
            if (this.filePath !== filePath) { return; }
            try {
                const content = await this.store.externalContent();
                if (this.disposed || this.filePath !== filePath) { return; }
                if (unavailable !== undefined) {
                    unavailable = undefined;
                    this.post({ type: 'notice', message: this.isDirty ? '未保存' : '已同步' });
                }
                if (content === undefined) { return; }

                if (this.isDirty) {
                    // Editor has unsaved changes — don't stomp them; ask the user to choose.
                    this.showConflict(content);
                    return;
                }

                this.proposeReload(content);
            } catch (error) {
                // Report an unreadable file once, not on every poll tick.
                const message = error instanceof Error ? error.message : '文件暂时不可读，自动保存已暂停。';
                if (!this.disposed && message !== unavailable) {
                    unavailable = message;
                    this.post({ type: 'notice', message: `文件暂时不可读：${message}` });
                }
            }
        };
        const schedule = (): void => {
            if (this.externalTimer) { clearTimeout(this.externalTimer); }
            this.externalTimer = setTimeout(() => { if (!this.disposed) { void refresh(); } }, 30);
        };
        this.refreshDocument = refresh;

        // Register synchronously, including files outside a workspace. Watching
        // the parent also survives an agent's temp-file + rename replacement.
        try {
            this.nativeWatcher = watch(path.dirname(filePath), { persistent: false }, (_event, name) => {
                if (name && name.toString() !== fileName) { return; }
                schedule();
            });
            this.nativeWatcher.on('error', () => { /* The metadata poll and write-time validation remain available. */ });
        } catch { /* Some virtual filesystems do not provide a native watcher; the poll covers them. */ }

        // OS watcher startup and sleep/resume can lose notifications. A cheap
        // metadata poll closes that gap; it only reads the file when the
        // metadata (or its availability) changes.
        let observedStat = '';
        this.externalPoll = setInterval(() => {
            if (this.disposed) { return; }
            void fs.stat(filePath).then(
                stat => `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`,
                () => 'unavailable',
            ).then(identity => {
                if (identity !== observedStat) { observedStat = identity; schedule(); }
            });
        }, 750);
    }

    private async handleOpenFile(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Markdown': ['md'] },
        });
        if (!uris || uris.length === 0) { return; }

        try {
            const content = await fs.readFile(uris[0].fsPath, 'utf-8');
            if (this.isDirty && !await this.flushEdits(true)) { return; }
            this.cancelNoteRuns();
            this.setFilePath(uris[0].fsPath);
            this.sendLoad(content, this.filePath);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Open failed';
            vscode.window.showErrorMessage(`Failed to open file: ${errMsg}`);
        }
    }

    private async resolveAssetDir(): Promise<string> {
        const docDir = path.dirname(this.filePath!);
        const config = ConfigService.getInstance().getAllConfig();
        const assetDir = config.assetDir?.trim();

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
        if (!this.filePath) {
            this.post({ type: 'file-upload-error', uploadId: msg.uploadId, message: 'Save the document before uploading files.' });
            return;
        }

        try {
            const docDir = path.dirname(this.filePath);
            const dir = await this.resolveAssetDir();
            const finalName = await getUniqueFileName(dir, path.basename(msg.fileName));
            const fullPath = path.join(dir, finalName);

            const buffer = Buffer.from(msg.dataBase64, 'base64');
            await fs.writeFile(fullPath, buffer);

            const webviewUri = this.webview.asWebviewUri(vscode.Uri.file(fullPath)).toString();
            const isImage = msg.mimeType.startsWith('image/');

            // relativePath must be relative to docDir for correct markdown links
            const relativePath = path.relative(docDir, fullPath);

            this.post({
                type: 'file-uploaded',
                uploadId: msg.uploadId,
                webviewUri,
                relativePath,
                isImage,
                fileName: finalName,
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Upload failed';
            this.post({ type: 'file-upload-error', uploadId: msg.uploadId, message: errMsg });
        }
    }

    private handleNewFile(): void {
        this.cancelNoteRuns();
        this.filePath = undefined;
        this.store.setPath('');
        this.watchFile();
        this.storedFrontmatter = '';
        this.lastBodyContent = '';
        this.sendLoad('');
    }

    dispose(): void {
        if (this.disposed) { return; }
        const draft = this.latestDraft;
        if (draft && this.isDirty) {
            // The view can close before its debounce fires. Preserve the last
            // complete snapshot; a conflict is recovered in an untitled editor.
            void this.persist(draft).then(success => {
                if (!success) { this.onRecoverDraft?.(draft.frontmatter + draft.content); }
            });
        }
        this.disposed = true;
        this.nativeWatcher?.close();
        if (this.externalTimer) { clearTimeout(this.externalTimer); }
        if (this.externalPoll) { clearInterval(this.externalPoll); }
        for (const resolve of this.flushWaiters.values()) { resolve(false); }
        this.flushWaiters.clear();
        this.frozenFlushes.clear();
        this.cancelNoteRuns();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    private cancelNoteRuns(): void {
        for (const run of this.noteRuns.values()) { run.abort(); }
        this.noteRuns.clear();
    }
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
