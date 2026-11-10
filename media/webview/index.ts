import { Editor } from '@milkdown/kit/core';
import { rootCtx, defaultValueCtx, editorViewCtx, commandsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { commonmark, toggleStrongCommand } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { block } from '@milkdown/kit/plugin/block';
import { upload, uploadConfig } from '@milkdown/kit/plugin/upload';
import { replaceAll } from '@milkdown/kit/utils';
import { notesPlugin, handleNoteMessage, openAskAtSelection, beforeDocumentLoad, afterDocumentLoad } from './notes-plugin';
import { bbSlashPlugin } from './bb-slash-plugin';
import { headingKeymapPlugin } from './heading-keymap-plugin';
import { arrowLigaturesPlugin } from './arrow-ligatures-plugin';
import { codeHighlightPlugin } from './code-highlight-plugin';
import { htmlRenderPlugin } from './html-render-plugin';
import { preprocessMarkdown, serializeForSave, setSourceMarkdown, normalizedMarkdown } from './markdown-output';
import { initFrontmatterPanel, updateFrontmatterPanel, onFrontmatterChange, getFrontmatter } from './frontmatter-panel';
import type { HostMessage } from '../../src/services/webviewProtocol';
import { editorInfoPlugin, refreshEditorInfo } from './editor-info-plugin';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import { undo } from '@milkdown/kit/prose/history';
import './styles.css';

import type { Node, Schema } from '@milkdown/kit/prose/model';
import { Decoration } from '@milkdown/kit/prose/view';

// VS Code API
declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// Export for use by plugins
(window as unknown as Record<string, unknown>).__vscode = vscode;

let editor: Editor;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let draftTimer: ReturnType<typeof setTimeout> | null = null;
let draftPending = false;
let hasFilePath = false;
let baseUri = '';
let revision = 0;
let editVersion = 0;
let loading = false;
let conflictId: number | null = null;
let savedSnapshot = '';
const pendingSaves = new Map<number, { snapshot: string; normalized: string; frontmatter: string }>();
const pendingFlushes = new Map<string, boolean>();
let editingLocked = false;

// Loading is isolated from user edits. The source serializer retains original
// bytes, and each draft/save belongs to a document epoch and edit version.

// ---- IME composition guard ----
// During CJK IME composition, ProseMirror emits intermediate text that must not
// flow into auto-save. We snapshot dirty intent during
// composition and flush exactly once on compositionend.
let isComposing = false;
let pendingComposedChange = false;

export function isInComposition(): boolean { return isComposing; }

// ---- File Upload ----

interface FileUploadedResult {
    uploadId: string;
    webviewUri: string;
    relativePath: string;
    isImage: boolean;
    fileName: string;
}

const pendingUploads = new Map<string, { resolve: (result: FileUploadedResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            // Strip "data:mime/type;base64," prefix
            const base64 = dataUrl.split(',')[1] || '';
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

const fileUploader = async (files: FileList, schema: Schema): Promise<Node[]> => {
    const uploadRevision = revision;
    const nodes: Node[] = [];

    for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (!file) { continue; }

        const dataBase64 = await fileToBase64(file);
        const uploadId = crypto.randomUUID();

        const result = await new Promise<FileUploadedResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingUploads.delete(uploadId);
                reject(new Error('上传超时，请重试。'));
            }, 30000);
            pendingUploads.set(uploadId, { resolve, reject, timer });
            vscode.postMessage({
                type: 'file-upload',
                uploadId,
                fileName: file.name,
                mimeType: file.type,
                dataBase64,
            });
        });

        if (revision !== uploadRevision) { throw new Error('文档已更新，请重新上传。'); }

        if (result.isImage) {
            const imageType = schema.nodes['image'];
            if (imageType) {
                const node = imageType.createAndFill({
                    src: result.webviewUri,
                    alt: result.fileName,
                });
                if (node) { nodes.push(node); }
            }
        } else {
            const linkMark = schema.marks['link']?.create({ href: result.webviewUri });
            if (linkMark) {
                nodes.push(schema.text(result.fileName, [linkMark]));
            }
        }
    }

    return nodes;
};

// ---- Auto Save ----

function scheduleAutoSave(): void {
    if (loading || !editor) { return; }
    editVersion++;
    // Keystrokes only flag the edit; the full draft is serialized once typing pauses.
    vscode.postMessage({ type: 'dirty', isDirty: true, revision, editVersion });
    if (isComposing) {
        pendingComposedChange = true;
        return;
    }
    draftPending = true;
    if (draftTimer) { clearTimeout(draftTimer); }
    draftTimer = setTimeout(postDraft, 150);
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); }
    autoSaveTimer = setTimeout(() => {
        if (!editor) { return; }
        autoSaveTimer = null;
        sendSave('auto-save');
    }, 500);
}

