import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import * as l10n from '@vscode/l10n';

/**
 * Slash menu: "/" at the start of a line offers block types. Choosing one
 * writes that block's Markdown in place of the "/…" typed so far.
 */

/** `keywords` are English and match by prefix in every display language, alongside the translated label. */
interface SlashItem { label: string; keywords: string[]; detail: string; insert: string; caret?: number }

function items(): SlashItem[] {
    return [
        { label: l10n.t('Heading 1'), keywords: ['heading 1', 'h1'], detail: '#', insert: '# ' },
        { label: l10n.t('Heading 2'), keywords: ['heading 2', 'h2'], detail: '##', insert: '## ' },
        { label: l10n.t('Heading 3'), keywords: ['heading 3', 'h3'], detail: '###', insert: '### ' },
        { label: l10n.t('Bullet List'), keywords: ['bullet list', 'ul'], detail: '-', insert: '- ' },
        { label: l10n.t('Ordered List'), keywords: ['ordered list', 'ol'], detail: '1.', insert: '1. ' },
        { label: l10n.t('Task List'), keywords: ['task list', 'todo'], detail: '- [ ]', insert: '- [ ] ' },
        { label: l10n.t('Code Block'), keywords: ['code block'], detail: '```', insert: '```\n\n```', caret: 3 },
        { label: l10n.t('Blockquote'), keywords: ['blockquote', 'quote'], detail: '>', insert: '> ' },
        { label: l10n.t('Table'), keywords: ['table'], detail: '|', insert: '|  |  |\n| --- | --- |\n|  |  |', caret: 2 },
        { label: l10n.t('Divider'), keywords: ['divider', 'hr'], detail: '---', insert: '---\n' },
    ];
}

function apply(item: SlashItem) {
    return (view: EditorView, _completion: Completion, from: number, to: number): void => {
        const caret = from + (item.caret ?? item.insert.length);
        view.dispatch({ changes: { from, to, insert: item.insert }, selection: { anchor: caret }, userEvent: 'input.complete' });
    };
}

/** Offered only when the line so far is "/" plus letters or digits; what follows "/" narrows the list by label or keyword. */
function slashSource(context: CompletionContext): CompletionResult | null {
    const line = context.state.doc.lineAt(context.pos);
    const match = /^(\s*)\/([\p{L}\p{N} ]*)$/u.exec(line.text.slice(0, context.pos - line.from));
    if (!match) { return null; }
    const typed = match[2].trim().toLowerCase();
    const options = items().filter(item => item.label.toLowerCase().includes(typed) || item.keywords.some(keyword => keyword.startsWith(typed)))
        .map(item => ({ label: item.label, detail: item.detail, apply: apply(item) }));
    return options.length ? { from: line.from + match[1].length, to: context.pos, options, filter: false } : null;
}

export function slashMenu(): Extension {
    return autocompletion({
        override: [slashSource],
        icons: false,
        activateOnTyping: true,
        closeOnBlur: true,
        tooltipClass: () => 'bb-slash-tooltip',
        optionClass: () => 'bb-slash-option',
    });
}
