import { ChangeSet, type EditorState, type Extension, type Range, StateEffect, StateField, Text as DocText } from '@codemirror/state';
import { BlockType, Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType, type BlockInfo as LineBlock } from '@codemirror/view';
import { buildSequence, changeItems, changeRatio, diffText, locate, type BlockInfo, type SeqItem, type TextSeg } from '../../src/core/blockDiff';
import type { HostMessage, NoteTurnWire, WebviewMessage } from '../../src/services/webviewProtocol';
import {
    lastProposalTurn, type AiTurn, type Mark, type Note, type NoteActions, type Proposal,
    type ProposalSummary, type Scope, type StoredNote, type StoredTurn,
} from './notes-model';
import { NotesView, type NotesSurface } from './notes-view';
import { blockIndexAt, blocksOf, headingText, parseBlocks, type MdBlock } from './blocks';
import { resolveUrl } from './live-preview';
import { renderMarkdown } from './md-render';

/**
 * Margin notes in the editor (model: notes-model, UI: notes-view, block diff:
 * src/core/blockDiff). The document is the Markdown source itself.
 *
 * A note covers whole top-level blocks, tracked by the start offsets of its
 * first and last block. Everything a note shows is decorations; the source
 * changes only when the writer accepts a change, as one undoable transaction
 * that replaces the affected blocks' Markdown.
 */

export interface NotesHost {
    post(message: WebviewMessage): void;
}

interface Place { id: string; from: number; last: number }
interface Anchor { index: number; texts: string[]; count: number }

/** A rewrite that changes more than this share of a block is shown old-above-new instead of inline. */
const STACK_RATIO = 0.3;

/** Asks the notes field to rebuild; `place` sets exactly which blocks a note covers after our own edit. */
const refreshEffect = StateEffect.define<{ place?: Place }>();

let host: NotesHost;
let view: EditorView | undefined;
let ui: NotesView | undefined;
let notes: Note[] = [];
let marks: Mark[] = [];
const previews = new Map<string, HTMLElement>();
let usedPreviews = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const anchors = new Map<string, Anchor>();

// ---- Blocks ----

/** The blocks a note covers: those starting from its first block through its last. */
const covered = (blocks: MdBlock[], note: { from: number; last: number }): MdBlock[] =>
    blocks.filter(block => block.from >= note.from && block.from <= note.last);

/** Start of the last block of the section a heading opens. */
function sectionLast(blocks: MdBlock[], index: number): number {
    const level = blocks[index].level;
    let last = index;
    while (last + 1 < blocks.length) {
        const next = blocks[last + 1];
        if (next.type === 'heading' && next.level <= level) { break; }
        last++;
    }
    return blocks[last].from;
}

/** Keep a note on whole top-level blocks after the document changed under it. */
function normalize(note: Note, blocks: MdBlock[]): void {
    if (!blocks.length) { note.from = note.last = 0; return; }
    const snap = (pos: number): number => {
        const index = blockIndexAt(blocks, pos);
        if (index >= 0) { return blocks[index].from; }
        return (blocks.find(block => block.from > pos) ?? blocks[blocks.length - 1]).from;
    };
    note.from = snap(note.from);
    note.last = Math.max(snap(note.last), note.from);
    if (note.scope === 'section') {
        const index = blockIndexAt(blocks, note.from);
        if (blocks[index]?.type === 'heading') { note.last = sectionLast(blocks, index); }
        else { note.scope = 'block'; note.last = note.from; }
    }
}

// ---- What the notes show over the document ----

/** Mark the text the rewrite adds, inside an already rendered block. */
export function highlightInsertions(root: HTMLElement, before: string, after: string): void {
    const ranges: Array<[number, number]> = [];
    let offset = 0;
    for (const seg of diffText(before, after)) {
        if (seg.t === '+') { ranges.push([offset, offset + seg.s.length]); }
        if (seg.t !== '-') { offset += seg.s.length; }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Array<{ node: Text; start: number }> = [];
    let length = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        texts.push({ node: node as Text, start: length });
        length += (node as Text).data.length;
    }
    if (length !== after.length) { return; }   // rendered text differs from what was compared: leave it unmarked
    for (let t = texts.length - 1; t >= 0; t--) {
        const { node, start } = texts[t], end = start + node.data.length;
        for (let r = ranges.length - 1; r >= 0; r--) {
            const from = Math.max(ranges[r][0], start), to = Math.min(ranges[r][1], end);
            if (from >= to) { continue; }
            node.splitText(to - start);
            const added = node.splitText(from - start);
            const span = document.createElement('span');
            span.className = 'bb-ins';
            added.replaceWith(span);
            span.append(added);
        }
    }
}

