import * as vscode from 'vscode';
import {registerAllCommands} from './commands';


export function activate(context: vscode.ExtensionContext) {
	registerAllCommands(context);
}

export function deactivate() {
}