/** Hands the host the latest complete snapshot so a closing panel can still save or recover it. */
function postDraft(): void {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    if (!draftPending || !editor || loading || isComposing) { return; }
    draftPending = false;
    vscode.postMessage({ type: 'document-change', content: serializeForSave(editor, baseUri), frontmatter: getFrontmatter(), revision, editVersion });
}

function sendSave(type: 'save' | 'auto-save', flushId?: string): void {
    if (isComposing) { pendingComposedChange = true; if (flushId && !pendingFlushes.has(flushId)) { pendingFlushes.set(flushId, false); } return; }
    if (!editor || loading || conflictId !== null) {
        if (flushId) { vscode.postMessage({ type: 'flush-failed', flushId }); }
        return;
    }
    // An untitled document has nowhere to auto-save; only an explicit save asks for a path.
    if (type === 'auto-save' && !hasFilePath) {
        postDraft();
        if (flushId) { vscode.postMessage({ type: 'flush-failed', flushId }); }
        return;
    }
    const content = serializeForSave(editor, baseUri);
    const frontmatter = getFrontmatter();
    const snapshot = frontmatter + content;
    if (snapshot === savedSnapshot && pendingSaves.size === 0 && type !== 'save') {
        vscode.postMessage({ type: 'dirty', isDirty: false, revision, editVersion });
        if (flushId) { vscode.postMessage({ type: 'flush-noop', flushId, revision }); }
        return;
    }
    postDraft();
    pendingSaves.set(editVersion, { snapshot, normalized: normalizedMarkdown(editor, baseUri), frontmatter });
    vscode.postMessage({ type, content, frontmatter, revision, editVersion, flushId });
}

function setEditingLocked(locked: boolean): void {
    editingLocked = locked;
    for (const id of ['editor-layout', 'editor-toolbar']) {
        const element = document.getElementById(id);
        if (element) { element.inert = locked; }
    }
    if (editor) { editor.ctx.get(editorViewCtx).setProps({ editable: () => !editingLocked }); }
}

// ---- Editor Init ----

