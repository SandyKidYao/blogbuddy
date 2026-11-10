/**
 * Block-level diff for margin notes.
 *
 * An agent never edits the document. It hands back a rewrite of the blocks a
 * note is about; this module turns "what the blocks were" + "what the agent
 * proposes" into a sequence of block operations the writer can accept one by
 * one, and later finds where each operation applies in the current document.
 *
 * Pure functions only — shared by the webview and unit tests.
 */

/** A top-level block reduced to what the diff needs. */
export interface BlockInfo {
    /** Node type name, e.g. "paragraph", "heading", "bullet_list". */
    type: string;
    /** Plain text; every non-text inline leaf counts as one U+FFFC. */
    text: string;
    /** Text plus inline formatting — two blocks are the same block when type and sig match. */
    sig: string;
}

export type TextSeg = { t: '=' | '-' | '+'; s: string };

export type ItemKind = 'keep' | 'mod' | 'add' | 'del' | 'from' | 'to';
export type ItemState = 'pending' | 'accepted' | 'rejected';

/**
 * One entry of a proposal, in reading order.
 *   keep  unchanged block            mod  block rewritten in place
 *   add   new block                  del  block removed
 *   to    a block moved here         from where that block used to be (linked to its `to`)
 */
export interface SeqItem {
    kind: ItemKind;
    /** Index into the basis blocks (keep, mod, del, from, to). */
    old?: number;
    /** Index into the target blocks (keep, mod, add, to). */
    new?: number;
    state: ItemState;
    /** Index of the twin item for a move. */
    link?: number;
    /** For a move: which way the block travelled. */
    dir?: 'up' | 'down';
}

/** Where a pending item applies in the current blocks. */
export interface Placement {
    /** Index of the existing block the item acts on (mod, del, from, to's source). */
    at?: number;
    /** Index before which a new block goes; `current.length` means the end (add, to). */
    insertAt?: number;
}

const sameBlock = (a: BlockInfo, b: BlockInfo): boolean => a.type === b.type && a.sig === b.sig;

/** Longest common subsequence; returns, for each index of the first list, its partner in the second or -1. */
function lcs(n: number, m: number, eq: (i: number, j: number) => boolean): number[] {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * width + j] = eq(i, j)
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const partner = new Array<number>(n).fill(-1);
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (eq(i, j)) { partner[i] = j; i++; j++; }
        else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { i++; }
        else { j++; }
    }
    return partner;
}

/** Words for Latin text, single characters for everything else (CJK has no word breaks). */
function tokens(text: string): string[] {
    return text.match(/[A-Za-z0-9_]+|[\s\S]/gu) ?? [];
}

const MAX_DIFF_CELLS = 4_000_000;

/** Token diff of two strings, with one-character islands between changes folded into the change. */
export function diffText(a: string, b: string): TextSeg[] {
    if (a === b) { return a ? [{ t: '=', s: a }] : []; }
    const A = tokens(a), B = tokens(b);
    if (A.length * B.length > MAX_DIFF_CELLS) {
        return [{ t: '-', s: a }, { t: '+', s: b }];
    }
    const partner = lcs(A.length, B.length, (i, j) => A[i] === B[j]);
    const raw: Array<{ t: '=' | '-' | '+' | '*'; s: string }> = [];
    const push = (t: '=' | '-' | '+', s: string): void => {
        const last = raw[raw.length - 1];
        if (last && last.t === t) { last.s += s; } else { raw.push({ t, s }); }
    };
    let j = 0;
    A.forEach((token, i) => {
        if (partner[i] < 0) { push('-', token); return; }
        while (j < partner[i]) { push('+', B[j++]); }
        push('=', token); j++;
    });
    while (j < B.length) { push('+', B[j++]); }

    // A lone shared character between two changes reads as noise ("的", "，"); treat it as changed.
    raw.forEach((seg, k) => {
        const prev = raw[k - 1], next = raw[k + 1];
        if (seg.t === '=' && [...seg.s].length <= 1 && prev && next && prev.t !== '=' && next.t !== '=') { seg.t = '*'; }
    });
    const out: TextSeg[] = [];
    let del = '', ins = '';
    const flush = (): void => {
        if (del) { out.push({ t: '-', s: del }); }
        if (ins) { out.push({ t: '+', s: ins }); }
        del = ins = '';
    };
    for (const seg of raw) {
        if (seg.t === '=') { flush(); out.push({ t: '=', s: seg.s }); continue; }
        if (seg.t !== '+') { del += seg.s; }
        if (seg.t !== '-') { ins += seg.s; }
    }
    flush();
    return out;
}