/** For a single rewritten block: how many characters go and how many come. */
export function charCounts(before: string, after: string): { del: number; ins: number } {
    let del = 0, ins = 0;
    for (const seg of diffText(before, after)) {
        const size = [...seg.s.replace(/￼/g, '')].length;
        if (seg.t === '-') { del += size; } else if (seg.t === '+') { ins += size; }
    }
    return { del, ins };
}

class NoteWidget extends WidgetType {
    constructor(readonly note: Note) { super(); }
    eq(other: NoteWidget): boolean { return other.note === this.note; }
    toDOM(): HTMLElement { return this.note.el; }
    ignoreEvent(): boolean { return true; }
}

/** A proposed block, rendered; kept by id so it is not rebuilt on every keystroke. */
class PreviewWidget extends WidgetType {
    constructor(readonly id: string, readonly el: HTMLElement) { super(); }
    eq(other: PreviewWidget): boolean { return other.id === this.id && other.el === this.el; }
    toDOM(): HTMLElement { return this.el; }
    ignoreEvent(): boolean { return true; }
}

class InsertionWidget extends WidgetType {
    constructor(readonly text: string) { super(); }
    eq(other: InsertionWidget): boolean { return other.text === this.text; }
    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'bb-ins';
        span.textContent = this.text;
        return span;
    }
}

function preview(id: string, make: () => HTMLElement): HTMLElement {
    usedPreviews.add(id);
    let element = previews.get(id);
    if (!element) { element = make(); previews.set(id, element); }
    return element;
}

function rendered(state: EditorState, markdown: string, cls: string): HTMLElement {
    const box = document.createElement('div');
    box.className = `bb-preview bb-md ${cls}`;
    box.contentEditable = 'false';
    box.append(renderMarkdown(markdown, url => resolveUrl(state, url)));
    return box;
}

function inlineDecorations(segs: TextSeg[], start: number, out: Range<Decoration>[]): void {
    let offset = 0;
    for (const seg of segs) {
        if (seg.t === '=') { offset += seg.s.length; continue; }
        if (seg.t === '-') {
            out.push(Decoration.mark({ class: 'bb-del' }).range(start + offset, start + offset + seg.s.length));
            offset += seg.s.length;
            continue;
        }
        if (seg.s) { out.push(Decoration.widget({ widget: new InsertionWidget(seg.s), side: -1 }).range(start + offset)); }
    }
}

function lineDecorations(state: EditorState, block: MdBlock, cls: string, out: Range<Decoration>[]): void {
    const first = state.doc.lineAt(block.from).number, last = state.doc.lineAt(block.to).number;
    for (let n = first; n <= last; n++) { out.push(Decoration.line({ class: cls }).range(state.doc.line(n).from)); }
}

