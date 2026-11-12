import * as l10n from '@vscode/l10n';

/**
 * Translations for the webview: the host embeds VS Code's bundle for the
 * display language as inert JSON in the page (empty for English, where the
 * English source text is shown as it is). Imported first by index.ts, so the
 * bundle is in place before any module asks for a string; even so, strings
 * are looked up when used, never at module load.
 */
try {
    const contents: unknown = JSON.parse(document.getElementById('bb-l10n')?.textContent || '{}');
    if (contents && typeof contents === 'object' && Object.keys(contents).length) {
        l10n.config({ contents: contents as Record<string, string> });
    }
} catch {
    // Unreadable bundle: show English rather than fail.
}
