import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { WebviewBridge } from '../services/WebviewBridge';
import { ReaderPanel } from './readerCommand';
import { isRenderCmd } from '../core/reader';
import { editorStatus } from '../services/EditorStatus';
import type { LayoutMode } from '../services/webviewProtocol';

export function registerEditorCommand(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('blogbuddy.openEditor', async (uri?: vscode.Uri) => {
            // Keybindings don't pass the selected file URI, so try fallbacks
            if (!uri) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.uri.fsPath.endsWith('.md')) {
                    uri = activeEditor.document.uri;
                } else {
                    // Show file picker as last resort
                    const picked = await vscode.window.showOpenDialog({
                        filters: { 'Markdown': ['md'] },
                        canSelectMany: false,
                    });
                    if (picked && picked.length > 0) {
                        uri = picked[0];
                    } else {
                        return;
                    }
                }
            }

            // Locate any text-editor tabs already showing this file so we can
            // open BB in the same column and then close them — "replace" UX.
            const uriStr = uri.toString();
            const matchingTabs: vscode.Tab[] = [];
            let targetColumn: vscode.ViewColumn | undefined;
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
                        matchingTabs.push(tab);
                        targetColumn ??= group.viewColumn;
                    }
                }
            }

            // Persist unsaved edits before we close the source tab, otherwise
            // the user would see a save prompt or lose content.
            const dirtyDoc = vscode.workspace.textDocuments.find(
                doc => doc.uri.toString() === uriStr && doc.isDirty,
            );
            if (dirtyDoc) {
                await dirtyDoc.save();
            }

            EditorPanel.createOrShow(context, uri, targetColumn);

            if (matchingTabs.length > 0) {
                await vscode.window.tabGroups.close(matchingTabs);
            }
        })
    );

    // Reverse of openEditor: swap the focused BB Editor panel back to a plain
    // text editor in the same column. Wired to the panel's title-bar icon and
    // Cmd+Shift+B (gated on activeWebviewPanelId), making the chord a toggle.
    context.subscriptions.push(
        vscode.commands.registerCommand('blogbuddy.openSource', () =>
            EditorPanel.openSourceForActivePanel()
        )
    );
}

class EditorPanel implements vscode.Disposable {
    private readonly statusId = crypto.randomUUID();
    private static panels = new Map<string, EditorPanel>();

    // The most recently focused BB Editor panel — the target of the
    // blogbuddy.openSource command, whose editor/title contribution can only
    // tell us "some BB Editor is active", not which one.
    private static activePanel: EditorPanel | undefined;

    // Layout mode (Zen / Editor) is a global UI preference — every open BB
    // Editor panel shows the same mode. Stored as a boolean (true = Editor)
    // under the key used before the rename, so existing choices carry over.
    private static readonly EDITOR_MODE_KEY = 'blogbuddy.editorWideMode';

    private panel: vscode.WebviewPanel;
    private bridge: WebviewBridge;
    private filePath?: string;
    private isDirty = false;
    private disposables: vscode.Disposable[] = [];

    static createOrShow(context: vscode.ExtensionContext, uri?: vscode.Uri, column?: vscode.ViewColumn): void {
        const filePath = uri?.fsPath;
        const key = filePath || `untitled-${Date.now()}`;

        const existing = filePath ? EditorPanel.panels.get(filePath) : undefined;
        if (existing) {
            existing.panel.reveal(column);
            return;
        }

        const panel = new EditorPanel(context, filePath, column);
        EditorPanel.panels.set(key, panel);

        panel.panel.onDidDispose(() => {
            EditorPanel.panels.delete(key);
            if (EditorPanel.activePanel === panel) {
                EditorPanel.activePanel = undefined;
            }
            panel.dispose();
        });
    }

    static async openSourceForActivePanel(): Promise<void> {
        await EditorPanel.activePanel?.openSource();
    }