function buildNote(note: Note, order: number, state: EditorState, blocks: MdBlock[], out: Range<Decoration>[]): void {
    const section = note.scope === 'section';
    const scoped = covered(blocks, note);
    const head = scoped[0], tail = scoped[scoped.length - 1];
    const cardPos = !head ? 0 : section ? head.to : tail.to;
    out.push(Decoration.widget({ widget: new NoteWidget(note), block: true, side: 1 + order * 0.001 }).range(cardPos));

    const turn = lastProposalTurn(note);
    if (!turn?.proposal || !head) { note.summary = undefined; return; }
    const { seq, basis, target } = turn.proposal;
    const placed = locate(seq, basis, target, scoped.map(block => block.info));
    const items = changeItems(seq);
    const pending = items.filter(i => seq[i].state === 'pending' && placed.has(i));
    const summary: ProposalSummary = {
        total: items.length, pending,
        stale: items.filter(i => seq[i].state === 'pending' && !placed.has(i)).length,
        accepted: items.filter(i => seq[i].state === 'accepted').length,
        rejected: items.filter(i => seq[i].state === 'rejected').length,
        kinds: {
            mod: pending.filter(i => seq[i].kind === 'mod').length, add: pending.filter(i => seq[i].kind === 'add').length,
            del: pending.filter(i => seq[i].kind === 'del').length, move: pending.filter(i => seq[i].kind === 'to').length,
        },
    };
    if (items.length === 1 && pending.length === 1 && seq[pending[0]].kind === 'mod') {
        summary.chars = charCounts(basis[seq[pending[0]].old!].text, target[seq[pending[0]].new!].text);
    }
    note.summary = summary;
    if (!(note.open && note.lens)) { return; }

    const turnIndex = note.thread.indexOf(turn), multi = items.length > 1;
    const mark = (m: Omit<Mark, 'note'>): void => { marks.push({ ...m, note }); };
    const widget = (pos: number, element: HTMLElement, id: string, side: number): void => {
        out.push(Decoration.widget({ widget: new PreviewWidget(id, element), block: true, side }).range(pos));
    };

    for (const index of pending) {
        const item = seq[index], place = placed.get(index)!, id = `${note.id}:${turnIndex}:${index}`;
        const next = item.new === undefined ? undefined : target[item.new].text;
        // A new block goes before the block it precedes, or after the note's last block —
        // before the card of a block note, after the card of a section note (which hangs under its heading).
        const insert = (element: HTMLElement): void => {
            const before = place.insertAt === undefined ? undefined : scoped[place.insertAt];
            if (before) { widget(before.from, element, id, -1 + index * 0.0001); }
            else { widget(tail.to, element, id, (section ? 2 : 0.6) + index * 0.0001); }
        };

        if (item.kind === 'mod' && next !== undefined) {
            const old = scoped[place.at!];
            const segs = diffText(old.info.text, next);
            if (changeRatio(segs) <= STACK_RATIO) {
                inlineDecorations(segs, old.from, out);
                lineDecorations(state, old, 'bb-d bb-d-mod', out);
                mark({ key: id, item: index, sign: '~', tone: 'mod', pos: old.from, controls: multi });
                continue;
            }
            const row = preview(`${id}:new`, () => {
                const box = rendered(state, next, 'bb-d-new');
                const before = document.createElement('div');
                before.append(renderMarkdown(old.info.text));
                highlightInsertions(box, before.textContent ?? '', box.textContent ?? '');
                return box;
            });
            lineDecorations(state, old, 'bb-d bb-d-old', out);
            widget(old.to, row, `${id}:new`, 0.5);
            mark({ key: `${id}:old`, item: index, sign: '−', tone: 'del', pos: old.from, controls: multi });
            mark({ key: `${id}:new`, sign: '+', tone: 'add', el: row, controls: false });
        } else if (item.kind === 'del') {
            const old = scoped[place.at!];
            lineDecorations(state, old, 'bb-d bb-d-del', out);
            mark({ key: id, item: index, sign: '−', tone: 'del', pos: old.from, controls: multi });
        } else if (item.kind === 'add' && next !== undefined) {
            const row = preview(id, () => rendered(state, next, 'bb-d-add'));
            insert(row);
            mark({ key: id, item: index, sign: '+', tone: 'add', el: row, controls: multi });
        } else if (item.kind === 'to' && next !== undefined) {
            const source = scoped[place.at!];
            const row = preview(id, () => rendered(state, next, 'bb-d-to'));
            insert(row);
            lineDecorations(state, source, 'bb-d bb-d-from', out);
            mark({ key: id, item: index, sign: '⤷', tone: 'mod', el: row, controls: multi });
            mark({ key: `${id}:from`, sign: item.dir === 'up' ? '↑' : '↓', tone: 'mod', pos: source.from, controls: false });
        }
    }
}