async function initEditor(): Promise<void> {
    const editorRoot = document.getElementById('editor');
    if (!editorRoot) { return; }

    editor = await Editor.make()
        .config(ctx => {
            ctx.set(rootCtx, editorRoot);
            ctx.set(defaultValueCtx, '');
            // Low-churn serializer style: remark-stringify defaults to "*"
            // bullets and "***" rules, which rewrites the far more common
            // "-" style on every save. Match the common style instead.
            ctx.update(remarkStringifyOptionsCtx, (opts) => ({
                ...opts,
                bullet: '-' as const,
                rule: '-' as const,
            }));
            ctx.update(uploadConfig.key, () => ({
                uploader: async files => {
                    try { return await fileUploader(files, editor.ctx.get(editorViewCtx).state.schema); }
                    catch (error) { showNotice(`上传失败：${error instanceof Error ? error.message : '请重试'}`); return []; }
                },
                enableHtmlFileUploader: true,
                uploadWidgetFactory: (pos: number, spec: Parameters<typeof Decoration.widget>[2]) => {
                    const el = document.createElement('span');
                    el.className = 'upload-placeholder';
                    el.textContent = 'Uploading...';
                    return Decoration.widget(pos, el, spec);
                },
            }));
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(block)
        .use(upload)
        .use(bbSlashPlugin)
        .use(headingKeymapPlugin)
        .use(arrowLigaturesPlugin)
        .use(codeHighlightPlugin)
        .use(htmlRenderPlugin)
        .use(notesPlugin({ post: message => vscode.postMessage(message), baseUri: () => baseUri }))
        .use(editorInfoPlugin({
            markdown: () => editor ? serializeForSave(editor, baseUri) : '',
            frontmatter: getFrontmatter,
            stats: stats => vscode.postMessage({ type: 'document-stats', stats }),
        }))
        .use($prose(() => new Plugin({
            view: () => ({ update: (view, previous) => {
                if (!view.state.doc.eq(previous.doc)) { scheduleAutoSave(); }
            } }),
        })))
        .create();

    // IME composition guard on the editor root.
    // ProseMirror emits onChange during composition; suppress auto-save until it ends.
    document.addEventListener('compositionstart', () => {
        isComposing = true;
        if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    });
    document.addEventListener('compositionend', () => {
        isComposing = false;
        if (pendingComposedChange) {
            pendingComposedChange = false;
            scheduleAutoSave();
        }
        setTimeout(() => {
            if (isComposing) { return; }
            for (const [id, freeze] of pendingFlushes) {
                if (freeze) { setEditingLocked(true); }
                sendSave('auto-save', id);
            }
            pendingFlushes.clear();
        }, 30);
    });
}

// Message handler from Extension Host
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    switch (msg.type) {
        case 'load':
            if (msg.reloadId !== undefined && (msg.previousRevision !== revision
                || msg.expectedEditVersion !== editVersion || isComposing
                || pendingSaves.size > 0 || getFrontmatter() + serializeForSave(editor, baseUri) !== savedSnapshot)) {
                vscode.postMessage({ type: 'reload-rejected', reloadId: msg.reloadId, revision, editVersion,
                    content: serializeForSave(editor, baseUri), frontmatter: getFrontmatter() });
                break;
            }
            if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
            if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
            draftPending = false;
            loading = true;
            hasFilePath = !!msg.filePath;
            revision = msg.revision;
            editVersion = 0;
            pendingSaves.clear();
            pendingFlushes.clear();
            conflictId = null;
            baseUri = msg.baseUri || '';
            setSourceMarkdown(msg.content || '', '');
            updateFrontmatterPanel(msg.frontmatter || '');
            if (editor) {
                // Notes are found again by what their blocks say; positions do not survive a reload.
                beforeDocumentLoad();
                editor.action(replaceAll(preprocessMarkdown(msg.content || '', baseUri), true));
                afterDocumentLoad();
                setSourceMarkdown(msg.content || '', normalizedMarkdown(editor, baseUri));
                savedSnapshot = getFrontmatter() + serializeForSave(editor, baseUri);
            }
            loading = false;
            pendingComposedChange = false;
            hideConflictBanner();
            setEditingLocked(false);
            window.dispatchEvent(new Event('bb-document-loaded'));
            if (msg.reloadId !== undefined) { vscode.postMessage({ type: 'reload-applied', reloadId: msg.reloadId, revision }); }
            break;
        case 'conflict':
            if (msg.revision !== revision) { break; }
            conflictId = msg.conflictId;
            if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
            showConflictBanner();
            break;
        case 'rebase':
            revision = msg.revision;
            conflictId = null;
            pendingSaves.clear();
            setEditingLocked(false);
            hideConflictBanner();
            sendSave('save');
            break;
        case 'note-progress':
        case 'note-done':
        case 'note-error':
        case 'notes-load':
            if (editor) { handleNoteMessage(msg); }
            break;
        case 'saved':
            if (msg.revision !== revision) { break; }
            if (msg.success) {
                if (msg.filePath) { hasFilePath = true; }
                const pending = pendingSaves.get(msg.editVersion);
                if (pending !== undefined) {
                    savedSnapshot = msg.content !== undefined ? pending.frontmatter + msg.content : pending.snapshot;
                    if (msg.content !== undefined) { setSourceMarkdown(msg.content, pending.normalized); }
                }
                for (const version of pendingSaves.keys()) {
                    if (version <= msg.editVersion) { pendingSaves.delete(version); }
                }
            } else {
                pendingSaves.delete(msg.editVersion);
                showNotice(`保存失败：${msg.message || '请重试'}`);
            }
            break;
        case 'notice':
            showNotice(msg.message);
            break;
        case 'theme':
            document.body.setAttribute('data-theme', msg.kind);
            break;
        case 'file-uploaded': {
            const upload = pendingUploads.get(msg.uploadId);
            if (upload) {
                clearTimeout(upload.timer);
                upload.resolve(msg);
                pendingUploads.delete(msg.uploadId);
            }
            break;
        }
        case 'file-upload-error': {
            const upload = pendingUploads.get(msg.uploadId);
            if (upload) {
                clearTimeout(upload.timer);
                upload.reject(new Error(msg.message));
                pendingUploads.delete(msg.uploadId);
            }
            showNotice(`上传失败：${msg.message}`);
            break;
        }
        case 'request-save': {
            // Host is about to swap this panel back to the text editor —
            // flush the debounced auto-save immediately so the file on disk
            // reflects the latest edits before the text editor loads it.
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
                autoSaveTimer = null;
            }
            if (isComposing) {
                pendingFlushes.set(msg.flushId, !!msg.freeze);
                pendingComposedChange = true;
            } else {
                if (msg.freeze) { setEditingLocked(true); }
                sendSave('auto-save', msg.flushId);
            }
            break;
        }
        case 'edit-unlock':
            if (msg.flushId) { pendingFlushes.delete(msg.flushId); }
            else { pendingFlushes.clear(); }
            setEditingLocked(false);
            break;
        case 'set-layout-mode': {
            // Host is the source of truth for this global preference; we
            // never flip the class locally — only mirror what the host says.
            const editorMode = msg.mode === 'editor';
            document.body.classList.toggle('bb-mode-editor', editorMode);
            document.body.classList.toggle('bb-mode-zen', !editorMode);
            // The letter labels the current mode; the tooltip names the destination.
            const btn = document.getElementById('mode-toggle');
            if (btn) {
                btn.title = editorMode
                    ? '当前 Editor Mode，点击切换到 Zen Mode'
                    : '当前 Zen Mode，点击切换到 Editor Mode';
            }
            break;
        }
    }
});

