import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import {registerAllCommands} from './commands';


export function activate(context: vscode.ExtensionContext) {
	// Modules without the VS Code API (core, agent services) translate through @vscode/l10n.
	if (vscode.l10n.bundle) { l10n.config({ contents: vscode.l10n.bundle }); }
	registerAllCommands(context);
}

export function deactivate() {
}