function build(state: EditorState): DecorationSet {
    marks = [];
    usedPreviews = new Set();
    if (notes.length) {
        const blocks = blocksOf(state);
        const out: Range<Decoration>[] = [];
        notes.forEach((note, order) => buildNote(note, order, state, blocks, out));
        for (const id of [...previews.keys()]) { if (!usedPreviews.has(id)) { previews.delete(id); } }
        return Decoration.set(out, true);
    }
    previews.clear();
    return Decoration.none;
}

/** Note cards and proposal previews are block widgets, so they come from a state field. */
const notesField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(set, tr) {
        let refresh = false, place: Place | undefined;
        for (const effect of tr.effects) {
            if (effect.is(refreshEffect)) { refresh = true; place = effect.value.place ?? place; }
        }
        if (tr.docChanged && notes.length) {
            const blocks = blocksOf(tr.state);
            for (const note of notes) {
                if (place?.id === note.id) { note.from = place.from; note.last = place.last; }
                else {
                    // Following the block's start keeps a new paragraph typed before the note's block out of it.
                    note.from = tr.changes.mapPos(note.from, 1);
                    note.last = tr.changes.mapPos(note.last, 1);
                }
                normalize(note, blocks);
            }
        }
        return tr.docChanged || refresh ? build(tr.state) : set;
    },
    provide: field => EditorView.decorations.from(field),
});

/** After a state update: hand the gutters their marks and repaint notes whose proposal status moved. */
function afterUpdate(): void {
    if (!ui) { return; }
    ui.setMarks(marks);
    for (const note of notes) {
        const summaryKey = JSON.stringify(note.summary ?? null);
        if (summaryKey !== note.summaryKey) { note.summaryKey = summaryKey; render(note); }
    }
}

const notesPlugin = ViewPlugin.define(() => ({
    update(update) {
        afterUpdate();
        if (update.geometryChanged || update.viewportChanged) { ui?.requestMeasure(); }
    },
}));

/** Repaint a note's line / card; its height may change, so the editor measures again. */
function render(note: Note): void {
    ui?.render(note);
    view?.requestMeasure();
}

function refresh(): void {
    view?.dispatch({ effects: refreshEffect.of({}) });
}

function changed(note: Note): void {
    render(note);
    refresh();
    saveSoon();
}

// ---- Applying a proposal ----

function setState(seq: SeqItem[], index: number, state: SeqItem['state']): void {
    seq[index].state = state;
    const twin = seq[index].link;
    if (twin !== undefined) { seq[twin].state = state; }
}

interface Edit { from: number; to: number; insert: string }

/** Remove a block with the blank lines that separated it from its neighbour. */
function removal(blocks: MdBlock[], block: MdBlock): Edit {
    const index = blocks.indexOf(block), next = blocks[index + 1], prev = blocks[index - 1];
    if (next) { return { from: block.from, to: next.from, insert: '' }; }
    if (prev) { return { from: prev.to, to: block.to, insert: '' }; }
    return { from: block.from, to: block.to, insert: '' };
}

/**
 * Apply the given items as one edit (one undo step). Items are applied one by
 * one to the source text, each located again in the text as it is after the
 * previous one; items whose block changed since are skipped.
 */