// Layout toggle: the host persists the flip and broadcasts the new mode back
// via 'set-layout-mode', keeping every open BB Editor panel in sync.
document.getElementById('mode-toggle')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggle-layout-mode' });
});

// Zen Mode fades the remaining chrome while typing; any pointer movement brings it back.
// Typing into a note (a question, a follow-up) is not writing, so it leaves the notes legible.
const inNoteUi = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('.bb-note, .bb-ask');
document.getElementById('editor')?.addEventListener('keydown', (e) => {
    if (!inNoteUi(e.target)) { document.body.classList.add('bb-typing'); }
});
document.addEventListener('mousemove', () => document.body.classList.remove('bb-typing'));

// Closing the panel (tab click, Cmd+W) blurs the webview or sends a modifier
// key first — hand over the pending draft before the view can disappear.
window.addEventListener('blur', postDraft);
document.addEventListener('visibilitychange', () => { if (document.hidden) { postDraft(); } });

// Keyboard shortcuts
let chordTimer: ReturnType<typeof setTimeout> | null = null;

function toggleBold(): void {
    editor?.action(ctx => ctx.get(commandsCtx).call(toggleStrongCommand.key));
}

document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) { postDraft(); }
    if (editingLocked) { if (e.metaKey || e.ctrlKey) { e.preventDefault(); } return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveFile();
        return;
    }

    // cmd+b cmd+b asks about the block under the caret. A single cmd+b still
    // bolds at once; when the second press follows, that bold is taken back.
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || isComposing || loading || inNoteUi(e.target)) { return; }
        if (chordTimer) {
            clearTimeout(chordTimer);
            chordTimer = null;
            revertBold();
            openAskAtSelection();
        } else {
            docBeforeBold = editor?.ctx.get(editorViewCtx).state.doc;
            toggleBold();
            chordTimer = setTimeout(() => { chordTimer = null; }, 400);
        }
    }
}, true); // capture phase — intercept before Milkdown

/** Take back the bold the first cmd+b of a chord applied: an edit is undone, a pending mark is toggled off. */
let docBeforeBold: unknown;
function revertBold(): void {
    if (!editor) { return; }
    const view = editor.ctx.get(editorViewCtx);
    if (view.state.doc !== docBeforeBold) { undo(view.state, view.dispatch); }
    else { toggleBold(); }
}

function saveFile(): void {
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    sendSave('save');
}

// Routine save state lives in the tab's dirty marker; only things the user must act on surface here.
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showNotice(text: string): void {
    const el = document.getElementById('status');
    if (!el) { return; }
    el.textContent = text;
    el.hidden = false;
    if (noticeTimer) { clearTimeout(noticeTimer); }
    noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ---- Conflict Banner ----

function showConflictBanner(): void {
    const banner = document.getElementById('conflict-banner');
    if (banner) { banner.classList.remove('hidden'); }
}

function hideConflictBanner(): void {
    const banner = document.getElementById('conflict-banner');
    if (banner) { banner.classList.add('hidden'); }
}

function initConflictBanner(): void {
    const reload = document.getElementById('conflict-reload');
    const keep = document.getElementById('conflict-keep');
    reload?.addEventListener('click', () => {
        setEditingLocked(true);
        vscode.postMessage({ type: 'conflict-resolve', choice: 'reload', revision, conflictId });
    });
    keep?.addEventListener('click', () => {
        setEditingLocked(true);
        vscode.postMessage({ type: 'conflict-resolve', choice: 'keep', revision, conflictId });
    });
}

// Click on #editor padding area delegates focus to the editor
document.getElementById('editor')?.addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget && editor) {
        e.preventDefault();
        editor.action((ctx) => {
            ctx.get(editorViewCtx).focus();
        });
    }
});

// Scroll past end needs the scroll viewport height; percentages in padding resolve against width.
const editorScroller = document.getElementById('editor');
if (editorScroller) {
    new ResizeObserver(() => {
        editorScroller.style.setProperty('--bb-viewport-height', `${editorScroller.clientHeight}px`);
    }).observe(editorScroller);
}

// Init
initFrontmatterPanel();
onFrontmatterChange(() => {
    scheduleAutoSave();
    refreshEditorInfo();
});
initConflictBanner();
initEditor().then(() => {
    vscode.postMessage({ type: 'ready' });
});
