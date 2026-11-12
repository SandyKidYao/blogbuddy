import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Switching between the text editor and BB Editor (⌘⇧B both ways) with unsaved changes. */
suite('Switching editors', () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    /** The tabs showing one file: "bb" for BB Editor, "text" for a text editor. */
    const tabs = (uri: vscode.Uri): string[] => vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => (tab.input as { uri?: vscode.Uri }).uri?.toString() === uri.toString())
        .map(tab => tab.input instanceof vscode.TabInputCustom ? `bb:${tab.input.viewType}` : tab.input instanceof vscode.TabInputText ? 'text' : 'other');
    let dir: string;

    setup(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-switch-'));
    });
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('unsaved changes go along both ways, in place, and nothing is saved', async function () {
        this.timeout(20000);
        const file = path.join(dir, 'post.md');
        await fs.writeFile(file, 'hello\n');
        const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
        await editor.edit(edit => edit.insert(new vscode.Position(0, 5), ' typed in text'));
        const document = editor.document;

        await vscode.commands.executeCommand('blogbuddy.openEditor');
        await wait(1500);
        assert.deepStrictEqual(tabs(document.uri), ['bb:blogbuddy.editor'], 'BB Editor took the text editor\'s place');
        assert.ok(document.isDirty && document.getText() === 'hello typed in text\n');

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(1, 0), 'typed in BB\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await vscode.commands.executeCommand('blogbuddy.openSource');
        await wait(500);
        assert.deepStrictEqual(tabs(document.uri), ['text'], 'the text editor took BB Editor\'s place');
        assert.ok(document.isDirty && document.getText() === 'hello typed in text\ntyped in BB\n');
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'hello\n', 'nothing was saved on the writer\'s behalf');
    });
});
