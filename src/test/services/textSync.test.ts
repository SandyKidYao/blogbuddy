import * as assert from 'assert';
import { collab, getSyncedVersion, receiveUpdates, sendableUpdates, type Update } from '@codemirror/collab';
import { ChangeSet, EditorState } from '@codemirror/state';
import { changesFromEdits, editsFromChanges, HOST_CLIENT, SyncLog, textOf, type RangeEdit, type WireUpdate } from '../../services/textSync';

/** Apply range edits (all against the original text) the way a WorkspaceEdit does. */
function applyRangeEdits(text: string, edits: RangeEdit[], eol: string): string {
    const lines = text.split(eol);
    const offset = (line: number, character: number): number =>
        lines.slice(0, line).reduce((sum, l) => sum + l.length + eol.length, 0) + character;
    return edits
        .map(edit => ({ from: offset(edit.startLine, edit.startCharacter), to: offset(edit.endLine, edit.endCharacter), text: edit.text }))
        .sort((a, b) => b.from - a.from)
        .reduce((result, edit) => result.slice(0, edit.from) + edit.text + result.slice(edit.to), text);
}

const fromWire = (updates: WireUpdate[]): Update[] =>
    updates.map(update => ({ clientID: update.clientID, changes: ChangeSet.fromJSON(update.changes) }));

const toWire = (updates: readonly Update[]): WireUpdate[] =>
    updates.map(update => ({ clientID: update.clientID, changes: update.changes.toJSON() }));

const webview = (log: SyncLog): EditorState =>
    EditorState.create({ doc: log.doc.toString(), extensions: [collab({ startVersion: log.version, clientID: 'web' })] });

suite('textSync', () => {
    test('VS Code positions map to offsets in the "\\n" mirror of a CRLF document', () => {
        const doc = textOf('# Title\r\n\r\nFirst line\r\nsecond line\r\n');
        assert.strictEqual(doc.toString(), '# Title\n\nFirst line\nsecond line\n');
        const changes = changesFromEdits(doc, [{ startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 6, text: 'Second' }]);
        assert.strictEqual(changes.apply(doc).toString(), '# Title\n\nFirst line\nSecond line\n');
    });

    test('several changes in one event apply in order', () => {
        const doc = textOf('a\nb\nc');
        const changes = changesFromEdits(doc, [
            { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 1, text: 'C' },
            { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, text: 'A\r\nA2' },
        ]);
        assert.strictEqual(changes.apply(doc).toString(), 'A\nA2\nb\nC');
    });

    test('a whole-document replacement is narrowed to what changed', () => {
        const doc = textOf('one\ntwo\nthree\n');
        const changes = changesFromEdits(doc, [{ startLine: 0, startCharacter: 0, endLine: 3, endCharacter: 0, text: 'one\nTWO\nthree\n' }]);
        const touched: Array<[number, number, string]> = [];
        changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => touched.push([fromA, toA, inserted.toString()]));
        assert.deepStrictEqual(touched, [[4, 7, 'TWO']]);
    });

    test('webview changes become range edits that keep a CRLF document CRLF', () => {
        const original = 'Title\r\n\r\nBody text\r\n';
        const doc = textOf(original);
        const changes = ChangeSet.of([{ from: 0, to: 5, insert: 'New title' }, { from: 7, insert: 'Line one\nLine two ' }], doc.length);
        const result = applyRangeEdits(original, editsFromChanges(doc, changes, '\r\n'), '\r\n');
        assert.strictEqual(result, 'New title\r\n\r\nLine one\r\nLine two Body text\r\n');
    });

    test('a push comes back as the webview\'s own updates, so it can confirm them', () => {
        const log = new SyncLog(textOf('hello'));
        let state = webview(log);
        state = state.update({ changes: { from: 5, insert: ' world' } }).state;
        const changes = log.accept(getSyncedVersion(state), toWire(sendableUpdates(state)));
        assert.ok(changes);
        // VS Code applies the edit and reports it back as a document change.
        const { version, updates } = log.record(changes);
        assert.strictEqual(version, 0);
        assert.deepStrictEqual(updates.map(update => update.clientID), ['web']);
        state = receiveUpdates(state, fromWire(updates)).state;
        assert.strictEqual(sendableUpdates(state).length, 0);
        assert.strictEqual(state.doc.toString(), 'hello world');
        assert.strictEqual(log.version, 1);
    });

    test('a push based on an old version is turned away; the webview rebases and gets through', () => {
        const log = new SyncLog(textOf('alpha\nbeta'));
        let state = webview(log);
        state = state.update({ changes: { from: 5, insert: '!' } }).state;          // the writer types in BB Editor…
        const external = log.record(changesFromEdits(log.doc, [                      // …while a text editor changes line 2
            { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 0, text: 'big ' },
        ]));
        assert.strictEqual(log.accept(getSyncedVersion(state), toWire(sendableUpdates(state))), undefined);
        assert.strictEqual(external.updates[0].clientID, HOST_CLIENT);

        state = receiveUpdates(state, fromWire(external.updates)).state;
        assert.strictEqual(state.doc.toString(), 'alpha!\nbig beta');
        const changes = log.accept(getSyncedVersion(state), toWire(sendableUpdates(state)));
        assert.ok(changes);
        state = receiveUpdates(state, fromWire(log.record(changes).updates)).state;
        assert.strictEqual(log.doc.toString(), 'alpha!\nbig beta');
        assert.strictEqual(state.doc.toString(), log.doc.toString());
        assert.strictEqual(sendableUpdates(state).length, 0);
    });

    test('only one push is written at a time, and malformed pushes are refused', () => {
        const log = new SyncLog(textOf('x'));
        const insert = (at: number, text: string): WireUpdate[] =>
            [{ clientID: 'web', changes: ChangeSet.of({ from: at, insert: text }, 1).toJSON() }];
        assert.ok(log.accept(0, insert(1, 'y')));
        assert.strictEqual(log.accept(0, insert(0, 'z')), undefined);
        log.abandon();
        assert.strictEqual(log.accept(0, [{ clientID: 'web', changes: ChangeSet.of({ from: 0, insert: 'q' }, 7).toJSON() }]), undefined);
        assert.strictEqual(log.accept(0, [{ clientID: HOST_CLIENT, changes: ChangeSet.of({ from: 0, insert: 'q' }, 1).toJSON() }]), undefined);
        assert.strictEqual(log.accept(0, [{ clientID: 'web', changes: 'nonsense' }]), undefined);
    });

    test('a change that is not the pending push is recorded as the host\'s', () => {
        const log = new SyncLog(textOf('abc'));
        assert.ok(log.accept(0, [{ clientID: 'web', changes: ChangeSet.of({ from: 3, insert: 'd' }, 3).toJSON() }]));
        const other = log.record(ChangeSet.of({ from: 0, insert: '_' }, 3));
        assert.strictEqual(other.updates[0].clientID, HOST_CLIENT);
        assert.ok(log.writing, 'the push is still waiting for its own change');
    });
});