    /**
     * Swap this panel back to a plain text editor in the same column —
     * the mirror of openEditor's "replace" UX. Pending edits are flushed to
     * disk first so the text editor opens with the latest content.
     */
    private async openSource(): Promise<void> {
        const filePath = this.bridge.currentFilePath;
        if (!filePath) {
            vscode.window.showInformationMessage(
                'This document has no file on disk yet — save it first (Cmd+S / Ctrl+S).'
            );
            return;
        }
        const column = this.panel.viewColumn;
        if (!await this.bridge.flushEdits(true)) {
            vscode.window.showWarningMessage('Save is incomplete. Resolve the conflict or save error before switching to Markdown source.');
            return;
        }
        try {
            await vscode.window.showTextDocument(vscode.Uri.file(filePath), { viewColumn: column, preview: false });
            this.panel.dispose();
        } catch (error) {
            this.bridge.resumeEdits();
            vscode.window.showErrorMessage(`Could not open Markdown source: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private constructor(
        private context: vscode.ExtensionContext,
        filePath?: string,
        column?: vscode.ViewColumn,
    ) {
        this.filePath = filePath;
        const title = filePath ? path.basename(filePath) : 'New Document';

        this.panel = vscode.window.createWebviewPanel(
            'blogbuddy.editor',
            title,
            column ?? vscode.ViewColumn.One,
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist'),
                    ...(filePath ? [vscode.Uri.file(path.dirname(filePath))] : []),
                ],
            },
        );

        this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');

        EditorPanel.activePanel = this;
        editorStatus.activate(this.statusId, true);
        this.disposables.push(
            this.panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.active) {
                    EditorPanel.activePanel = this;
                    this.bridge?.refreshFromDisk();
                }
                editorStatus.activate(this.statusId, e.webviewPanel.active);
            })
        );

        this.bridge = new WebviewBridge(this.panel, this.panel.webview, {
            filePath: this.filePath,
            onDirtyChange: (dirty) => this.setDirty(dirty),
            onReady: () => this.onWebviewReady(),
            onReaderDispatch: (cmd, msgText, content) => this.handleReaderDispatch(cmd, msgText, content),
            onToggleLayoutMode: () => this.toggleLayoutMode(),
            onStatsChange: (stats) => editorStatus.update(this.statusId, stats),
            onRecoverDraft: (content) => {
                void vscode.workspace.openTextDocument({ language: 'markdown', content })
                    .then(doc => vscode.window.showTextDocument(doc, { preview: false }));
                vscode.window.showWarningMessage('Your unsaved BB Editor changes were recovered in a new tab because the file could not be saved safely.');
            },
        });

        this.panel.webview.html = this.getWebviewHtml();

        // 监听主题变化
        this.disposables.push(
            vscode.window.onDidChangeActiveColorTheme((theme) => {
                this.bridge.post({
                    type: 'theme',
                    kind: theme.kind === vscode.ColorThemeKind.Light
                        ? 'light'
                        : theme.kind === vscode.ColorThemeKind.HighContrast || theme.kind === vscode.ColorThemeKind.HighContrastLight
                            ? 'highContrast'
                            : 'dark',
                });
            })
        );

        this.disposables.push(this.bridge);
    }

    private async onWebviewReady(): Promise<void> {
        // 发送主题信息
        const themeKind = vscode.window.activeColorTheme.kind;
        this.bridge.post({
            type: 'theme',
            kind: themeKind === vscode.ColorThemeKind.Light
                ? 'light'
                : themeKind === vscode.ColorThemeKind.HighContrast || themeKind === vscode.ColorThemeKind.HighContrastLight
                    ? 'highContrast'
                    : 'dark',
        });

        // The HTML already carries the mode; this syncs the toggle's tooltip.
        this.bridge.post({ type: 'set-layout-mode', mode: this.layoutMode() });

        // 加载文件内容
        if (this.filePath) {
            try {
                const content = await fs.readFile(this.filePath, 'utf-8');
                this.bridge.sendLoad(content, this.filePath);
            } catch (error) {
                const msg = error instanceof Error ? error.message : 'Failed to read file';
                vscode.window.showErrorMessage(`Failed to open file: ${msg}`);
            }
        } else {
            this.bridge.sendLoad('');
        }
    }

    private async handleReaderDispatch(cmd: string, msgText: string, content: string): Promise<void> {
        if (!this.filePath) {
            vscode.window.showInformationMessage('Save the file first to use the AI Reader.');
            return;
        }
        if (!isRenderCmd(cmd)) {
            return;
        }
        try {
            // The bridge has already committed and flushed the full snapshot.
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.filePath));
            await ReaderPanel.openForDocument(this.context, doc, cmd, msgText);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to open AI Reader: ${message}`);
        }
    }