function applyItems(note: Note, indices: number[]): void {
    const proposal = lastProposalTurn(note)?.proposal;
    if (!view || !proposal) { return; }
    let text = view.state.doc.toString();
    let blocks = blocksOf(view.state);
    let changes = ChangeSet.empty(text.length);
    const start = covered(blocks, note);
    // The note's region, followed through each edit: blocks starting inside it are the note's blocks.
    let regionFrom = start[0]?.from ?? note.from, regionTo = start[start.length - 1]?.to ?? note.from;

    for (const index of indices) {
        const item = proposal.seq[index];
        if (item.state !== 'pending') { continue; }
        const scoped = blocks.filter(block => block.from >= regionFrom && block.from < regionTo);
        const place = locate(proposal.seq, proposal.basis, proposal.target, scoped.map(block => block.info)).get(index);
        if (!place) { continue; }
        const markdown = item.new === undefined ? '' : proposal.target[item.new].text;
        const source = place.at === undefined ? undefined : scoped[place.at];
        const insertion = (): Edit | undefined => {
            if (place.insertAt === undefined) { return undefined; }
            const before = scoped[place.insertAt];
            if (before) { return { from: before.from, to: before.from, insert: `${markdown}\n\n` }; }
            const last = scoped[scoped.length - 1];
            return last ? { from: last.to, to: last.to, insert: `\n\n${markdown}` } : { from: regionFrom, to: regionFrom, insert: `${markdown}\n\n` };
        };
        const edits: Edit[] = [];
        if (item.kind === 'mod' && source) { edits.push({ from: source.from, to: source.to, insert: markdown }); }
        else if (item.kind === 'del' && source) { edits.push(removal(blocks, source)); }
        else if (item.kind === 'add') { const edit = insertion(); if (edit) { edits.push(edit); } }
        else if (item.kind === 'to' && source) {
            const edit = insertion();
            if (edit) { edits.push(edit); }
            edits.push(removal(blocks, source));
        }
        if (!edits.length) { continue; }

        edits.sort((a, b) => a.from - b.from || a.to - b.to);
        const step = ChangeSet.of(edits, text.length);
        regionFrom = step.mapPos(regionFrom, -1);
        regionTo = step.mapPos(regionTo, 1);
        text = step.apply(DocText.of(text.split('\n'))).toString();
        changes = changes.compose(step);
        blocks = parseBlocks(text);
        setState(proposal.seq, index, 'accepted');
    }

    if (!changes.empty) {
        const after = blocks.filter(block => block.from >= regionFrom && block.from < regionTo);
        const place: Place = after.length
            ? { id: note.id, from: after[0].from, last: after[after.length - 1].from }
            : { id: note.id, from: regionFrom, last: regionFrom };
        view.dispatch({ changes, effects: refreshEffect.of({ place }), userEvent: 'input.note' });
    }
    changed(note);
}

// ---- Asking and answers ----

/** Each kind of block is named by the sign Markdown itself uses for it. */
const SIGN: Record<string, string> = {
    paragraph: '¶', bullet_list: '-', ordered_list: '1.', code_block: '```', blockquote: '>', table: '|', hr: '---', html: '<>',
};

function scopeOf(blocks: MdBlock[], firstIndex: number, lastIndex: number, quote: string): Scope | null {
    if (!blocks.length) { return null; }
    const first = Math.min(Math.max(firstIndex, 0), blocks.length - 1), last = Math.min(Math.max(lastIndex, first), blocks.length - 1);
    const block = blocks[first];
    if (first !== last) {
        const tag = `¶×${last - first + 1}`;
        return { kind: 'range', from: block.from, last: blocks[last].from, quote: '', chip: tag, tag };
    }
    if (quote) { return { kind: 'block', from: block.from, last: block.from, quote, chip: `“${quote}”`, tag: '' }; }
    if (block.type === 'heading') {
        const tag = '#'.repeat(block.level);
        return { kind: 'section', from: block.from, last: sectionLast(blocks, first), quote: '', chip: `${tag} ${headingText(block)}`, tag };
    }
    return { kind: 'block', from: block.from, last: block.from, quote: '', chip: SIGN[block.type] ?? '¶', tag: '' };
}

/** A paragraph asks about itself, a heading about its whole section, a selection across blocks about those blocks. */
function scopeFromSelection(state: EditorState): Scope | null {
    const blocks = blocksOf(state);
    if (!blocks.length) { return null; }
    const { from, to, empty } = state.selection.main;
    let first = blocks.findIndex(block => block.to >= from);
    if (first < 0) { first = blocks.length - 1; }
    let last = first;
    for (let i = first; i < blocks.length && blocks[i].from <= to; i++) { last = i; }
    // A selection that ends at the very start of a block does not include that block.
    if (!empty && last > first && blocks[last].from >= to) { last--; }
    const quote = !empty && first === last ? state.sliceDoc(from, to).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    return scopeOf(blocks, first, last, quote);
}

function newNote(scope: Scope): Note {
    const el = document.createElement('div');
    el.contentEditable = 'false';
    return {
        id: crypto.randomUUID(), scope: scope.kind, from: scope.from, last: scope.last, quote: scope.quote, tag: scope.tag,
        thread: [], status: 'done', step: '', startedAt: 0, error: '', requestId: '', askBasis: [],
        unread: false, open: false, lens: false, el, summaryKey: 'null',
    };
}

