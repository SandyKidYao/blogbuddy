import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { indentUnit, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Text } from '@codemirror/state';
import { dropCursor, EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { HostMessage, WebviewMessage } from '../../src/services/webviewProtocol';
import { codeLanguages } from './code-languages';
import { arrowLigatures, tab, toggleBold, toggleWrap } from './commands';
import { frontmatterSyntax } from '../../src/utils/frontmatter';
import { frontmatter, frontmatterText, fromPanel, writeFrontmatter } from './frontmatter';
import { frontmatterPanel, getFrontmatter, onFrontmatterChange, updateFrontmatterPanel } from './frontmatter-panel';
import { sourceLineNumbers } from './line-numbers';
import { livePreview, setBaseUri } from './live-preview';
import { afterDocumentLoad, beforeDocumentLoad, handleNoteMessage, initNotes, notesExtension, openAskAtSelection, restoreNotes } from './notes';
import { slashMenu } from './slash';
import { DocumentSync } from './sync';
import { fileUploads, handleUploadMessage } from './upload';
import './styles.css';
import './editor.css';

/**
 * BB Editor: a live-preview Markdown editor whose text is the file's text.
 * VS Code's TextDocument is the source of truth — saving, dirty state and
 * reloading from disk are VS Code's; this webview keeps its copy in step
 * (sync.ts) and never writes files itself.
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const post = (message: WebviewMessage): void => vscode.postMessage(message);

let view: EditorView;
let baseUri = '';
const sync = new DocumentSync(() => view, post, showNotice);

// ---- Selection, for the status bar (which counts the document itself) ----

let selectionTimer: ReturnType<typeof setTimeout> | undefined;
function reportSelection(): void {
    if (selectionTimer) { clearTimeout(selectionTimer); }
    selectionTimer = setTimeout(() => {
        const { from, to } = view.state.selection.main;
        post({ type: 'selection', from, to });
    }, 150);
}

// ---- Editor ----

const PHRASES = {
    'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个', 'all': '全部',
    'match case': '区分大小写', 'regexp': '正则', 'by word': '全词', 'replace': '替换', 'replace all': '全部替换', 'close': '关闭',
    'current match': '当前匹配', 'on line': '行',
};

function onUpdate(update: ViewUpdate): void {
    if (update.selectionSet || update.docChanged) { reportSelection(); }
    if (update.docChanged) {
        // The frontmatter changed from somewhere other than the panel (undo, a text editor): show it.
        const own = update.transactions.some(tr => tr.annotation(fromPanel));
        const text = frontmatterText(update.state);
        if (!own && text !== getFrontmatter()) { updateFrontmatterPanel(text, true); }
    }
}

function createState(doc: string, version: number, editable: boolean): EditorState {
    return EditorState.create({
        doc,
        extensions: [
            markdown({ base: markdownLanguage, codeLanguages, extensions: [frontmatterSyntax], addKeymap: true }),
            syntaxHighlighting(classHighlighter),
            frontmatter(),
            livePreview(),
            notesExtension(),
            sync.extension(version),
            history(),
            search({ top: true }),
            slashMenu(),
            dropCursor(),
            placeholder('开始写作，输入 / 调出 BB 命令'),
            EditorView.lineWrapping,
            indentUnit.of('  '),
            EditorState.phrases.of(PHRASES),
            sourceLineNumbers(),
            EditorView.editable.of(editable),
            arrowLigatures,
            fileUploads({ post, notice: showNotice }),
            keymap.of([
                { key: 'Mod-i', run: toggleWrap('*') },
                { key: 'Mod-e', run: toggleWrap('`') },
                { key: 'Tab', run: target => tab(target, false), shift: target => tab(target, true) },
                ...searchKeymap,
                ...historyKeymap,
                ...defaultKeymap,
            ]),
            EditorView.updateListener.of(onUpdate),
        ],
    });
}

/** The document as the host has it: a fresh state, so undo history does not reach across. */
function loadDocument(text: string, version: number): void {
    beforeDocumentLoad();
    view.setState(createState(text, version, true));
    view.dispatch({ effects: setBaseUri.of(baseUri) });
    updateFrontmatterPanel(frontmatterText(view.state));
    afterDocumentLoad();
}

// ---- Host messages ----

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    switch (msg.type) {
        case 'init':
            baseUri = msg.baseUri || '';
            sync.start(msg.epoch);
            loadDocument(msg.text, msg.version);
            if (msg.notes) { restoreNotes(msg.notes); }
            break;
        case 'updates':
        case 'push-result':
            sync.handle(msg);
            break;
        case 'note-progress':
        case 'note-done':
        case 'note-error':
            handleNoteMessage(msg);
            break;
        case 'file-uploaded':
        case 'file-upload-error':
            handleUploadMessage(msg);
            break;
        case 'notice':
            showNotice(msg.message);
            break;
        case 'set-layout-mode':
            document.body.classList.toggle('bb-mode-editor', msg.mode === 'editor');
            document.body.classList.toggle('bb-mode-zen', msg.mode !== 'editor');
            showLayoutMode();
            view.requestMeasure();
            break;
    }
});

