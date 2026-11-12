/**
 * Webview ↔ Extension Host 消息协议类型定义
 */

import type { WireUpdate } from './textSync';

// ===== Webview → Extension Host =====

export interface WebviewReadyMessage {
    type: 'ready';
}

/** Where the selection is (offsets in the webview's text), for the status bar's selected-words count. */
export interface WebviewSelectionMessage {
    type: 'selection';
    from: number;
    to: number;
}

/** What a margin note is about: one block, a heading's whole section, or several adjacent blocks. */
export type NoteScopeKind = 'block' | 'section' | 'range';

/** One earlier turn of a note, as plain text for the agent. */
export interface NoteTurnWire {
    role: 'me' | 'ai';
    text: string;
}

/** The writer left a sentence beside some blocks; the host hands it to the agent. */
export interface WebviewNoteAskMessage {
    type: 'note-ask';
    requestId: string;
    question: string;
    scopeKind: NoteScopeKind;
    /** Markdown of the blocks in scope, as they are in the editor right now. */
    scopeMarkdown: string;
    quote?: string;
    history: NoteTurnWire[];
}

export interface WebviewNoteCancelMessage {
    type: 'note-cancel';
    requestId: string;
}

/** The document's notes, to be kept by the host. Opaque to it: the webview owns the shape. */
export interface WebviewNotesSaveMessage {
    type: 'notes-save';
    notes: unknown[];
}

/**
 * The webview's unconfirmed changes (@codemirror/collab updates), based on the
 * document version it has seen. Only one push is in flight at a time.
 */
export interface WebviewPushMessage {
    type: 'push';
    /** Sync session; a push from before a reset is turned away. */
    epoch: number;
    version: number;
    updates: WireUpdate[];
}

/** The webview received updates it cannot place; it asks to start over from the document. */
export interface WebviewResyncMessage {
    type: 'resync';
}

/** Save the document (⌘S), once the webview's changes have all reached it. */
export interface WebviewSaveMessage {
    type: 'save';
}

export interface WebviewFileUploadMessage {
    type: 'file-upload';
    uploadId: string;
    fileName: string;
    mimeType: string;
    dataBase64: string;
}

/** Zen: centered, distraction-free writing and reading. Editor: full width with line numbers and frontmatter. */
export type LayoutMode = 'zen' | 'editor';

export interface WebviewToggleLayoutModeMessage {
    type: 'toggle-layout-mode';
}

export type WebviewMessage =
    | WebviewReadyMessage
    | WebviewPushMessage
    | WebviewResyncMessage
    | WebviewSaveMessage
    | WebviewNoteAskMessage
    | WebviewNoteCancelMessage
    | WebviewNotesSaveMessage
    | WebviewFileUploadMessage
    | WebviewToggleLayoutModeMessage
    | WebviewSelectionMessage;

// ===== Extension Host → Webview =====

/** The document as it is now: sent when the webview is ready, and again after the two sides lost track. */
export interface HostInitMessage {
    type: 'init';
    epoch: number;
    version: number;
    /** The document's text, line breaks as "\n". */
    text: string;
    /** The document's folder as a webview URI, for relative image paths. */
    baseUri?: string;
    /** Notes kept for this document; only on the first init (a resync keeps the notes already open). */
    notes?: unknown[];
}

/** Changes to the document, numbered from `version`: the webview's own, confirmed, and everyone else's. */
export interface HostUpdatesMessage {
    type: 'updates';
    epoch: number;
    version: number;
    updates: WireUpdate[];
}

/** Whether a push was written. When it was not, the webview rebases over the updates it receives and pushes again. */
export interface HostPushResultMessage {
    type: 'push-result';
    epoch: number;
    ok: boolean;
}

/** What the agent is doing right now, in a few words. */
export interface HostNoteProgressMessage {
    type: 'note-progress';
    requestId: string;
    step: string;
}

export interface HostNoteDoneMessage {
    type: 'note-done';
    requestId: string;
    /** The answer, Markdown. */
    reply: string;
    /** A rewrite of the whole scope, when the writer asked for changes. Never applied by the host. */
    replacement?: string;
    agent: string;
    seconds: number;
}

export interface HostNoteErrorMessage {
    type: 'note-error';
    requestId: string;
    message: string;
}

export interface HostFileUploadedMessage {
    type: 'file-uploaded';
    uploadId: string;
    /** Relative to the document, as the Markdown link should read. */
    relativePath: string;
    isImage: boolean;
    fileName: string;
}

export interface HostFileUploadErrorMessage {
    type: 'file-upload-error';
    uploadId: string;
    message: string;
}

export interface HostSetLayoutModeMessage {
    type: 'set-layout-mode';
    mode: LayoutMode;
}

/** A short notice for the writer (e.g. an upload or save that failed). */
export interface HostNoticeMessage { type: 'notice'; message: string; }

export type HostMessage =
    | HostInitMessage
    | HostUpdatesMessage
    | HostPushResultMessage
    | HostNoteProgressMessage
    | HostNoteDoneMessage
    | HostNoteErrorMessage
    | HostNoticeMessage
    | HostFileUploadedMessage
    | HostFileUploadErrorMessage
    | HostSetLayoutModeMessage;