/** Send the note's latest question, with the blocks it is about exactly as they are now — their Markdown, verbatim. */
function run(note: Note): void {
    if (!view) { return; }
    const scoped = covered(blocksOf(view.state), note);
    const mine = note.thread.filter(turn => turn.role === 'me');
    const earlier = note.thread.slice(0, note.thread.lastIndexOf(mine[mine.length - 1]));
    const history: NoteTurnWire[] = earlier.map(turn => (turn.role === 'me'
        ? { role: 'me', text: turn.text }
        : { role: 'ai', text: turn.markdown + (turn.proposal ? '\n（当时附了一份修改稿）' : '') }));
    note.status = 'working';
    note.step = '…';
    note.error = '';
    note.startedAt = Date.now();
    note.requestId = crypto.randomUUID();
    note.askBasis = scoped.map(block => block.info);
    const scopeMarkdown = scoped.length ? view.state.sliceDoc(scoped[0].from, scoped[scoped.length - 1].to) : '';
    host.post({
        type: 'note-ask', requestId: note.requestId, question: mine[mine.length - 1].text, scopeKind: note.scope,
        scopeMarkdown, quote: note.quote || undefined, history,
    });
    changed(note);
}

function proposalFrom(basis: BlockInfo[], replacement: string, seq?: SeqItem[]): Proposal | undefined {
    const target = parseBlocks(replacement).map(block => block.info);
    const sequence = seq ?? buildSequence(basis, target);
    return changeItems(sequence).length ? { basis, replacement, seq: sequence, target } : undefined;
}

export function handleNoteMessage(message: HostMessage): void {
    if (message.type !== 'note-progress' && message.type !== 'note-done' && message.type !== 'note-error') { return; }
    const note = notes.find(candidate => candidate.requestId === message.requestId && candidate.status === 'working');
    if (!note) { return; }
    if (message.type === 'note-progress') {
        note.step = message.step;
        ui?.updateStep(note);
        return;
    }
    if (message.type === 'note-error') {
        note.status = 'error';
        note.error = message.message;
    } else {
        const turn: AiTurn = { role: 'ai', markdown: message.reply, agent: message.agent, seconds: message.seconds };
        if (message.replacement !== undefined) { turn.proposal = proposalFrom(note.askBasis, message.replacement); }
        note.thread.push(turn);
        note.status = 'done';
        // Never swap blocks under the writer's cursor: an open note offers "±" instead.
        note.lens = false;
    }
    // Arrives silently: only the note's own line changes.
    note.unread = !note.open;
    changed(note);
}

function overlaps(a: Note, b: Note): boolean { return a.from <= b.last && b.from <= a.last; }

const actions: NoteActions = {
    toggle(note, open) {
        note.open = open ?? !note.open;
        if (note.open) {
            note.unread = false;
            actions.showChanges(note);
            return;
        }
        changed(note);
    },
    showChanges(note) {
        note.lens = true;
        // Two notes must not paint changes over the same blocks at once.
        for (const other of notes) {
            if (other !== note && other.lens && other.open && overlaps(note, other)) { other.lens = false; render(other); }
        }
        changed(note);
    },
    ask(scope, question) {
        const note = newNote(scope);
        note.thread.push({ role: 'me', text: question });
        notes.push(note);
        run(note);
    },
    followUp(note, text) {
        note.thread.push({ role: 'me', text });
        run(note);
    },
    retry(note) { run(note); },
    cancel(note) {
        host.post({ type: 'note-cancel', requestId: note.requestId });
        const lastTurn = note.thread[note.thread.length - 1];
        if (lastTurn?.role === 'me') { note.thread.pop(); }
        if (!note.thread.length) { actions.resolve(note); return; }
        note.status = 'done';
        changed(note);
    },
    resolve(note) {
        if (note.status === 'working') { host.post({ type: 'note-cancel', requestId: note.requestId }); }
        notes = notes.filter(candidate => candidate !== note);
        ui?.remove(note);
        refresh();
        saveSoon();
    },
    accept(note, item) {
        applyItems(note, item === undefined ? note.summary?.pending ?? [] : [item]);
    },
    reject(note, item) {
        const proposal = lastProposalTurn(note)?.proposal;
        if (!proposal) { return; }
        for (const index of item === undefined ? note.summary?.pending ?? [] : [item]) { setState(proposal.seq, index, 'rejected'); }
        changed(note);
    },
    review(note) {
        const proposal = lastProposalTurn(note)?.proposal;
        if (!proposal) { return; }
        proposal.seq.forEach((item, index) => { if (item.state === 'rejected') { setState(proposal.seq, index, 'pending'); } });
        actions.showChanges(note);
    },
    renderMarkdown(markdown) {
        const state = view?.state;
        const fragment = renderMarkdown(markdown, url => (state ? resolveUrl(state, url) : url));
        return fragment;
    },
    scopeForBlock(pos) {
        if (!view) { return null; }
        const blocks = blocksOf(view.state), index = blockIndexAt(blocks, pos);
        return index < 0 ? null : scopeOf(blocks, index, index, '');
    },
    focusEditor() { view?.focus(); },
};

