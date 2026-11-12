import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { ChangeSet, EditorState, type ChangeSpec } from '@codemirror/state';
import { WebviewBridge } from '../../services/WebviewBridge';
import type { HostMessage, WebviewMessage } from '../../services/webviewProtocol';

/**
 * The bridge against a real TextDocument: a scripted @codemirror/collab
 * client plays the webview, and edits from "elsewhere" are WorkspaceEdits,
 * as a text editor or an extension would make them.
 */
suite('WebviewBridge document sync', () => {
    let dir: string;
    let file: string;
    let document: vscode.TextDocument;
    let bridge: WebviewBridge;
    let messages: HostMessage[];
    let receive: (message: WebviewMessage) => Promise<void>;
    let asked: string[];
    let selections: string[];
    let client: EditorState;
    let epoch: number;

    async function open(content: string): Promise<void> {
        file = path.join(dir, `doc-${messages.length}-${Date.now()}.md`);
        await fs.writeFile(file, content);
        document = await vscode.workspace.openTextDocument(file);
        const webview = {
            onDidReceiveMessage: (listener: (message: WebviewMessage) => Promise<void>) => { receive = listener; return new vscode.Disposable(() => {}); },
            postMessage: (message: HostMessage) => { messages.push(message); return Promise.resolve(true); },
            asWebviewUri: (uri: vscode.Uri) => uri,
        } as unknown as vscode.Webview;
        bridge = new WebviewBridge(webview, document, {
            askNote: async ask => { asked.push(ask.scopeMarkdown); return { reply: 'ok', agent: 'test', seconds: 1 }; },
            loadNotes: () => [{ id: 'kept' }],
            onSelection: selection => selections.push(selection),
        });
        await receive({ type: 'ready' });
        const init = messages.find(message => message.type === 'init');
        assert.ok(init?.type === 'init');
        epoch = init.epoch;
        client = EditorState.create({ doc: init.text, extensions: [collab({ startVersion: init.version, clientID: 'web' })] });
    }

    /** Hand the client every update the host has broadcast since it last looked. */
    let seen = 0;
    function catchUp(): void {
        for (; seen < messages.length; seen++) {
            const message = messages[seen];
            if (message.type !== 'updates' || message.epoch !== epoch) { continue; }
            const synced = getSyncedVersion(client);
            const fresh = message.updates.slice(synced - message.version);
            if (fresh.length) {
                client = receiveUpdates(client, fresh.map(u => ({ clientID: u.clientID, changes: ChangeSet.fromJSON(u.changes) }))).state;
            }
        }
    }

    function type(changes: ChangeSpec): void { client = client.update({ changes }).state; }

    /** Push what the client has, as the webview does; returns whether the host wrote it. */
    async function push(): Promise<boolean> {
        const updates = sendableUpdates(client);
        const before = messages.length;
        await receive({ type: 'push', epoch, version: getSyncedVersion(client), updates: updates.map(u => ({ clientID: u.clientID, changes: u.changes.toJSON() })) });
        catchUp();
        const result = messages.slice(before).find(message => message.type === 'push-result');
        return result?.type === 'push-result' && result.ok;
    }

    async function elsewhere(edit: (edit: vscode.WorkspaceEdit) => void): Promise<void> {
        const workspaceEdit = new vscode.WorkspaceEdit();
        edit(workspaceEdit);
        assert.ok(await vscode.workspace.applyEdit(workspaceEdit));
    }

    const text = (): string => document.getText();

    setup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-sync-'));
        messages = []; asked = []; selections = []; seen = 0;
    });
    teardown(async () => {
        bridge.dispose();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        if (document.isDirty) { await vscode.commands.executeCommand('workbench.action.files.revert'); }
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('the webview gets the document and the notes kept for it', async () => {
        await open('# Title\n\nBody\n');
        const init = messages.find(m => m.type === 'init');
        assert.ok(init?.type === 'init' && init.text === '# Title\n\nBody\n');
        assert.strictEqual(init.notes?.length, 1);
    });

    test('typing in the webview edits the document, and comes back as its own', async () => {
        await open('# Title\n\nBody\n');
        type({ from: 13, insert: ' text' });
        assert.ok(await push());
        assert.strictEqual(text(), '# Title\n\nBody text\n');
        assert.strictEqual(sendableUpdates(client).length, 0, 'the push was confirmed');
        assert.ok(document.isDirty, 'VS Code tracks the unsaved change');
    });

    test('edits made elsewhere reach the webview', async () => {
        await open('one\ntwo\n');
        await elsewhere(e => e.insert(document.uri, new vscode.Position(1, 0), 'and '));
        catchUp();
        assert.strictEqual(client.doc.toString(), 'one\nand two\n');
    });

    test('an edit made elsewhere first: the webview\'s push is refused, rebased and written', async () => {
        await open('alpha\nbeta\n');
        type({ from: 5, insert: '!' });
        await elsewhere(e => e.insert(document.uri, new vscode.Position(1, 0), 'big '));
        // The push is based on a version the document has left behind.
        const stale = sendableUpdates(client);
        await receive({ type: 'push', epoch, version: 0, updates: stale.map(u => ({ clientID: u.clientID, changes: u.changes.toJSON() })) });
        assert.ok(messages.some(m => m.type === 'push-result' && !m.ok));
        catchUp();
        assert.strictEqual(client.doc.toString(), 'alpha!\nbig beta\n');
        assert.ok(await push());
        assert.strictEqual(text(), 'alpha!\nbig beta\n');
        assert.strictEqual(client.doc.toString(), text());
    });

    test('a CRLF file stays CRLF', async () => {
        await open('Title\r\n\r\nBody\r\n');
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        type({ from: 12, insert: 'Line one\nLine two\n' });
        assert.ok(await push());
        assert.strictEqual(text(), 'Title\r\n\r\nBody\r\nLine one\r\nLine two\r\n');
        await elsewhere(e => e.replace(document.uri, new vscode.Range(0, 0, 0, 5), 'Heading'));
        catchUp();
        assert.strictEqual(client.doc.toString(), 'Heading\n\nBody\nLine one\nLine two\n');
    });

    test('a file changed on disk and reloaded moves only what changed', async () => {
        await open('first\nsecond\nthird\n');
        await fs.writeFile(file, 'first\nSECOND\nthird\n');
        await vscode.commands.executeCommand('vscode.open', document.uri);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        for (let i = 0; i < 100 && text() !== 'first\nSECOND\nthird\n'; i++) { await new Promise(r => setTimeout(r, 20)); }
        const update = messages.find(m => m.type === 'updates');
        assert.ok(update?.type === 'updates');
        const changes = ChangeSet.fromJSON(update.updates[0].changes);
        const touched: Array<[number, number]> = [];
        changes.iterChanges((fromA, toA) => touched.push([fromA, toA]));
        assert.deepStrictEqual(touched, [[6, 12]]);
        catchUp();
        assert.strictEqual(client.doc.toString(), 'first\nSECOND\nthird\n');
    });

    test('BB Editor leaves saving to VS Code: nothing is written until ⌘S', async () => {
        await open('draft\n');
        type({ from: 5, insert: ' saved' });
        assert.ok(await push());
        await new Promise(r => setTimeout(r, 300));
        assert.ok(document.isDirty);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'draft\n');
        // ⌘S saves the active editor; here the document's own text editor plays that part.
        await vscode.window.showTextDocument(document);
        await receive({ type: 'save' });
        assert.ok(!document.isDirty);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'draft saved\n');
    });

    test('with VS Code\'s auto save on, BB Editor\'s edits are saved by it', async function () {
        this.timeout(10000);
        const files = vscode.workspace.getConfiguration('files');
        await files.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
        await files.update('autoSaveDelay', 100, vscode.ConfigurationTarget.Global);
        try {
            await open('auto\n');
            type({ from: 4, insert: ' saved' });
            assert.ok(await push());
            for (let i = 0; i < 150 && document.isDirty; i++) { await new Promise(r => setTimeout(r, 20)); }
            assert.strictEqual(await fs.readFile(file, 'utf8'), 'auto saved\n');
        } finally {
            await files.update('autoSave', undefined, vscode.ConfigurationTarget.Global);
            await files.update('autoSaveDelay', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('a push from an earlier session is turned away', async () => {
        await open('x\n');
        type({ from: 1, insert: 'y' });
        const updates = sendableUpdates(client).map(u => ({ clientID: u.clientID, changes: u.changes.toJSON() }));
        await receive({ type: 'push', epoch: epoch + 1, version: 0, updates });
        assert.strictEqual(text(), 'x\n');
        await receive({ type: 'resync' });
        const inits = messages.filter(m => m.type === 'init');
        assert.strictEqual(inits.length, 2);
        assert.ok(inits[1].type === 'init' && inits[1].epoch > epoch);
        assert.ok(inits[1].type === 'init' && inits[1].notes === undefined, 'a resync keeps the notes the webview has open');
    });

    test('the selection is read from the document, for the status bar', async () => {
        await open('first line\nsecond\n');
        await receive({ type: 'selection', from: 11, to: 17 });
        assert.deepStrictEqual(selections, ['second']);
    });

    test('a margin note reaches the agent and its answer returns without touching the document', async () => {
        await open('Paragraph\n');
        type({ from: 9, insert: ' unsaved' });
        assert.ok(await push());
        await receive({ type: 'note-ask', requestId: 'r1', question: 'shorter?', scopeKind: 'block', scopeMarkdown: 'Paragraph', history: [] });
        assert.deepStrictEqual(asked, ['Paragraph']);
        assert.ok(messages.some(m => m.type === 'note-done' && m.requestId === 'r1'));
        assert.strictEqual(text(), 'Paragraph unsaved\n');
        assert.ok(document.isDirty, 'asking a note does not save the document');
    });
});