/** Share of the two texts that the diff touches, 0..1. Decides inline vs. side-by-side display. */
export function changeRatio(segs: TextSeg[]): number {
    let changed = 0, total = 0;
    for (const seg of segs) {
        const size = seg.s.length;
        if (seg.t === '=') { total += size * 2; } else { changed += size; total += size; }
    }
    return total ? changed / total : 0;
}

/** 0..1 — how much of two texts is shared. Used to tell "rewritten" from "replaced". */
export function similarity(a: string, b: string): number {
    if (a === b) { return 1; }
    const A = tokens(a).slice(0, 600), B = tokens(b).slice(0, 600);
    if (!A.length || !B.length) { return 0; }
    const shared = lcs(A.length, B.length, (i, j) => A[i] === B[j]).filter(p => p >= 0).length;
    return (2 * shared) / (A.length + B.length);
}

const MOD_THRESHOLD = 0.3;

/** Cheap upper bound on similarity (shared characters, order ignored) — skips the costly comparison for unrelated blocks. */
function roughOverlap(a: string, b: string): number {
    if (!a.length || !b.length) { return 0; }
    const counts = new Map<string, number>();
    for (const ch of a) { counts.set(ch, (counts.get(ch) ?? 0) + 1); }
    let shared = 0, sizeB = 0;
    for (const ch of b) {
        sizeB++;
        const left = counts.get(ch) ?? 0;
        if (left > 0) { shared++; counts.set(ch, left - 1); }
    }
    return (2 * shared) / ([...a].length + sizeB);
}

/**
 * Align the two block lists, keeping as much content in place as possible.
 * Returns, for each basis block, the target block it stays with (unchanged or
 * rewritten) or -1. Weighting by amount of text is what makes a long paragraph
 * that was rewritten stay put while a short one that changed places moves.
 */
function align(basis: BlockInfo[], target: BlockInfo[]): number[] {
    const n = basis.length, m = target.length, width = m + 1;
    const weight = new Float64Array(n * m);
    basis.forEach((a, i) => target.forEach((b, j) => {
        if (sameBlock(a, b)) { weight[i * m + j] = a.text.length + 1; return; }
        if (a.type !== b.type || roughOverlap(a.text, b.text) < MOD_THRESHOLD) { return; }
        const shared = similarity(a.text, b.text);
        if (shared >= MOD_THRESHOLD) { weight[i * m + j] = shared * (a.text.length + b.text.length) / 2; }
    }));
    const best = new Float64Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            const w = weight[i * m + j];
            best[i * width + j] = Math.max(best[(i + 1) * width + j], best[i * width + j + 1], w > 0 ? w + best[(i + 1) * width + j + 1] : 0);
        }
    }
    const partner = new Array<number>(n).fill(-1);
    let i = 0, j = 0;
    while (i < n && j < m) {
        const w = weight[i * m + j], here = best[i * width + j];
        if (w > 0 && here === w + best[(i + 1) * width + j + 1]) { partner[i] = j; i++; j++; }
        else if (here === best[(i + 1) * width + j]) { i++; }
        else { j++; }
    }
    return partner;
}