/** ⌘B ⌘B: ask about wherever the caret or selection is. */
export function openAskAtSelection(): void {
    if (!view || !ui || !view.state.facet(EditorView.editable)) { return; }
    const scope = scopeFromSelection(view.state);
    if (scope) { ui.openAsk(scope); }
}

// ---- Keeping notes across reloads and sessions ----

const clipText = (text: string): string => text.slice(0, 160);

function anchorOf(note: Note, blocks: MdBlock[]): Anchor {
    const scoped = covered(blocks, note);
    return { index: Math.max(0, blockIndexAt(blocks, note.from)), texts: scoped.slice(0, 3).map(block => clipText(block.info.text)), count: scoped.length };
}

/** Find a note's blocks again by what they say, falling back to where they were. */
function reanchor(note: Note, anchor: Anchor, blocks: MdBlock[]): void {
    let best = -1;
    blocks.forEach((block, index) => {
        if (clipText(block.info.text) === anchor.texts[0] && (best < 0 || Math.abs(index - anchor.index) < Math.abs(best - anchor.index))) { best = index; }
    });
    if (!blocks.length) { note.from = note.last = 0; return; }
    const first = best >= 0 ? best : Math.min(anchor.index, blocks.length - 1);
    note.from = blocks[first].from;
    note.last = blocks[Math.min(first + Math.max(anchor.count, 1) - 1, blocks.length - 1)].from;
    normalize(note, blocks);
}

/** Called around a document (re)load: positions are meaningless across it, block text is not. */
export function beforeDocumentLoad(): void {
    anchors.clear();
    if (!view) { return; }
    const blocks = blocksOf(view.state);
    for (const note of notes) { anchors.set(note.id, anchorOf(note, blocks)); }
}

export function afterDocumentLoad(): void {
    if (!view) { return; }
    const blocks = blocksOf(view.state);
    for (const note of notes) {
        const anchor = anchors.get(note.id);
        if (anchor) { reanchor(note, anchor, blocks); }
    }
    refresh();
}

function saveSoon(): void {
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = setTimeout(() => {
        if (!view) { return; }
        const blocks = blocksOf(view.state);
        const stored: StoredNote[] = notes.map(note => ({
            id: note.id, scope: note.scope, quote: note.quote, tag: note.tag, unread: note.unread, ...anchorOf(note, blocks),
            thread: note.thread.map((turn): StoredTurn => (turn.role === 'me'
                ? { role: 'me', text: turn.text }
                : {
                    role: 'ai', text: turn.markdown, agent: turn.agent, seconds: turn.seconds,
                    proposal: turn.proposal && { basis: turn.proposal.basis, replacement: turn.proposal.replacement, seq: turn.proposal.seq },
                })),
        }));
        host.post({ type: 'notes-save', notes: stored });
    }, 400);
}

const isStored = (value: unknown): value is StoredNote => typeof value === 'object' && value !== null
    && typeof (value as StoredNote).id === 'string' && Array.isArray((value as StoredNote).thread)
    && Array.isArray((value as StoredNote).texts);

