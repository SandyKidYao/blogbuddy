import type { BlockInfo, SeqItem } from '../../src/core/blockDiff';
import type { NoteScopeKind } from '../../src/services/webviewProtocol';

/**
 * Margin notes: a sentence the writer leaves beside some blocks, the agent's
 * answer, and — when the writer asked for changes — a proposal expressed as
 * block operations. Notes never live in the Markdown file.
 */

/** A rewrite of a note's blocks, waiting for the writer's decision. */
export interface Proposal {
    /** The blocks as they were when the question was asked. */
    basis: BlockInfo[];
    /** The agent's Markdown for those blocks. */
    replacement: string;
    /** Block operations in reading order, each with the writer's decision so far. */
    seq: SeqItem[];
    /** The rewrite's blocks; a block's `text` is its Markdown. */
    target: BlockInfo[];
}

export interface MeTurn { role: 'me'; text: string }
export interface AiTurn { role: 'ai'; markdown: string; agent: string; seconds: number; proposal?: Proposal }
export type Turn = MeTurn | AiTurn;

/** Where a proposal stands against the document as it is now. */
export interface ProposalSummary {
    /** How many decisions the proposal asks for in total. */
    total: number;
    /** Items still undecided that can be applied (indices into `seq`). */
    pending: number[];
    /** Undecided items whose block the writer has edited since. */
    stale: number;
    accepted: number;
    rejected: number;
    kinds: { mod: number; add: number; del: number; move: number };
    /** For a single rewritten block: characters removed and added. */
    chars?: { del: number; ins: number };
}

export interface Note {
    id: string;
    scope: NoteScopeKind;
    /** Start position of the first block the note is about. */
    from: number;
    /** Start position of the last block the note is about. */
    last: number;
    /** Text that was selected inside the block when the note was written. */
    quote: string;
    thread: Turn[];
    status: 'working' | 'done' | 'error';
    step: string;
    startedAt: number;
    error: string;
    requestId: string;
    /** Symbol for a scope wider than one block ("##", "¶×3"); empty for a single block. */
    tag: string;
    /** The scope's blocks when the running question was asked. */
    askBasis: BlockInfo[];
    unread: boolean;
    open: boolean;
    /** Show the proposal's changes over the document. */
    lens: boolean;
    /** The note's line / card, placed in the document flow by a widget decoration. */
    el: HTMLElement;
    summary?: ProposalSummary;
    summaryKey: string;
}

/** What a new note would be about. */
export interface Scope {
    kind: NoteScopeKind;
    from: number;
    last: number;
    quote: string;
    /** Shown in the ask box, in Markdown's own signs: "¶", "## 打断的成本", "-", "¶×3", "“selected words”". */
    chip: string;
    /** The part of the chip kept on the note for a scope wider than one block. */
    tag: string;
}

/** A sign in the left gutter (and, optionally, accept / reject in the right one) beside a changed block. */
export interface Mark {
    key: string;
    note: Note;
    /** Index into the proposal's `seq`; set when the mark carries accept / reject. */
    item?: number;
    /** "~" rewritten · "+" new · "−" removed · "⤷" moved here · "↑" "↓" moved away · "" controls only. */
    sign: string;
    tone: 'add' | 'del' | 'mod';
    /** The block is either a document node (by position) or a preview element. */
    pos?: number;
    el?: HTMLElement;
    controls: boolean;
}

/** Everything the note UI can ask the editor to do. */
export interface NoteActions {
    toggle(note: Note, open?: boolean): void;
    ask(scope: Scope, question: string): void;
    followUp(note: Note, text: string): void;
    retry(note: Note): void;
    cancel(note: Note): void;
    resolve(note: Note): void;
    showChanges(note: Note): void;
    accept(note: Note, item?: number): void;
    reject(note: Note, item?: number): void;
    review(note: Note): void;
    renderMarkdown(markdown: string): DocumentFragment;
    scopeForBlock(pos: number): Scope | null;
    focusEditor(): void;
}

export const lastProposalTurn = (note: Note): AiTurn | undefined =>
    [...note.thread].reverse().find((turn): turn is AiTurn => turn.role === 'ai' && !!turn.proposal);

export const lensOn = (note: Note): boolean => note.open && note.lens && !!note.summary?.pending.length;

// ---- Persistence (kept by the host in extension storage) ----

export interface StoredTurn {
    role: 'me' | 'ai';
    text: string;
    agent?: string;
    seconds?: number;
    proposal?: { basis: BlockInfo[]; replacement: string; seq: SeqItem[] };
}

export interface StoredNote {
    id: string;
    scope: NoteScopeKind;
    /** Index of the first block, and the text of the first blocks, to find the note's place again. */
    index: number;
    texts: string[];
    count: number;
    quote: string;
    tag?: string;
    unread: boolean;
    thread: StoredTurn[];
}
