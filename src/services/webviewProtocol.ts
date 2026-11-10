/**
 * Webview ↔ Extension Host 消息协议类型定义
 */

// ===== Webview → Extension Host =====

export interface WebviewReadyMessage {
    type: 'ready';
}

export interface WebviewEditMetadata {
    revision: number;
    editVersion: number;
}

export interface EditorDocumentStats {
    words: number;
    characters: number;
    lines: number;
    selectedWords: number;
}

export interface WebviewStatsMessage {
    type: 'document-stats';
    stats: EditorDocumentStats;
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

export interface WebviewSaveMessage extends WebviewEditMetadata {
    type: 'save';
    content: string;
    frontmatter: string;
    flushId?: string;
}

export interface WebviewOpenFileMessage {
    type: 'open-file';
}

export interface WebviewNewFileMessage {
    type: 'new-file';
}

export interface WebviewDirtyMessage extends WebviewEditMetadata {
    type: 'dirty';
    isDirty: boolean;
}

export interface WebviewAutoSaveMessage extends WebviewEditMetadata {
    type: 'auto-save';
    content: string;
    frontmatter: string;
    flushId?: string;
}

export interface WebviewDraftMessage extends WebviewEditMetadata {
    type: 'document-change';
    content: string;
    frontmatter: string;
}

export interface WebviewFileUploadMessage {
    type: 'file-upload';
    uploadId: string;
    fileName: string;
    mimeType: string;
    dataBase64: string;
}

export interface WebviewConflictResolveMessage {
    type: 'conflict-resolve';
    choice: 'reload' | 'keep';
    revision: number;
    conflictId: number;
}

/** Zen: centered, distraction-free writing and reading. Editor: full width with line numbers and frontmatter. */
export type LayoutMode = 'zen' | 'editor';

export interface WebviewToggleLayoutModeMessage {
    type: 'toggle-layout-mode';
}

/** Reply to 'request-save' when nothing changed since load — no write needed. */
export interface WebviewFlushNoopMessage {
    type: 'flush-noop';
    flushId: string;
    revision: number;
}

export interface WebviewReloadAppliedMessage {
    type: 'reload-applied';
    reloadId: number;
    revision: number;
}

export interface WebviewReloadRejectedMessage extends WebviewEditMetadata {
    type: 'reload-rejected';
    reloadId: number;
    content: string;
    frontmatter: string;
}

export interface WebviewFlushFailedMessage {
    type: 'flush-failed';
    flushId: string;
}

export type WebviewMessage =
    | WebviewReadyMessage
    | WebviewNoteAskMessage
    | WebviewNoteCancelMessage
    | WebviewNotesSaveMessage
    | WebviewSaveMessage
    | WebviewOpenFileMessage
    | WebviewNewFileMessage
    | WebviewDirtyMessage
    | WebviewAutoSaveMessage
    | WebviewDraftMessage
    | WebviewFileUploadMessage
    | WebviewConflictResolveMessage
    | WebviewToggleLayoutModeMessage
    | WebviewFlushNoopMessage
    | WebviewFlushFailedMessage
    | WebviewReloadAppliedMessage
    | WebviewReloadRejectedMessage
    | WebviewStatsMessage;

// ===== Extension Host → Webview =====

export interface HostLoadMessage {
    type: 'load';
    content: string;
    frontmatter?: string;
    filePath?: string;
    baseUri?: string;
    revision: number;
    reloadId?: number;
    previousRevision?: number;
    expectedEditVersion?: number;
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

/** Notes saved for this document earlier; sent once after each fresh load. */
export interface HostNotesLoadMessage {
    type: 'notes-load';
    notes: unknown[];
}

export interface HostSavedMessage {
    type: 'saved';
    success: boolean;
    filePath?: string;
    revision: number;
    editVersion: number;
    content?: string;
    message?: string;
}

export interface HostThemeMessage {
    type: 'theme';
    kind: 'light' | 'dark' | 'highContrast';
}

export interface HostFileUploadedMessage {
    type: 'file-uploaded';
    uploadId: string;
    webviewUri: string;
    relativePath: string;
    isImage: boolean;
    fileName: string;
}

export interface HostFileUploadErrorMessage {
    type: 'file-upload-error';
    uploadId: string;
    message: string;
}

export interface HostConflictMessage {
    type: 'conflict';
    conflictId: number;
    revision: number;
}

export interface HostRebaseMessage {
    type: 'rebase';
    revision: number;
}

export interface HostSetLayoutModeMessage {
    type: 'set-layout-mode';
    mode: LayoutMode;
}

export interface HostRequestSaveMessage {
    type: 'request-save';
    flushId: string;
    freeze?: boolean;
}

export interface HostEditUnlockMessage { type: 'edit-unlock'; flushId?: string; }

/** Status-only notice (e.g. the file became unreadable); never settles a pending save. */
export interface HostNoticeMessage { type: 'notice'; message: string; }

export type HostMessage =
    | HostLoadMessage
    | HostNoteProgressMessage
    | HostNoteDoneMessage
    | HostNoteErrorMessage
    | HostNotesLoadMessage
    | HostSavedMessage
    | HostNoticeMessage
    | HostThemeMessage
    | HostFileUploadedMessage
    | HostFileUploadErrorMessage
    | HostConflictMessage
    | HostSetLayoutModeMessage
    | HostRequestSaveMessage
    | HostEditUnlockMessage
    | HostRebaseMessage;
