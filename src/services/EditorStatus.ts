import * as vscode from 'vscode';

/** The focused BB Editor, as the status bar needs it: its document and the text selected in it. */
export interface LiveEditor {
    document: vscode.TextDocument;
    selection: string;
}

/**
 * Which BB Editor is focused. A BB Editor is not a TextEditor, so VS Code's
 * activeTextEditor and selection events do not cover it; the editor reports
 * here instead. Its text needs no reporting — it is the TextDocument's.
 */
class EditorStatus {
    private active?: string;
    private readonly editors = new Map<string, LiveEditor>();
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;

    get current(): LiveEditor | undefined {
        return this.active ? this.editors.get(this.active) : undefined;
    }

    open(id: string, document: vscode.TextDocument): void {
        this.editors.set(id, { document, selection: '' });
    }

    activate(id: string, active: boolean): void {
        if (active) { this.active = id; }
        else if (this.active === id) { this.active = undefined; }
        this.emitter.fire();
    }

    select(id: string, selection: string): void {
        const editor = this.editors.get(id);
        if (!editor) { return; }
        editor.selection = selection;
        if (this.active === id) { this.emitter.fire(); }
    }

    remove(id: string): void {
        this.editors.delete(id);
        this.activate(id, false);
    }
}

export const editorStatus = new EditorStatus();
