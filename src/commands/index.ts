// commands/index.ts
import { ExtensionContext } from 'vscode';
import { registerDocumentInfoCommand } from './documentInfoCommand';
import { registerEditorCommand } from './editorCommand';

export function registerAllCommands(context: ExtensionContext) {
    registerDocumentInfoCommand(context);
    registerEditorCommand(context);
}
