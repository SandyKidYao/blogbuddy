import * as vscode from 'vscode';
import { MarkdownStatsAnalyzer } from '../utils/MarkdownStatsAnalyzer';
import { extractFrontmatter } from '../utils/frontmatter';
import { editorStatus } from '../services/EditorStatus';

interface EditorDocumentStats {
    words: number;
    characters: number;
    lines: number;
    selectedWords: number;
}

export function registerDocumentInfoCommand(context: vscode.ExtensionContext) {
    const display = new DocumentInfoStatusBar(context);
    context.subscriptions.push(display);
}

class DocumentInfoStatusBar implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private readonly markdownAnalyzer = new MarkdownStatsAnalyzer();
    private readonly statusBarItem: vscode.StatusBarItem;
    private updateTimeout?: NodeJS.Timeout;

    constructor(context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        context.subscriptions.push(this.statusBarItem);

        this.setupEventListeners();
        // Initial render.
        this.scheduleUpdate();
    }

    private setupEventListeners(): void {
        this.disposables.push(
            editorStatus.onDidChange(() => this.scheduleUpdate()),
            vscode.window.onDidChangeTextEditorSelection(() => this.scheduleUpdate()),
            vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
            vscode.workspace.onDidChangeTextDocument((event) => {
                const shown = editorStatus.current?.document ?? vscode.window.activeTextEditor?.document;
                if (event.document === shown) { this.scheduleUpdate(); }
            }),
        );
    }

    private scheduleUpdate(): void {
        if (this.updateTimeout) { clearTimeout(this.updateTimeout); }
        this.updateTimeout = setTimeout(() => this.refresh(), 300);
    }

    /** The same counts for BB Editor and the text editor, both from the TextDocument. */
    private refresh(): void {
        const live = editorStatus.current;
        const editor = vscode.window.activeTextEditor;
        const document = live?.document ?? (editor?.document.languageId === 'markdown' ? editor.document : undefined);
        if (!document) {
            this.statusBarItem.hide();
            return;
        }

        try {
            const stats = this.markdownAnalyzer.analyze(extractFrontmatter(document.getText()).body);
            const selection = live ? live.selection : editor && !editor.selection.isEmpty ? document.getText(editor.selection) : '';
            const selected = selection ? this.markdownAnalyzer.analyze(selection) : undefined;
            this.show({
                words: stats.chineseCharacters + stats.englishWords,
                characters: stats.totalCharacters,
                lines: document.lineCount,
                selectedWords: selected ? selected.chineseCharacters + selected.englishWords : 0,
            });
        } catch (error) {
            console.error('Failed to analyze document:', error);
            this.statusBarItem.hide();
        }
    }

    /** Same label and tooltip for the BB Editor and the plain text editor. */
    private show(stats: EditorDocumentStats): void {
        this.statusBarItem.text = `$(edit) ${stats.words} 字${stats.selectedWords ? ` · 已选 ${stats.selectedWords}` : ''}`;
        this.statusBarItem.tooltip = `${stats.characters} 字符 · ${stats.lines} 行`;
        this.statusBarItem.show();
    }

    public dispose(): void {
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = undefined;
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.statusBarItem.hide();
        this.statusBarItem.dispose();
    }
}