/** The toggle names the current mode; its tooltip names where a click goes. The page starts in the mode the host chose. */
function showLayoutMode(): void {
    const btn = document.getElementById('mode-toggle');
    if (!btn) { return; }
    btn.title = document.body.classList.contains('bb-mode-editor') ? '当前 Editor Mode，点击切换到 Zen Mode' : '当前 Zen Mode，点击切换到 Editor Mode';
}
document.getElementById('mode-toggle')?.addEventListener('click', () => post({ type: 'toggle-layout-mode' }));

// Zen Mode fades the remaining chrome while typing; any pointer movement brings it back.
// Notes and the properties panel have inputs of their own: typing there is not writing, and ⌘B there is not bold.
const inNoteUi = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('.bb-note, .bb-ask, #frontmatter-panel');
document.getElementById('editor')?.addEventListener('keydown', (e) => {
    if (!inNoteUi(e.target)) { document.body.classList.add('bb-typing'); }
});
document.addEventListener('mousemove', () => document.body.classList.remove('bb-typing'));

// ---- Keys handled before the editor ----

let chordTimer: ReturnType<typeof setTimeout> | null = null;
let docBeforeBold: Text | undefined;

/** Take back the bold the first ⌘B of a chord applied. */
function revertBold(): void {
    if (view.state.doc !== docBeforeBold) { undo(view); } else { toggleBold(view); }
}

document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        sync.save();
        return;
    }
    // ⌘B ⌘B asks about the block under the caret. A single ⌘B still bolds at once;
    // when the second press follows, that bold is taken back.
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || e.isComposing || inNoteUi(e.target) || !view.state.facet(EditorView.editable)) { return; }
        if (chordTimer) {
            clearTimeout(chordTimer);
            chordTimer = null;
            revertBold();
            openAskAtSelection();
        } else {
            docBeforeBold = view.state.doc;
            toggleBold(view);
            chordTimer = setTimeout(() => { chordTimer = null; }, 400);
        }
    }
}, true);

// ---- Notices ----

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showNotice(text: string): void {
    const el = document.getElementById('status');
    if (!el) { return; }
    el.textContent = text;
    el.hidden = false;
    if (noticeTimer) { clearTimeout(noticeTimer); }
    noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Clicking the padding around the text focuses the editor.
document.getElementById('editor')?.addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget && view) { e.preventDefault(); view.focus(); }
});

// Scroll past end needs the scroll viewport height; percentages in padding resolve against width.
const editorScroller = document.getElementById('editor');
if (editorScroller) {
    new ResizeObserver(() => {
        editorScroller.style.setProperty('--bb-viewport-height', `${editorScroller.clientHeight}px`);
    }).observe(editorScroller);
}

// ---- Init ----

showLayoutMode();
// The panel edits the frontmatter in the document, like any other edit.
onFrontmatterChange(() => writeFrontmatter(view, getFrontmatter()));
// Read-only until the host sends the document.
view = new EditorView({ state: createState('', 0, false), parent: document.getElementById('editor') ?? document.body });
initNotes(view, { post });
// Expanding the panel changes the head's height; the editor measures again.
new ResizeObserver(() => view.requestMeasure()).observe(frontmatterPanel());
post({ type: 'ready' });
