import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WebviewBridge } from '../../services/WebviewBridge';
import type { HostMessage, WebviewMessage } from '../../services/webviewProtocol';

suite('WebviewBridge save protocol', () => {
    let dir: string;
    let file: string;
    let bridge: WebviewBridge;
    let messages: HostMessage[];
    let receive: (message: WebviewMessage) => Promise<void>;
    let revision: number;
    let recovered: string[];
    let dirtyStates: boolean[];
    let panelClosed: boolean;
    setup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-bridge-'));
        file = path.join(dir, 'doc.md'); await fs.writeFile(file, 'original\n');
        messages = [];
        recovered = []; dirtyStates = []; panelClosed = false;
        const webview = {
            onDidReceiveMessage: (listener: (message: WebviewMessage) => Promise<void>) => { receive = listener; return new vscode.Disposable(() => {}); },
            // Like VS Code, a disposed webview throws instead of ignoring messages.
            postMessage: (message: HostMessage) => {
                if (panelClosed) { throw new Error('Webview is disposed'); }
                messages.push(message); return Promise.resolve(true);
            },
            asWebviewUri: (uri: vscode.Uri) => uri,
        } as unknown as vscode.Webview;
        bridge = new WebviewBridge({ webview } as vscode.WebviewPanel, webview, {
            filePath: file, onRecoverDraft: content => recovered.push(content),
            onDirtyChange: dirty => { if (panelClosed) { throw new Error('Webview is disposed'); } dirtyStates.push(dirty); },
        });
        bridge.sendLoad('original\n', file);
        const load = messages.find(message => message.type === 'load');
        assert.ok(load?.type === 'load'); revision = load.revision;
    });
    teardown(async () => { bridge.dispose(); await fs.rm(dir, { recursive: true, force: true }); });

    async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await predicate()) { return; }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail('Expected asynchronous editor state was not observed');
    }

    test('a clean editor follows external file updates with a new epoch', async () => {
        await fs.writeFile(file, 'agent update\n');
        await until(() => messages.some(message => message.type === 'load' && message.content === 'agent update\n'));
        const load = messages.slice().reverse().find(message => message.type === 'load');
        assert.ok(load?.type === 'load' && load.revision > revision);
        assert.ok(load.reloadId !== undefined);
        await receive({ type: 'reload-applied', reloadId: load.reloadId, revision: load.revision });
    });
    test('typing while an external reload is in transit preserves the local draft', async () => {
        await fs.writeFile(file, 'agent version\n'); bridge.refreshFromDisk();
        await until(() => messages.some(message => message.type === 'load' && message.reloadId !== undefined));
        const load = messages.slice().reverse().find(message => message.type === 'load');
        assert.ok(load?.type === 'load' && load.reloadId !== undefined);
        await receive({ type: 'document-change', revision, editVersion: 1, content: 'originalX\n', frontmatter: '' });
        await receive({ type: 'reload-rejected', reloadId: load.reloadId, revision, editVersion: 1, content: 'originalX\n', frontmatter: '' });
        assert.ok(messages.some(message => message.type === 'conflict'));
        bridge.dispose(); await until(() => recovered.length > 0);
        assert.deepStrictEqual(recovered, ['originalX\n']);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'agent version\n');
    });
    test('another external update during reload is proposed after the first acknowledgement', async () => {
        await fs.writeFile(file, 'agent v2\n'); bridge.refreshFromDisk();
        await until(() => messages.some(message => message.type === 'load' && message.content === 'agent v2\n'));
        const first = messages.slice().reverse().find(message => message.type === 'load');
        assert.ok(first?.type === 'load' && first.reloadId !== undefined);
        await fs.writeFile(file, 'agent v3\n');
        await receive({ type: 'reload-applied', reloadId: first.reloadId, revision: first.revision });
        await until(() => messages.some(message => message.type === 'load' && message.content === 'agent v3\n'));
        const second = messages.slice().reverse().find(message => message.type === 'load');
        assert.ok(second?.type === 'load' && second.reloadId !== undefined && second.revision > first.revision);
        await receive({ type: 'reload-applied', reloadId: second.reloadId, revision: second.revision });
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'agent v3\n');
    });
    test('an older save does not clear a newer dirty draft', async () => {
        await receive({ type: 'document-change', revision, editVersion: 1, content: 'first\n', frontmatter: '' });
        const writing = receive({ type: 'auto-save', revision, editVersion: 1, content: 'first\n', frontmatter: '' });
        await receive({ type: 'document-change', revision, editVersion: 2, content: 'second\n', frontmatter: '' });
        await writing;
        assert.strictEqual(dirtyStates[dirtyStates.length - 1], true);
        await receive({ type: 'auto-save', revision, editVersion: 2, content: 'second\n', frontmatter: '' });
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'second\n');
    });
    test('closing before the debounce saves the complete pending draft', async () => {
        await receive({ type: 'document-change', revision, editVersion: 1, content: 'last keystroke\n', frontmatter: '---\ntitle: Draft\n---\n' });
        bridge.dispose();
        await until(async () => (await fs.readFile(file, 'utf8')).includes('last keystroke'));
        assert.strictEqual(await fs.readFile(file, 'utf8'), '---\ntitle: Draft\n---\nlast keystroke\n');
        assert.deepStrictEqual(recovered, []);
    });
    test('closing during an external conflict recovers the draft without overwriting disk', async () => {
        await receive({ type: 'document-change', revision, editVersion: 1, content: 'my unsaved draft\n', frontmatter: '' });
        await fs.writeFile(file, 'agent version\n');
        bridge.dispose();
        await until(() => recovered.length > 0);
        assert.deepStrictEqual(recovered, ['my unsaved draft\n']);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'agent version\n');
    });
    test('closing after the file became unwritable recovers the draft', async () => {
        await receive({ type: 'document-change', revision, editVersion: 1, content: 'unsaved\n', frontmatter: '' });
        await fs.unlink(file);
        panelClosed = true; bridge.dispose();
        await until(() => recovered.length > 0);
        assert.deepStrictEqual(recovered, ['unsaved\n']);
        await assert.rejects(fs.access(file));
    });
    test('an unreadable file is reported once and never as a failed save', async function () {
        this.timeout(6000);
        await fs.unlink(file);
        await until(() => messages.some(message => message.type === 'notice'));
        await new Promise(resolve => setTimeout(resolve, 1800));
        assert.strictEqual(messages.filter(message => message.type === 'notice').length, 1);
        assert.ok(!messages.some(message => message.type === 'saved' && !message.success));
    });
    function noteBridge(options: ConstructorParameters<typeof WebviewBridge>[2]): { bridge: WebviewBridge; posted: HostMessage[]; send: (message: WebviewMessage) => Promise<void> } {
        const posted: HostMessage[] = [];
        let send: (message: WebviewMessage) => Promise<void> = async () => {};
        const webview = {
            onDidReceiveMessage: (listener: (message: WebviewMessage) => Promise<void>) => { send = listener; return new vscode.Disposable(() => {}); },
            postMessage: (message: HostMessage) => { posted.push(message); return Promise.resolve(true); },
            asWebviewUri: (uri: vscode.Uri) => uri,
        } as unknown as vscode.Webview;
        const noted = new WebviewBridge({ webview } as vscode.WebviewPanel, webview, { filePath: file, ...options });
        noted.sendLoad('original\n', file);
        return { bridge: noted, posted, send: message => send(message) };
    }
    const ask: WebviewMessage = { type: 'note-ask', requestId: 'r1', question: '收紧一点', scopeKind: 'block', scopeMarkdown: 'original', history: [] };

    test('a margin note reaches the agent and its answer returns without touching the file', async () => {
        const asked: string[] = [];
        const { bridge: noted, posted, send } = noteBridge({ askNote: async (note, onStep) => {
            asked.push(note.question); onStep('搜索：写作');
            return { reply: '改好了', replacement: 'rewritten', agent: 'Claude Code', seconds: 3 };
        } });
        await send(ask);
        noted.dispose();
        assert.deepStrictEqual(asked, ['收紧一点']);
        assert.ok(posted.some(message => message.type === 'note-progress' && message.step === '搜索：写作'));
        const done = posted.find(message => message.type === 'note-done');
        assert.ok(done?.type === 'note-done' && done.replacement === 'rewritten' && done.requestId === 'r1');
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'original\n');
    });
    test('a cancelled margin note reports neither an answer nor an error', async () => {
        let release: () => void = () => {};
        const { bridge: noted, posted, send } = noteBridge({ askNote: (_note, _onStep, signal) => new Promise((resolve, reject) => {
            release = () => resolve({ reply: 'late', agent: 'Codex', seconds: 1 });
            signal.addEventListener('abort', () => reject(new Error('已取消')));
        }) });
        const pending = send(ask);
        await send({ type: 'note-cancel', requestId: 'r1' });
        release();
        await pending;
        noted.dispose();
        assert.ok(!posted.some(message => message.type === 'note-done' || message.type === 'note-error'));
    });
    test('an agent failure is reported on the note that asked', async () => {
        const { bridge: noted, posted, send } = noteBridge({ askNote: async () => { throw new Error('没有找到 claude 或 codex 命令。'); } });
        await send(ask);
        noted.dispose();
        const failed = posted.find(message => message.type === 'note-error');
        assert.ok(failed?.type === 'note-error' && failed.requestId === 'r1' && failed.message.includes('claude'));
    });
    test('notes saved for a document come back when it is opened again', async () => {
        const kept = new Map<string, unknown[]>();
        const options = { loadNotes: (path: string) => kept.get(path) ?? [], saveNotes: (path: string, notes: unknown[]) => { kept.set(path, notes); } };
        const first = noteBridge(options);
        await first.send({ type: 'notes-save', notes: [{ id: 'n1' }] });
        first.bridge.dispose();
        const second = noteBridge(options);
        second.bridge.dispose();
        const loaded = second.posted.find(message => message.type === 'notes-load');
        assert.ok(loaded?.type === 'notes-load');
        assert.deepStrictEqual(loaded.notes, [{ id: 'n1' }]);
    });

    test('external content is not overwritten when a local autosave arrives', async () => {
        await receive({ type: 'dirty', isDirty: true, revision, editVersion: 1 });
        await fs.writeFile(file, 'agent version\n');
        await receive({ type: 'auto-save', revision, editVersion: 1, content: 'my edit\n', frontmatter: '' });
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'agent version\n');
        assert.ok(messages.some(message => message.type === 'conflict'));
    });
    test('late saves from an old load cannot change the current document', async () => {
        await fs.writeFile(file, 'new load\n'); bridge.sendLoad('new load\n', file);
        await receive({ type: 'auto-save', revision, editVersion: 99, content: 'old content\n', frontmatter: '' });
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'new load\n');
    });
    test('body and frontmatter are committed in one snapshot', async () => {
        await receive({ type: 'save', revision, editVersion: 1, content: '# Body\n', frontmatter: '---\ntitle: New\n---\n' });
        assert.strictEqual(await fs.readFile(file, 'utf8'), '---\ntitle: New\n---\n# Body\n');
        assert.ok(messages.some(message => message.type === 'saved' && message.success));
    });
    test('a conflict blocks flushing instead of reporting success', async () => {
        await receive({ type: 'dirty', isDirty: true, revision, editVersion: 1 });
        await fs.writeFile(file, 'agent version\n');
        const flush = bridge.flushEdits();
        const request = messages.slice().reverse().find(message => message.type === 'request-save');
        assert.ok(request?.type === 'request-save');
        await receive({ type: 'auto-save', revision, editVersion: 1, content: 'local\n', frontmatter: '', flushId: request.flushId });
        assert.strictEqual(await flush, false);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'agent version\n');
    });
    test('a previous save cannot resolve a newer flush request', async () => {
        const flush = bridge.flushEdits();
        await receive({ type: 'auto-save', revision, editVersion: 1, content: 'saved\n', frontmatter: '' });
        let resolved = false; void flush.then(() => { resolved = true; });
        await Promise.resolve(); assert.strictEqual(resolved, false);
        const request = messages.slice().reverse().find(message => message.type === 'request-save');
        assert.ok(request?.type === 'request-save');
        await receive({ type: 'flush-noop', revision, flushId: request.flushId });
        assert.strictEqual(await flush, true);
    });
    test('flush waits for a newer edit that arrives while its snapshot is being saved', async () => {
        await receive({ type: 'document-change', revision, editVersion: 1, content: 'draft v1\n', frontmatter: '' });
        const flush = bridge.flushEdits(true);
        const request = messages.slice().reverse().find(message => message.type === 'request-save');
        assert.ok(request?.type === 'request-save' && request.freeze);
        const writing = receive({ type: 'auto-save', revision, editVersion: 1, content: 'draft v1\n', frontmatter: '', flushId: request.flushId });
        await receive({ type: 'document-change', revision, editVersion: 2, content: 'draft v2\n', frontmatter: '' });
        await writing;
        let resolved = false; void flush.then(() => { resolved = true; });
        await Promise.resolve(); assert.strictEqual(resolved, false);
        assert.ok(messages.filter(message => message.type === 'request-save' && message.flushId === request.flushId).length >= 2);
        await receive({ type: 'auto-save', revision, editVersion: 2, content: 'draft v2\n', frontmatter: '', flushId: request.flushId });
        assert.strictEqual(await flush, true);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'draft v2\n');
    });
    test('a failed transition unlocks the editor and keeps its local changes', async () => {
        const flush = bridge.flushEdits(true);
        const request = messages.slice().reverse().find(message => message.type === 'request-save');
        assert.ok(request?.type === 'request-save');
        await receive({ type: 'flush-failed', flushId: request.flushId });
        assert.strictEqual(await flush, false);
        assert.ok(messages.some(message => message.type === 'edit-unlock'));
    });
    test('a timed out frozen flush cancels its deferred IME request by id', async function () {
        this.timeout(7000); // waits out the bridge's 5s flush timeout
        const flush = bridge.flushEdits(true);
        const request = messages.slice().reverse().find(message => message.type === 'request-save');
        assert.ok(request?.type === 'request-save');
        assert.strictEqual(await flush, false);
        assert.ok(messages.some(message => message.type === 'edit-unlock' && message.flushId === request.flushId));
    });
    test('keeping a conflict does not authorize overwriting another external update', async () => {
        await receive({ type: 'dirty', isDirty: true, revision, editVersion: 1 });
        await fs.writeFile(file, 'agent v2\n');
        await receive({ type: 'auto-save', revision, editVersion: 1, content: 'local\n', frontmatter: '' });
        const conflict = messages.slice().reverse().find(message => message.type === 'conflict');
        assert.ok(conflict?.type === 'conflict');
        await fs.writeFile(file, 'agent v3\n');
        await receive({ type: 'conflict-resolve', revision, conflictId: conflict.conflictId, choice: 'keep' });
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'agent v3\n');
        assert.ok(!messages.some(message => message.type === 'rebase'));
    });
});