/** Turn "blocks before" and "blocks the agent proposes" into block operations in reading order. */
export function buildSequence(basis: BlockInfo[], target: BlockInfo[]): SeqItem[] {
    const oldToNew = align(basis, target);
    const newToOld = new Array<number>(target.length).fill(-1);
    oldToNew.forEach((j, i) => { if (j >= 0) { newToOld[j] = i; } });

    type Role = 'keep' | 'mod' | 'del' | 'from' | 'add' | 'to';
    const oldRole: Role[] = oldToNew.map((j, i) => (j < 0 ? 'del' : sameBlock(basis[i], target[j]) ? 'keep' : 'mod'));
    const newRole: Role[] = newToOld.map(i => (i < 0 ? 'add' : oldRole[i]));

    // Moves: a block left without a partner that reappears unchanged elsewhere.
    basis.forEach((block, i) => {
        if (oldRole[i] !== 'del') { return; }
        const j = target.findIndex((candidate, k) => newRole[k] === 'add' && sameBlock(block, candidate));
        if (j >= 0) { oldRole[i] = 'from'; newRole[j] = 'to'; oldToNew[i] = j; newToOld[j] = i; }
    });

    // Reading order: the proposed order, with removed blocks left where they were
    // (and, within a gap, what goes before what comes — as a diff reads).
    const seq: SeqItem[] = [];
    let cursor = 0;
    const flushOld = (limit: number): void => {
        for (; cursor < limit; cursor++) {
            if (oldRole[cursor] === 'del') { seq.push({ kind: 'del', old: cursor, state: 'pending' }); }
            if (oldRole[cursor] === 'from') { seq.push({ kind: 'from', old: cursor, new: oldToNew[cursor], state: 'pending' }); }
        }
    };
    const stays = (j: number): boolean => newRole[j] === 'keep' || newRole[j] === 'mod';
    target.forEach((_block, j) => {
        const role = newRole[j];
        if (role === 'keep' || role === 'mod') {
            flushOld(newToOld[j]);
            seq.push({ kind: role, old: newToOld[j], new: j, state: role === 'keep' ? 'accepted' : 'pending' });
            cursor = newToOld[j] + 1;
            return;
        }
        let next = j + 1;
        while (next < target.length && !stays(next)) { next++; }
        flushOld(next < target.length ? newToOld[next] : basis.length);
        seq.push(role === 'to' ? { kind: 'to', old: newToOld[j], new: j, state: 'pending' } : { kind: 'add', new: j, state: 'pending' });
    });
    flushOld(basis.length);

    seq.forEach((item, index) => {
        if (item.kind !== 'to') { return; }
        const twin = seq.findIndex(other => other.kind === 'from' && other.old === item.old);
        item.link = twin; seq[twin].link = index;
        item.dir = seq[twin].dir = index < twin ? 'up' : 'down';
    });
    return seq;
}

/** The items a writer decides on (a move counts once, on its destination). */
export function changeItems(seq: SeqItem[]): number[] {
    return seq.map((item, index) => (item.kind !== 'keep' && item.kind !== 'from' ? index : -1)).filter(index => index >= 0);
}

/** What the item contributes to the document right now, given its state — or nothing. */
function expected(item: SeqItem, basis: BlockInfo[], target: BlockInfo[]): BlockInfo | undefined {
    const done = item.state === 'accepted';
    switch (item.kind) {
        case 'keep': return basis[item.old!];
        case 'mod': return done ? target[item.new!] : basis[item.old!];
        case 'add': case 'to': return done ? target[item.new!] : undefined;
        case 'del': case 'from': return done ? undefined : basis[item.old!];
    }
}

/**
 * Find where every pending item applies in the blocks as they are now.
 * Blocks are recognised by content, so the writer can keep editing around a
 * proposal; an item whose block was edited since is simply not placed (stale).
 */
export function locate(seq: SeqItem[], basis: BlockInfo[], target: BlockInfo[], current: BlockInfo[]): Map<number, Placement> {
    const present: Array<{ index: number; block: BlockInfo }> = [];
    seq.forEach((item, index) => {
        const block = expected(item, basis, target);
        if (block) { present.push({ index, block }); }
    });
    const partner = lcs(present.length, current.length, (i, j) => sameBlock(present[i].block, current[j]));
    const where = new Map<number, number>();          // seq index → current index
    const isPresent = new Set(present.map(p => p.index));
    present.forEach((p, i) => { if (partner[i] >= 0) { where.set(p.index, partner[i]); } });

    const insertionPoint = (index: number): number | undefined => {
        for (let k = index - 1; k >= 0; k--) {
            if (where.has(k)) { return where.get(k)! + 1; }
        }
        for (let k = index + 1; k < seq.length; k++) {
            if (where.has(k)) { return where.get(k)!; }
        }
        // Nothing recognisable around it: only safe when the scope was empty to begin with.
        return isPresent.size === 0 ? 0 : undefined;
    };

    const placed = new Map<number, Placement>();
    seq.forEach((item, index) => {
        if (item.state !== 'pending') { return; }
        if (item.kind === 'mod' || item.kind === 'del') {
            if (where.has(index)) { placed.set(index, { at: where.get(index) }); }
        } else if (item.kind === 'add') {
            const insertAt = insertionPoint(index);
            if (insertAt !== undefined) { placed.set(index, { insertAt }); }
        } else if (item.kind === 'to') {
            const insertAt = insertionPoint(index);
            const source = item.link !== undefined ? where.get(item.link) : undefined;
            if (insertAt !== undefined && source !== undefined) {
                placed.set(index, { at: source, insertAt });
                placed.set(item.link!, { at: source });
            }
        }
    });
    return placed;
}
