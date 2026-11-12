import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Slash menu: "/" at the start of a line offers block types. Choosing one
 * writes that block's Markdown in place of the "/…" typed so far.
 */

interface SlashItem { label: string; detail: string; insert: string; caret?: number }

const ITEMS: SlashItem[] = [
    { label: 'Heading 1', detail: '#', insert: '# ' },
    { label: 'Heading 2', detail: '##', insert: '## ' },
    { label: 'Heading 3', detail: '###', insert: '### ' },
    { label: 'Bullet List', detail: '-', insert: '- ' },
    { label: 'Ordered List', detail: '1.', insert: '1. ' },
    { label: 'Task List', detail: '- [ ]', insert: '- [ ] ' },
    { label: 'Code Block', detail: '```', insert: '```\n\n```', caret: 3 },
    { label: 'Blockquote', detail: '>', insert: '> ' },
    { label: 'Table', detail: '|', insert: '|  |  |\n| --- | --- |\n|  |  |', caret: 2 },
    { label: 'Divider', detail: '---', insert: '---\n' },
];

function apply(item: SlashItem) {
    return (view: EditorView, _completion: Completion, from: number, to: number): void => {
        const caret = from + (item.caret ?? item.insert.length);
        view.dispatch({ changes: { from, to, insert: item.insert }, selection: { anchor: caret }, userEvent: 'input.complete' });
    };
}

/** Offered only when the line so far is "/" plus letters; what follows "/" narrows the list by label. */
function slashSource(context: CompletionContext): CompletionResult | null {
    const line = context.state.doc.lineAt(context.pos);
    const match = /^(\s*)\/([A-Za-z ]*)$/.exec(line.text.slice(0, context.pos - line.from));
    if (!match) { return null; }
    const typed = match[2].trim().toLowerCase();
    const options = ITEMS.filter(item => item.label.toLowerCase().includes(typed))
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
