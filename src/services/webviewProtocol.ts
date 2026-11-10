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

export interface WebviewBBRequestMessage {
    type: 'bb-request';
    id: string;
    cmd: string;
    selectText: string;
    msg: string;
}

export interface WebviewBBCancelMessage {
    type: 'bb-cancel';
    id: string;
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

export interface WebviewReaderDispatchMessage extends WebviewEditMetadata {
    type: 'reader-dispatch';
    cmd: string;
    msg: string;
    content: string;   // full Markdown with the render tag already removed
    frontmatter: string;
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
    | WebviewBBRequestMessage
    | WebviewBBCancelMessage
    | WebviewSaveMessage
    | WebviewOpenFileMessage
    | WebviewNewFileMessage
    | WebviewDirtyMessage
    | WebviewAutoSaveMessage
    | WebviewDraftMessage
    | WebviewFileUploadMessage
    | WebviewConflictResolveMessage
    | WebviewReaderDispatchMessage
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

export interface HostChunkMessage {
    type: 'chunk';
    id: string;
    text: string;
    replace?: boolean;
}

export interface HostDoneMessage {
    type: 'done';
    id: string;
    fullText: string;
}

export interface HostErrorMessage {
    type: 'error';
    id: string;
    message: string;
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
    | HostChunkMessage
    | HostDoneMessage
    | HostErrorMessage
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

// ===== Reader Webview ↔ Extension Host =====

// Webview → Host
export interface ReaderReadyMessage { type: 'reader-ready'; }
export interface ReaderRegenerateMessage {
    type: 'reader-regenerate';
    userPrompt?: string;   // if present, replaces the current prompt before regen
}
export interface ReaderExportMessage { type: 'reader-export'; }

export type ReaderWebviewMessage =
    | ReaderReadyMessage
    | ReaderRegenerateMessage
    | ReaderExportMessage;

// Host → Webview
export interface ReaderInitMessage {
    type: 'reader-init';
    sourceFileName: string;        // basename for the title bar
    preset: string;                // human-readable preset name (e.g. "Blog View")
    userPrompt: string;            // empty string if not provided
    baseUri: string;               // webview URI to source's directory (for image rewriting)
    estInputTokens: number;        // heuristic chars/4
    styleReferenceName?: string;   // basename of the loaded .bbreader.md, if any
}
export interface ReaderStartMessage { type: 'reader-start'; }
export interface ReaderChunkMessage { type: 'reader-chunk'; text: string; }
export interface ReaderDoneMessage {
    type: 'reader-done';
    fullHtml: string;
    tokensUsed: number;
    costUsd?: number;
    durationMs: number;
}
export interface ReaderErrorMessage { type: 'reader-error'; message: string; }
export interface ReaderSourceChangedMessage { type: 'reader-source-changed'; }
export interface ReaderSourceClosedMessage { type: 'reader-source-closed'; }
export interface ReaderExportResultMessage {
    type: 'reader-export-result';
    success: boolean;
    filePath?: string;
    error?: string;
}
export interface ReaderThemeMessage {
    type: 'reader-theme';
    kind: 'light' | 'dark' | 'highContrast';
}

export type ReaderHostMessage =
    | ReaderInitMessage
    | ReaderStartMessage
    | ReaderChunkMessage
    | ReaderDoneMessage
    | ReaderErrorMessage
    | ReaderSourceChangedMessage
    | ReaderSourceClosedMessage
    | ReaderExportResultMessage
    | ReaderThemeMessage;
