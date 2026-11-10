import { parserCtx, serializerCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { DOMSerializer, Fragment } from '@milkdown/kit/prose/model';
import type { Node } from '@milkdown/kit/prose/model';
import { buildSequence, changeItems, changeRatio, diffText, locate, type BlockInfo, type SeqItem, type TextSeg } from '../../src/core/blockDiff';
import type { HostMessage, NoteTurnWire, WebviewMessage } from '../../src/services/webviewProtocol';
import { preprocessMarkdown, stripBaseUri } from './markdown-output';
import { NotesView } from './notes-view';
import {
    lastProposalTurn, type AiTurn, type Mark, type Note, type NoteActions, type Proposal,
    type ProposalSummary, type Scope, type StoredNote, type StoredTurn,
} from './notes-model';

/**
 * Margin notes inside the editor.
 *
 * The block is the unit throughout: a note is about whole top-level blocks, an
 * agent's rewrite is compared block by block, and each changed block is
 * accepted or rejected on its own. Nothing a note shows is part of the
 * document — it is all decorations — so the Markdown file only changes when
 * the writer accepts a change, and that change is an ordinary, undoable edit.
 */

export interface NotesHost {
    post(message: WebviewMessage): void;
    baseUri(): string;
}

interface NotesMeta {
    /** Set by our own edits: exactly which blocks the note covers afterwards. */
    place?: { id: string; from: number; last: number };
}

interface Block { node: Node; pos: number; info: BlockInfo }
interface Anchor { index: number; texts: string[]; count: number }

/** A rewrite that changes more than this share of a block is shown old-above-new instead of inline. */
const STACK_RATIO = 0.3;
const LEAF = '￼';

const key = new PluginKey<DecorationSet>('bb-notes');
let host: NotesHost;
let view: EditorView | undefined;
let ui: NotesView | undefined;
let parseMarkdown: (markdown: string) => Node | null = () => null;
let serializeDoc: (doc: Node) => string = () => '';
let notes: Note[] = [];
let marks: Mark[] = [];
const previews = new Map<string, HTMLElement>();
let usedPreviews = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const anchors = new Map<string, Anchor>();

// ---- Blocks ----

/** Plain text of a block; in a textblock, offset n is document position (start + 1 + n). */
function blockText(node: Node): string {
    if (!node.isTextblock) { return node.textBetween(0, node.content.size, '\n', LEAF); }
    let text = '';
    node.forEach(child => { text += child.isText ? child.text ?? '' : LEAF.repeat(child.nodeSize); });
    return text;
}

/** Text plus inline formatting, so "made it bold" counts as a change but re-wrapped Markdown does not. */
function blockSig(node: Node): string {
    const parts: string[] = [String(node.attrs.level ?? '')];
    node.descendants(child => {
        if (child.isText) {
            const formatting = child.marks.map(mark => mark.type.name + (mark.attrs.href ? `=${mark.attrs.href}` : '')).sort().join('+');
            parts.push(`${formatting}:${child.text}`);
        } else if (child.isLeaf) {
            parts.push(`<${child.type.name}:${child.attrs.src ?? ''}>`);
        } else {
            parts.push(`[${child.type.name}]`);
        }
    });
    return parts.join('|');
}

const infoOf = (node: Node): BlockInfo => ({ type: node.type.name, text: blockText(node), sig: blockSig(node) });
const isList = (node: Node): boolean => node.type.name === 'bullet_list' || node.type.name === 'ordered_list';

function childPos(doc: Node, index: number): number {
    let pos = 0;
    for (let i = 0; i < index && i < doc.childCount; i++) { pos += doc.child(i).nodeSize; }
    return pos;
}

function blocksIn(doc: Node, from: number, end: number): Block[] {
    const blocks: Block[] = [];
    doc.forEach((node, pos) => { if (pos >= from && pos < end) { blocks.push({ node, pos, info: infoOf(node) }); } });
    return blocks;
}

const endOf = (note: { last: number }, doc: Node): number => note.last + (doc.nodeAt(note.last)?.nodeSize ?? 0);

/** Start of the last block of the section a heading opens. */
function sectionLast(doc: Node, from: number): number {
    const index = doc.resolve(from).index(0), level = doc.child(index).attrs.level as number;
    let last = index;
    while (last + 1 < doc.childCount) {
        const next = doc.child(last + 1);
        if (next.type.name === 'heading' && (next.attrs.level as number) <= level) { break; }
        last++;
    }
    return childPos(doc, last);
}

/** Keep a note on whole top-level blocks after the document changed under it. */
function normalize(note: Note, doc: Node): void {
    const count = doc.childCount;
    if (!count) { note.from = note.last = 0; return; }
    const snap = (pos: number): number => {
        const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
        if ($pos.depth > 0) { return $pos.before(1); }
        return $pos.index(0) >= count ? childPos(doc, count - 1) : $pos.pos;
    };
    note.from = snap(note.from);
    note.last = Math.max(snap(note.last), note.from);
    if (note.scope === 'section') {
        if (doc.nodeAt(note.from)?.type.name === 'heading') { note.last = sectionLast(doc, note.from); }
        else { note.scope = 'block'; note.last = note.from; }
    }
}

function trackPositions(tr: Transaction, meta: NotesMeta | undefined, doc: Node): void {
    for (const note of notes) {
        if (meta?.place?.id === note.id) {
            note.from = meta.place.from; note.last = meta.place.last;
        } else {
            // Following the block's start keeps a new paragraph typed after the note's block out of it.
            note.from = tr.mapping.map(note.from, 1);
            note.last = tr.mapping.map(note.last, 1);
        }
        normalize(note, doc);
    }
}

// ---- What the notes show over the document ----

function preview(id: string, make: () => HTMLElement): HTMLElement {
    usedPreviews.add(id);
    let element = previews.get(id);
    if (!element) { element = make(); previews.set(id, element); }
    return element;
}

function inlineDecorations(segs: TextSeg[], start: number, withInsertions: boolean, id: string, out: Decoration[]): void {
    let offset = 0;
    segs.forEach((seg, n) => {
        if (seg.t === '=') { offset += seg.s.length; return; }
        if (seg.t === '-') {
            out.push(Decoration.inline(start + offset, start + offset + seg.s.length, { class: 'bb-del' }));
            offset += seg.s.length;
            return;
        }
        const added = seg.s.replaceAll(LEAF, '');
        if (!withInsertions || !added) { return; }
        out.push(Decoration.widget(start + offset, () => {
            const span = document.createElement('span');
            span.className = 'bb-ins';
            span.textContent = added;
            return span;
        }, { side: -1, key: `${id}:ins:${n}:${added}`, ignoreSelection: true }));
    });
}

/** Mark the text the rewrite adds, inside an already rendered block. */
function highlightInsertions(root: HTMLElement, before: string, after: string): void {
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
function charCounts(before: string, after: string): { del: number; ins: number } {
    let del = 0, ins = 0;
    for (const seg of diffText(before, after)) {
        const size = [...seg.s.replace(/￼/g, '')].length;
        if (seg.t === '-') { del += size; } else if (seg.t === '+') { ins += size; }
    }
    return { del, ins };
}

function buildNote(note: Note, order: number, doc: Node, out: Decoration[]): void {
    const section = note.scope === 'section';
    const end = endOf(note, doc);
    const cardPos = section ? note.from + (doc.nodeAt(note.from)?.nodeSize ?? 0) : end;
    out.push(Decoration.widget(cardPos, note.el, {
        key: `bb-note-${note.id}`, side: 1 + order * 0.001, stopEvent: () => true, ignoreSelection: true,
    }));

    const turn = lastProposalTurn(note);
    if (!turn?.proposal) { note.summary = undefined; return; }
    const proposal = turn.proposal, { seq, basis, target, nodes } = proposal;
    const blocks = blocksIn(doc, note.from, end);
    const placed = locate(seq, basis, target, blocks.map(block => block.info));
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

    const serializer = DOMSerializer.fromSchema(doc.type.schema);
    const turnIndex = note.thread.indexOf(turn), multi = items.length > 1;
    const wrap = (node: Node, cls: string): HTMLElement => {
        const box = document.createElement('div');
        box.className = `bb-preview ${cls}`;
        box.contentEditable = 'false';
        box.append(serializer.serializeNode(node));
        return box;
    };
    const mark = (m: Omit<Mark, 'note'>): void => { marks.push({ ...m, note }); };
    const decorate = (block: Block, cls: string): void => { out.push(Decoration.node(block.pos, block.pos + block.node.nodeSize, { class: cls })); };
    const widget = (pos: number, element: HTMLElement, id: string, side: number): void => {
        out.push(Decoration.widget(pos, element, { key: id, side, stopEvent: () => true, ignoreSelection: true }));
    };

    for (const index of pending) {
        const item = seq[index], place = placed.get(index)!, id = `${note.id}:${turnIndex}:${index}`;
        const insertPos = place.insertAt === undefined ? 0 : place.insertAt < blocks.length ? blocks[place.insertAt].pos : end;
        // Blocks to be added sit before the card of a block note, after the card of a section note (which hangs under its heading).
        const insertSide = (section ? 2 : 0.6) + index * 0.0001;
        const next = item.new === undefined ? undefined : nodes[item.new];

        if (item.kind === 'mod' && next) {
            const old = blocks[place.at!];
            if (old.node.isTextblock && next.isTextblock) {
                const segs = diffText(old.info.text, blockText(next));
                const stacked = changeRatio(segs) > STACK_RATIO;
                inlineDecorations(segs, old.pos + 1, !stacked, id, out);
                if (!stacked) {
                    decorate(old, 'bb-d bb-d-mod');
                    mark({ key: id, item: index, sign: '~', tone: 'mod', pos: old.pos, controls: multi });
                    continue;
                }
                const row = preview(`${id}:new`, () => {
                    const box = wrap(next, 'bb-d-new');
                    highlightInsertions(box, old.info.text.replaceAll(LEAF, ''), blockText(next).replaceAll(LEAF, ''));
                    return box;
                });
                decorate(old, 'bb-d bb-d-old');
                widget(old.pos + old.node.nodeSize, row, `${id}:new`, 0.5);
                mark({ key: `${id}:old`, item: index, sign: '−', tone: 'del', pos: old.pos, controls: multi });
                mark({ key: `${id}:new`, sign: '+', tone: 'add', el: row, controls: false });
            } else if (isList(old.node) && old.node.type === next.type) {
                listDecorations(old, next, note, id, serializer, out);
                mark({ key: id, item: index, sign: '', tone: 'mod', pos: old.pos, controls: multi });
            } else {
                const row = preview(`${id}:new`, () => wrap(next, 'bb-d-new'));
                decorate(old, 'bb-d bb-d-old');
                widget(old.pos + old.node.nodeSize, row, `${id}:new`, 0.5);
                mark({ key: `${id}:old`, item: index, sign: '−', tone: 'del', pos: old.pos, controls: multi });
                mark({ key: `${id}:new`, sign: '+', tone: 'add', el: row, controls: false });
            }
        } else if (item.kind === 'del') {
            const old = blocks[place.at!];
            decorate(old, 'bb-d bb-d-del');
            mark({ key: id, item: index, sign: '−', tone: 'del', pos: old.pos, controls: multi });
        } else if (item.kind === 'add' && next) {
            const row = preview(id, () => wrap(next, 'bb-d-add'));
            widget(insertPos, row, id, insertSide);
            mark({ key: id, item: index, sign: '+', tone: 'add', el: row, controls: multi });
        } else if (item.kind === 'to' && next) {
            const source = blocks[place.at!];
            const row = preview(id, () => wrap(next, 'bb-d-to'));
            widget(insertPos, row, id, insertSide);
            decorate(source, 'bb-d bb-d-from');
            mark({ key: id, item: index, sign: '⤷', tone: 'mod', el: row, controls: multi });
            mark({ key: `${id}:from`, sign: item.dir === 'up' ? '↑' : '↓', tone: 'mod', pos: source.pos, controls: false });
        }
    }
}

/** A list rewritten as a list: show which items changed instead of replacing the whole list on screen. */
function listDecorations(old: Block, next: Node, note: Note, id: string, serializer: DOMSerializer, out: Decoration[]): void {
    const oldItems: Array<{ node: Node; pos: number }> = [];
    old.node.forEach((node, offset) => oldItems.push({ node, pos: old.pos + 1 + offset }));
    const nextItems: Node[] = [];
    next.forEach(node => nextItems.push(node));
    const seq = buildSequence(oldItems.map(item => infoOf(item.node)), nextItems.map(infoOf));
    const single = (node: Node): Node | null => (node.childCount === 1 && node.firstChild?.isTextblock ? node.firstChild : null);
    let after = old.pos + 1;
    seq.forEach((item, n) => {
        const was = item.old === undefined ? undefined : oldItems[item.old];
        const sub = `${id}:li:${n}`;
        if (item.kind === 'add' || item.kind === 'to') {
            const row = preview(sub, () => {
                const li = serializer.serializeNode(nextItems[item.new!]) as HTMLElement;
                li.classList.add('bb-preview', 'bb-d-add');
                li.contentEditable = 'false';
                return li;
            });
            out.push(Decoration.widget(after, row, { key: sub, side: 1 + n * 0.0001, stopEvent: () => true, ignoreSelection: true }));
            marks.push({ key: sub, note, sign: '+', tone: 'add', el: row, controls: false });
            return;
        }
        if (!was) { return; }
        after = was.pos + was.node.nodeSize;
        if (item.kind === 'keep') { return; }
        if (item.kind === 'mod') {
            const before = single(was.node), now = single(nextItems[item.new!]);
            if (before && now) { inlineDecorations(diffText(blockText(before), blockText(now)), was.pos + 2, true, sub, out); }
            out.push(Decoration.node(was.pos, was.pos + was.node.nodeSize, { class: 'bb-d bb-d-mod' }));
            marks.push({ key: sub, note, sign: '~', tone: 'mod', pos: was.pos, controls: false });
        } else {
            out.push(Decoration.node(was.pos, was.pos + was.node.nodeSize, { class: 'bb-d bb-d-del' }));
            marks.push({ key: sub, note, sign: '−', tone: 'del', pos: was.pos, controls: false });
        }
    });
}

function build(doc: Node): DecorationSet {
    const out: Decoration[] = [];
    marks = [];
    usedPreviews = new Set();
    notes.forEach((note, order) => buildNote(note, order, doc, out));
    for (const id of [...previews.keys()]) { if (!usedPreviews.has(id)) { previews.delete(id); } }
    return DecorationSet.create(doc, out);
}

/** After a state update: hand the gutters their marks and repaint notes whose proposal status moved. */
function afterUpdate(): void {
    if (!ui) { return; }
    ui.setMarks(marks);
    for (const note of notes) {
        const summaryKey = JSON.stringify(note.summary ?? null);
        if (summaryKey !== note.summaryKey) { note.summaryKey = summaryKey; ui.render(note); }
    }
}

function refresh(): void {
    view?.dispatch(view.state.tr.setMeta(key, {}).setMeta('addToHistory', false));
}

function changed(note: Note): void {
    ui?.render(note);
    refresh();
    saveSoon();
}

// ---- Applying a proposal ----

function setState(seq: SeqItem[], index: number, state: SeqItem['state']): void {
    seq[index].state = state;
    const twin = seq[index].link;
    if (twin !== undefined) { seq[twin].state = state; }
}

/** Apply the given items as one edit (one undo step). Items whose block changed since are skipped. */
function applyItems(note: Note, indices: number[]): void {
    const proposal = lastProposalTurn(note)?.proposal;
    if (!view || !proposal) { return; }
    const tr = view.state.tr;
    let from = note.from, last = note.last;
    for (const index of indices) {
        const item = proposal.seq[index];
        if (item.state !== 'pending') { continue; }
        const end = last + (tr.doc.nodeAt(last)?.nodeSize ?? 0);
        const blocks = blocksIn(tr.doc, from, end);
        const place = locate(proposal.seq, proposal.basis, proposal.target, blocks.map(block => block.info)).get(index);
        if (!place) { continue; }
        const node = item.new === undefined ? undefined : proposal.nodes[item.new];
        const source = place.at === undefined ? undefined : blocks[place.at];
        const insertPos = place.insertAt === undefined ? -1 : place.insertAt < blocks.length ? blocks[place.insertAt].pos : end;
        const firstStep = tr.steps.length;
        let starts = blocks.map(block => block.pos);

        if (item.kind === 'mod' && source && node) {
            tr.replaceWith(source.pos, source.pos + source.node.nodeSize, node);
        } else if (item.kind === 'del' && source) {
            tr.delete(source.pos, source.pos + source.node.nodeSize);
            starts.splice(place.at!, 1);
        } else if (item.kind === 'add' && node) {
            tr.insert(insertPos, node);
        } else if (item.kind === 'to' && source && node) {
            tr.insert(insertPos, node);
            const start = tr.mapping.slice(firstStep).map(source.pos, 1);
            tr.delete(start, start + source.node.nodeSize);
            starts.splice(place.at!, 1);
        } else { continue; }

        // Follow the scope's blocks through this edit, then add the block that was inserted.
        const moved = tr.mapping.slice(firstStep);
        starts = starts.map(pos => moved.map(pos, 1));
        if ((item.kind === 'add' || item.kind === 'to') && place.insertAt !== undefined) {
            const inserted = tr.mapping.slice(firstStep + 1).map(insertPos, -1);
            const slot = place.insertAt - (item.kind === 'to' && place.at! < place.insertAt ? 1 : 0);
            starts.splice(slot, 0, inserted);
        }
        if (starts.length) { from = starts[0]; last = starts[starts.length - 1]; }
        else { from = last = moved.map(from, 1); }
        setState(proposal.seq, index, 'accepted');
    }
    if (tr.docChanged) {
        view.dispatch(tr.setMeta(key, { place: { id: note.id, from, last } } satisfies NotesMeta));
    }
    changed(note);
}

// ---- Asking and answers ----

function scopeOf(doc: Node, firstIndex: number, lastIndex: number, quote: string): Scope | null {
    if (!doc.childCount) { return null; }
    const first = Math.min(Math.max(firstIndex, 0), doc.childCount - 1), last = Math.min(Math.max(lastIndex, first), doc.childCount - 1);
    const node = doc.child(first), from = childPos(doc, first);
    if (first !== last) {
        const tag = `¶×${last - first + 1}`;
        return { kind: 'range', from, last: childPos(doc, last), quote: '', chip: tag, tag };
    }
    if (quote) { return { kind: 'block', from, last: from, quote, chip: `“${quote}”`, tag: '' }; }
    if (node.type.name === 'heading') {
        const tag = '#'.repeat(node.attrs.level as number);
        return { kind: 'section', from, last: sectionLast(doc, from), quote: '', chip: `${tag} ${node.textContent}`, tag };
    }
    // Each kind of block is named by the sign Markdown itself uses for it.
    const sign: Record<string, string> = {
        paragraph: '¶', bullet_list: '-', ordered_list: '1.', code_block: '```', blockquote: '>', table: '|', hr: '---',
    };
    return { kind: 'block', from, last: from, quote: '', chip: sign[node.type.name] ?? '¶', tag: '' };
}

/** A paragraph asks about itself, a heading about its whole section, a selection across blocks about those blocks. */
function scopeFromSelection(state: EditorState): Scope | null {
    const { $from, $to, empty } = state.selection;
    let lastIndex = $to.index(0);
    // A selection that ends at the very start of a block does not include that block.
    if (!empty && lastIndex > $from.index(0) && ($to.depth === 0 || $to.pos - $to.before(1) <= $to.depth)) { lastIndex--; }
    const single = $from.index(0) === lastIndex;
    const quote = !empty && single ? state.doc.textBetween($from.pos, $to.pos, ' ').trim().slice(0, 300) : '';
    return scopeOf(state.doc, $from.index(0), lastIndex, quote);
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

/** Send the note's latest question, with the blocks it is about exactly as they are now. */
function run(note: Note): void {
    if (!view) { return; }
    const doc = view.state.doc;
    const blocks = blocksIn(doc, note.from, endOf(note, doc));
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
    note.askBasis = blocks.map(block => block.info);
    const scopeDoc = doc.type.schema.topNodeType.create(null, Fragment.fromArray(blocks.map(block => block.node)));
    host.post({
        type: 'note-ask', requestId: note.requestId, question: mine[mine.length - 1].text, scopeKind: note.scope,
        scopeMarkdown: stripBaseUri(serializeDoc(scopeDoc), host.baseUri()), quote: note.quote || undefined, history,
    });
    changed(note);
}

function proposalFrom(basis: BlockInfo[], replacement: string, seq?: SeqItem[]): Proposal | undefined {
    const parsed = parseMarkdown(preprocessMarkdown(replacement, host.baseUri()));
    if (!parsed) { return undefined; }
    const nodes: Node[] = [];
    parsed.forEach(node => nodes.push(node));
    const target = nodes.map(infoOf);
    const sequence = seq ?? buildSequence(basis, target);
    return changeItems(sequence).length ? { basis, replacement, seq: sequence, nodes, target } : undefined;
}

export function handleNoteMessage(message: HostMessage): void {
    if (message.type === 'notes-load') { restore(message.notes); return; }
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
        // Never swap blocks under the writer's cursor: an open note offers "查看改动" instead.
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
            if (other !== note && other.lens && other.open && overlaps(note, other)) { other.lens = false; ui?.render(other); }
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
        const parsed = view ? parseMarkdown(markdown) : null;
        if (!view || !parsed) {
            const fragment = document.createDocumentFragment();
            fragment.append(markdown);
            return fragment;
        }
        return DOMSerializer.fromSchema(view.state.schema).serializeFragment(parsed.content) as DocumentFragment;
    },
    scopeForBlock(pos) {
        return view ? scopeOf(view.state.doc, view.state.doc.resolve(pos).index(0), view.state.doc.resolve(pos).index(0), '') : null;
    },
    focusEditor() { view?.focus(); },
};

/** ⌘B ⌘B: ask about wherever the caret or selection is. */
export function openAskAtSelection(): void {
    if (!view || !ui || !view.editable) { return; }
    const scope = scopeFromSelection(view.state);
    if (scope) { ui.openAsk(scope); }
}

// ---- Keeping notes across reloads and sessions ----

const clipText = (text: string): string => text.slice(0, 160);

function anchorOf(note: Note, doc: Node): Anchor {
    const blocks = blocksIn(doc, note.from, endOf(note, doc));
    return { index: doc.resolve(note.from).index(0), texts: blocks.slice(0, 3).map(block => clipText(block.info.text)), count: blocks.length };
}

/** Find a note's blocks again by what they say, falling back to where they were. */
function reanchor(note: Note, anchor: Anchor, doc: Node): void {
    const texts: string[] = [];
    doc.forEach(node => texts.push(clipText(blockText(node))));
    let best = -1;
    texts.forEach((text, index) => {
        if (text === anchor.texts[0] && (best < 0 || Math.abs(index - anchor.index) < Math.abs(best - anchor.index))) { best = index; }
    });
    const first = best >= 0 ? best : Math.min(anchor.index, Math.max(doc.childCount - 1, 0));
    note.from = childPos(doc, first);
    note.last = childPos(doc, Math.min(first + Math.max(anchor.count, 1) - 1, Math.max(doc.childCount - 1, 0)));
    normalize(note, doc);
}

/** Called around a document (re)load: positions are meaningless across it, block text is not. */
export function beforeDocumentLoad(): void {
    anchors.clear();
    if (!view) { return; }
    for (const note of notes) { anchors.set(note.id, anchorOf(note, view.state.doc)); }
}

export function afterDocumentLoad(): void {
    if (!view) { return; }
    for (const note of notes) {
        const anchor = anchors.get(note.id);
        if (anchor) { reanchor(note, anchor, view.state.doc); }
    }
    refresh();
}

function saveSoon(): void {
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = setTimeout(() => {
        if (!view) { return; }
        const doc = view.state.doc;
        const stored: StoredNote[] = notes.map(note => ({
            id: note.id, scope: note.scope, quote: note.quote, tag: note.tag, unread: note.unread, ...anchorOf(note, doc),
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
function restore(stored: unknown[]): void {
    if (!view) { return; }
    const doc = view.state.doc;
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
        reanchor(note, item, doc);
        next.push(note);
    }
    for (const gone of kept.values()) {
        if (gone.status === 'working') { host.post({ type: 'note-cancel', requestId: gone.requestId }); }
        ui?.remove(gone);
    }
    notes = next;
    notes.forEach(note => ui?.render(note));
    refresh();
}

// ---- Plugin ----

export function notesPlugin(notesHost: NotesHost): MilkdownPlugin {
    host = notesHost;
    return $prose(ctx => {
        parseMarkdown = markdown => ctx.get(parserCtx)(markdown);
        serializeDoc = doc => ctx.get(serializerCtx)(doc);
        return new Plugin<DecorationSet>({
            key,
            state: {
                init: () => DecorationSet.empty,
                apply(tr, set, _old, next) {
                    const meta = tr.getMeta(key) as NotesMeta | undefined;
                    if (tr.docChanged) { trackPositions(tr, meta, next.doc); }
                    return tr.docChanged || meta ? build(next.doc) : set;
                },
            },
            props: { decorations: state => key.getState(state) },
            view(editorView) {
                view = editorView;
                ui = new NotesView(editorView, () => notes, actions);
                return {
                    update(next) { view = next; ui?.update(next); afterUpdate(); },
                    destroy() { ui?.destroy(); ui = undefined; view = undefined; },
                };
            },
        });
    });
}