/** Bring back the notes kept for this document. Notes already live in this editor stay as they are. */
export function restoreNotes(stored: unknown[]): void {
    if (!view) { return; }
    const blocks = blocksOf(view.state);
    const kept = new Map(notes.map(note => [note.id, note]));
    const next: Note[] = [];
    for (const item of stored.filter(isStored)) {
        const live = kept.get(item.id);
        if (live) { next.push(live); kept.delete(item.id); continue; }
        const note = newNote({ kind: item.scope, from: 0, last: 0, quote: item.quote ?? '', chip: '', tag: item.tag ?? '' });
        note.id = item.id;
        note.unread = !!item.unread;
        note.thread = item.thread.map(turn => {
            if (turn.role === 'me') { return { role: 'me', text: turn.text }; }
            const answer: AiTurn = { role: 'ai', markdown: turn.text, agent: turn.agent ?? '', seconds: turn.seconds ?? 0 };
            if (turn.proposal) { answer.proposal = proposalFrom(turn.proposal.basis, turn.proposal.replacement, turn.proposal.seq); }
            return answer;
        });
        if (!note.thread.length) { continue; }
        if (note.thread[note.thread.length - 1].role === 'me') {
            note.status = 'error';
            note.error = '…';
        }
        reanchor(note, item, blocks);
        next.push(note);
    }
    for (const gone of kept.values()) {
        if (gone.status === 'working') { host.post({ type: 'note-cancel', requestId: gone.requestId }); }
        ui?.remove(gone);
    }
    notes = next;
    notes.forEach(render);
    refresh();
}

// ---- Wiring ----

/** The text part of a line block (a line with block widgets attached is split into parts). */
function textPart(line: LineBlock, pos: number): LineBlock {
    if (!Array.isArray(line.type)) { return line; }
    const parts = line.type as readonly LineBlock[];
    return parts.find(part => (part.type === BlockType.Text || part.type === BlockType.WidgetRange) && part.from <= pos && pos <= part.to) ?? line;
}

/** The note UI's view of this editor: top-level blocks are runs of source lines. */
function surfaceOf(editor: EditorView): NotesSurface {
    return {
        dom: editor.contentDOM,
        get editable() { return editor.state.facet(EditorView.editable); },
        get selectionEmpty() { return editor.state.selection.main.empty; },
        blockAt(clientY) {
            const height = clientY - editor.documentTop;
            if (height < 0 || height > editor.contentHeight) { return null; }
            const line = editor.lineBlockAtHeight(height);
            const parts = Array.isArray(line.type) ? line.type as readonly LineBlock[] : [line];
            const part = parts.find(candidate => height >= candidate.top && height < candidate.bottom) ?? line;
            if (part.type !== BlockType.Text && part.type !== BlockType.WidgetRange) { return null; }
            const blocks = blocksOf(editor.state), index = blockIndexAt(blocks, part.from);
            return index < 0 ? null : blocks[index].from;
        },
        blockBox(pos) {
            const blocks = blocksOf(editor.state), index = blockIndexAt(blocks, pos);
            if (index < 0 || blocks[index].from !== pos) { return null; }
            const block = blocks[index], top = editor.documentTop;
            const first = textPart(editor.lineBlockAt(block.from), block.from), last = textPart(editor.lineBlockAt(block.to), block.to);
            const coords = editor.coordsAtPos(block.from, 1);
            return {
                top: coords && coords.top >= first.top + top - 1 ? coords.top : first.top + top,
                bottom: last.bottom + top,
                line: coords ? coords.bottom - coords.top : editor.defaultLineHeight,
            };
        },
        caretBottom() { return editor.coordsAtPos(editor.state.selection.main.head)?.bottom ?? null; },
    };
}

export function notesExtension(): Extension {
    return [notesField, notesPlugin];
}

/** Start the note UI for an editor; the editor outlives document reloads, so this runs once. */
export function initNotes(editor: EditorView, notesHost: NotesHost): void {
    host = notesHost;
    view = editor;
    ui = new NotesView(surfaceOf(editor), () => notes, actions);
}