    private setDirty(dirty: boolean): void {
        this.isDirty = dirty;
        const baseName = this.filePath ? path.basename(this.filePath) : 'New Document';
        this.panel.title = dirty ? `● ${baseName}` : baseName;
    }

    private layoutMode(): LayoutMode {
        // Editor Mode is the default; Zen is opt-in.
        return this.context.globalState.get<boolean>(EditorPanel.EDITOR_MODE_KEY, true) ? 'editor' : 'zen';
    }

    /**
     * Flip between Zen and Editor mode, persist it, and push the new mode to
     * every open BB Editor panel so they all stay in sync. Called when the
     * webview clicks the toggle button.
     */
    private async toggleLayoutMode(): Promise<void> {
        const next: LayoutMode = this.layoutMode() === 'zen' ? 'editor' : 'zen';
        await this.context.globalState.update(EditorPanel.EDITOR_MODE_KEY, next === 'editor');
        for (const p of EditorPanel.panels.values()) {
            p.bridge.post({ type: 'set-layout-mode', mode: next });
        }
    }

    private getWebviewHtml(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   font-src ${webview.cspSource};
                   img-src ${webview.cspSource} data: https:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>BB Editor</title>
</head>
<body class="bb-mode-${this.layoutMode()}">
    <button id="mode-toggle" class="bb-mode-toggle" type="button" aria-label="切换 Zen Mode / Editor Mode">
        <span class="bb-mode-toggle__label bb-mode-toggle__label-zen">Z</span>
        <span class="bb-mode-toggle__label bb-mode-toggle__label-editor">E</span>
    </button>
    <div id="conflict-banner" class="conflict-banner hidden">
        <span class="conflict-msg">文件已被外部修改，自动保存已暂停。请选择加载外部版本，或用当前内容覆盖。</span>
        <button id="conflict-reload" class="conflict-btn">加载外部版本</button>
        <button id="conflict-keep" class="conflict-btn conflict-btn-primary">保留当前版本</button>
    </div>
    <div id="editor-layout"><div id="editor">
        <section id="frontmatter-panel" class="fm fm-collapsed" aria-label="文档属性" hidden>
            <div class="fm-head">
                <button id="frontmatter-toggle" class="fm-toggle" type="button" aria-expanded="false" title="展开 / 收起属性">
                    <span id="frontmatter-fence" class="fm-fence">---</span>
                    <span id="frontmatter-summary" class="fm-summary"></span>
                </button>
                <button id="frontmatter-source" class="fm-source-toggle" type="button" aria-pressed="false" title="编辑源码">{ }</button>
            </div>
            <div class="fm-body">
                <dl id="frontmatter-props" class="fm-props"></dl>
                <textarea id="frontmatter-editor" class="fm-raw" spellcheck="false" aria-label="属性源码"></textarea>
                <div class="fm-fence fm-close" aria-hidden="true">---</div>
            </div>
        </section>
    </div></div>
    <div id="status" class="bb-notice" role="status" aria-live="polite" hidden></div>
    <script id="editor-script" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    dispose(): void {
        editorStatus.remove(this.statusId);
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
