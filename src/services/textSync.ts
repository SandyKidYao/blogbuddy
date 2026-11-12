import { ChangeSet, Text } from '@codemirror/state';

/**
 * Keeping the editor webview and VS Code's TextDocument in step.
 *
 * The TextDocument is the authority. Its text is mirrored here as a
 * CodeMirror Text, with line breaks as "\n" (the webview's form; a CRLF file
 * keeps its CRLF in the document, positions travel as line + character). Every
 * change to the document — from the webview, a text editor, a reload from
 * disk, VS Code's own undo — is recorded as one or more numbered updates and
 * broadcast. The webview runs @codemirror/collab: it sends its unconfirmed
 * changes based on the version it has seen, and rebases them over whatever it
 * receives. A push based on an old version is turned away; the webview rebases
 * and tries again.
 *
 * Pure: no VS Code API, so it can be unit tested and stand in for the host in
 * browser tests.
 */

/** An update as it travels between host and webview: one client's changes (ChangeSet JSON). */
export interface WireUpdate {
    clientID: string;
    changes: unknown;
}

/** A change as VS Code describes it: a range of the document, by line and character, and its new text. */
export interface RangeEdit {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    text: string;
}

/** The client id of changes that did not come from the webview. */
export const HOST_CLIENT = 'host';

export const toLF = (text: string): string => text.replace(/\r\n?/g, '\n');

export const textOf = (text: string): Text => Text.of(toLF(text).split('\n'));

function offset(doc: Text, line: number, character: number): number {
    const target = doc.line(Math.min(Math.max(line, 0) + 1, doc.lines));
    return Math.min(target.from + Math.max(character, 0), target.to);
}

/**
 * VS Code's content changes for one event, as one ChangeSet over `doc`.
 * They apply in order, each to the result of the previous one. Each is
 * narrowed to the part that actually differs, so a file reloaded from disk
 * moves only what changed and the caret, undo history and notes stay put.
 */
export function changesFromEdits(doc: Text, edits: readonly RangeEdit[]): ChangeSet {
    let total = ChangeSet.empty(doc.length);
    let current = doc;
    for (const edit of edits) {
        let from = offset(current, edit.startLine, edit.startCharacter);
        let to = offset(current, edit.endLine, edit.endCharacter);
        let insert = toLF(edit.text);
        const old = current.sliceString(from, to);
        const max = Math.min(old.length, insert.length);
        let head = 0;
        while (head < max && old.charCodeAt(head) === insert.charCodeAt(head)) { head++; }
        let tail = 0;
        while (tail < max - head && old.charCodeAt(old.length - 1 - tail) === insert.charCodeAt(insert.length - 1 - tail)) { tail++; }
        from += head;
        to -= tail;
        insert = insert.slice(head, insert.length - tail);
        if (from === to && !insert) { continue; }
        const step = ChangeSet.of({ from, to, insert }, current.length);
        total = total.compose(step);
        current = step.apply(current);
    }
    return total;
}

/** A ChangeSet over `doc` as range edits against that same document — what a WorkspaceEdit expects. */
export function editsFromChanges(doc: Text, changes: ChangeSet, eol: string): RangeEdit[] {
    const edits: RangeEdit[] = [];
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const start = doc.lineAt(fromA), end = doc.lineAt(toA);
        edits.push({
            startLine: start.number - 1, startCharacter: fromA - start.from,
            endLine: end.number - 1, endCharacter: toA - end.from,
            text: eol === '\n' ? inserted.toString() : inserted.toString().replace(/\n/g, eol),
        });
    });
    return edits;
}

interface Pending {
    updates: WireUpdate[];
    expected: Text;
}

/** The host's record of the document: its text, how many updates it has gone through, and a push being written. */
export class SyncLog {
    private count = 0;
    private pending: Pending | undefined;

    constructor(private current: Text) {}

    get doc(): Text { return this.current; }
    get version(): number { return this.count; }

    /**
     * A webview's push of updates based on `version`. Returns the combined
     * change to write to the document, or undefined when the push is behind,
     * malformed, or another push is still being written.
     */
    accept(version: number, updates: unknown): ChangeSet | undefined {
        if (this.pending || version !== this.count || !Array.isArray(updates) || !updates.length) { return undefined; }
        let total = ChangeSet.empty(this.current.length);
        const wire: WireUpdate[] = [];
        try {
            for (const update of updates as Array<Partial<WireUpdate>>) {
                if (!update || typeof update.clientID !== 'string' || !update.clientID || update.clientID === HOST_CLIENT) { return undefined; }
                const changes = ChangeSet.fromJSON(update.changes);
                if (changes.length !== total.newLength) { return undefined; }
                total = total.compose(changes);
                wire.push({ clientID: update.clientID, changes: changes.toJSON() });
            }
        } catch {
            return undefined;
        }
        this.pending = { updates: wire, expected: total.apply(this.current) };
        return total;
    }

    /** True while an accepted push has not shown up as a document change. */
    get writing(): boolean { return !!this.pending; }

    /** Forget the push being written (its write failed, or the two sides lost track). */
    abandon(): void { this.pending = undefined; }

    /**
     * Any change to the document. When it is exactly the push being written,
     * the push's own updates are recorded, so the webview recognizes them as
     * its own; anything else is the host's. Returns what to broadcast.
     */
    record(changes: ChangeSet): { version: number; updates: WireUpdate[] } {
        const version = this.count;
        const next = changes.apply(this.current);
        let updates: WireUpdate[];
        if (this.pending && next.eq(this.pending.expected)) {
            updates = this.pending.updates;
            this.pending = undefined;
        } else {
            updates = [{ clientID: HOST_CLIENT, changes: changes.toJSON() }];
        }
        this.current = next;
        this.count += updates.length;
        return { version, updates };
    }

    /** Start over from the document's text, at the current version, after the two sides lost track. */
    reset(doc: Text): void {
        this.current = doc;
        this.pending = undefined;
    }
}
