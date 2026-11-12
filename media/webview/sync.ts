import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { ChangeSet, type Extension, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { HostMessage, WebviewMessage } from '../../src/services/webviewProtocol';

/**
 * The webview side of document sync (see src/services/textSync.ts).
 *
 * VS Code's TextDocument is the authority. Local edits are pushed as
 * @codemirror/collab updates, one push in flight at a time; everything the
 * document goes through comes back as numbered updates — our own, which
 * confirm the push, and everyone else's, which our unconfirmed edits are
 * rebased over. Nothing is pushed in the middle of an IME composition.
 */

const clientID = crypto.randomUUID();

/** After this many refused pushes in a row without news from the document, slow down and say so. */
const PATIENCE = 5;

export class DocumentSync {
    private epoch = 0;
    private ready = false;
    private pushing = false;
    private refused = 0;
    private retry?: ReturnType<typeof setTimeout>;
    private saveWhenSynced = false;

    constructor(
        private readonly view: () => EditorView | undefined,
        private readonly post: (message: WebviewMessage) => void,
        private readonly notice: (text: string) => void,
    ) {}

    /** The collab extension for a document received at `version`. */
    extension(version: number): Extension {
        return [
            collab({ startVersion: version, clientID }),
            EditorView.updateListener.of(update => {
                if (update.transactions.some(tr => tr.docChanged && !tr.annotation(Transaction.remote))) { this.push(); }
            }),
            EditorView.domEventHandlers({ compositionend: () => { setTimeout(() => this.push(), 0); } }),
        ];
    }

    /** A new sync session: the document as it is now. */
    start(epoch: number): void {
        this.epoch = epoch;
        this.ready = true;
        this.pushing = false;
        this.refused = 0;
        if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    }

    /** ⌘S: save once every local edit has reached the document. */
    save(): void {
        this.saveWhenSynced = true;
        this.push();
    }

    /** Send what the document has not confirmed yet. */
    push(): void {
        const view = this.view();
        if (!view || !this.ready || this.pushing || view.composing) { return; }
        const updates = sendableUpdates(view.state);
        if (!updates.length) {
            if (this.saveWhenSynced) { this.saveWhenSynced = false; this.post({ type: 'save' }); }
            return;
        }
        this.pushing = true;
        this.post({
            type: 'push', epoch: this.epoch, version: getSyncedVersion(view.state),
            updates: updates.map(update => ({ clientID: update.clientID, changes: update.changes.toJSON() })),
        });
    }

    handle(message: HostMessage): void {
        const view = this.view();
        if (!view || !this.ready) { return; }
        if (message.type === 'push-result') {
            if (message.epoch !== this.epoch) { return; }
            this.pushing = false;
            if (message.ok) { this.refused = 0; this.push(); return; }
            // The document moved on first: the updates it went through are on their way,
            // and our edits will be rebased over them. Try again shortly.
            this.refused++;
            if (this.refused === PATIENCE) { this.notice('文档暂时无法写入（只读或被占用），稍后会继续重试。'); }
            this.retry = setTimeout(() => { this.retry = undefined; this.push(); }, this.refused < PATIENCE ? 20 : 2000);
            return;
        }
        if (message.type !== 'updates' || message.epoch !== this.epoch) { return; }
        const synced = getSyncedVersion(view.state);
        if (message.version > synced) { this.post({ type: 'resync' }); return; }   // missed some: start over
        const fresh = message.updates.slice(synced - message.version);
        if (!fresh.length) { return; }
        try {
            view.dispatch(receiveUpdates(view.state, fresh.map(update => ({ clientID: update.clientID, changes: ChangeSet.fromJSON(update.changes) }))));
            this.refused = 0;
        } catch {
            this.post({ type: 'resync' });
        }
    }
}
