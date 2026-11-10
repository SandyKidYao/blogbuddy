import type { Memento } from 'vscode';

const KEY_PREFIX = 'blogbuddy.notes:';

/**
 * Keeps each document's margin notes in the extension's own storage, so
 * nothing is written next to the writer's files. Notes are opaque here: the
 * editor webview owns their shape.
 */
export class NoteStore {
    constructor(private readonly memento: Memento) {}

    load(filePath: string): unknown[] {
        const notes = this.memento.get<unknown[]>(KEY_PREFIX + filePath);
        return Array.isArray(notes) ? notes : [];
    }

    save(filePath: string, notes: unknown[]): void {
        void this.memento.update(KEY_PREFIX + filePath, notes.length ? notes : undefined);
    }
}
