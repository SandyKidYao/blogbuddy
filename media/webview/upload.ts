import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import * as l10n from '@vscode/l10n';
import type { HostMessage, WebviewMessage } from '../../src/services/webviewProtocol';

/**
 * Files pasted or dropped into the editor: the host writes them beside the
 * document (or into blogbuddy.assetDir) and the editor inserts a Markdown
 * link to them — an image link for images.
 */

type Uploaded = Extract<HostMessage, { type: 'file-uploaded' }>;

interface UploadHost {
    post(message: WebviewMessage): void;
    notice(text: string): void;
}

const pending = new Map<string, { resolve: (result: Uploaded) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
/** Insert positions of uploads in flight, kept in step with edits made meanwhile. */
const spots = new Set<{ pos: number }>();

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/** A relative path as a Markdown link target: forward slashes, angle brackets when it has spaces or parentheses. */
const linkTarget = (path: string): string => {
    const slashed = path.replace(/\\/g, '/');
    return /[\s()<>]/.test(slashed) ? `<${slashed}>` : slashed;
};

async function upload(view: EditorView, host: UploadHost, files: File[], pos: number): Promise<void> {
    const spot = { pos };
    spots.add(spot);
    try {
        for (const file of files) {
            const dataBase64 = await fileToBase64(file);
            const uploadId = crypto.randomUUID();
            const result = await new Promise<Uploaded>((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(uploadId); reject(new Error(l10n.t('Upload timed out. Please try again.'))); }, 30000);
                pending.set(uploadId, { resolve, reject, timer });
                host.post({ type: 'file-upload', uploadId, fileName: file.name, mimeType: file.type, dataBase64 });
            });
            const name = result.fileName.replace(/[[\]]/g, '');
            const link = `${result.isImage ? '!' : ''}[${name}](${linkTarget(result.relativePath)})`;
            // The document may have been reloaded meanwhile; never insert past its end.
            spot.pos = Math.min(spot.pos, view.state.doc.length);
            const line = view.state.doc.lineAt(spot.pos);
            // An image starts its own line; a file link sits in the text.
            const insert = result.isImage && spot.pos > line.from ? `\n${link}` : link;
            view.dispatch({ changes: { from: spot.pos, insert }, selection: { anchor: spot.pos + insert.length }, userEvent: 'input.upload' });
        }
    } catch (error) {
        host.notice(l10n.t('Upload failed: {0}', error instanceof Error ? error.message : l10n.t('please try again')));
    } finally {
        spots.delete(spot);
    }
}

/** The host's answer to an upload. */
export function handleUploadMessage(message: HostMessage): void {
    if (message.type !== 'file-uploaded' && message.type !== 'file-upload-error') { return; }
    const entry = pending.get(message.uploadId);
    if (!entry) { return; }
    clearTimeout(entry.timer);
    pending.delete(message.uploadId);
    if (message.type === 'file-uploaded') { entry.resolve(message); } else { entry.reject(new Error(message.message)); }
}

export function fileUploads(host: UploadHost): Extension {
    return [
        EditorView.domEventHandlers({
            paste(event, view) {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (!files.length || !view.state.facet(EditorView.editable)) { return false; }
                event.preventDefault();
                void upload(view, host, files, view.state.selection.main.head);
                return true;
            },
            drop(event, view) {
                const files = Array.from(event.dataTransfer?.files ?? []);
                if (!files.length || !view.state.facet(EditorView.editable)) { return false; }
                event.preventDefault();
                void upload(view, host, files, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head);
                return true;
            },
        }),
        EditorView.updateListener.of(update => {
            if (update.docChanged) { for (const spot of spots) { spot.pos = update.changes.mapPos(spot.pos); } }
        }),
    ];
}
