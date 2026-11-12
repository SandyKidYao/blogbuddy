import { indentLess, indentMore, isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Editing commands of BB Editor: they write Markdown, as a writer would type it. */

/** Wrap the selection in a mark (** for bold), or unwrap it when it is already wrapped. */
export function toggleWrap(mark: string) {
    return (target: EditorView): boolean => {
        const { state } = target;
        const spec = state.changeByRange(range => {
            const outside = state.sliceDoc(range.from - mark.length, range.from) === mark && state.sliceDoc(range.to, range.to + mark.length) === mark;
            // A single * next to a ** belongs to the bold, not to an italic.
            const bolder = mark === '*' && state.sliceDoc(range.from - 2, range.from) === '**' && state.sliceDoc(range.to, range.to + 2) === '**';
            if (outside && !bolder) {
                return {
                    changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
                    range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
                };
            }
            const text = state.sliceDoc(range.from, range.to);
            if (text.length >= mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) {
                return {
                    changes: [{ from: range.from, to: range.from + mark.length }, { from: range.to - mark.length, to: range.to }],
                    range: EditorSelection.range(range.from, range.to - mark.length * 2),
                };
            }
            return {
                changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
                range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
            };
        });
        target.dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input.format', annotations: isolateHistory.of('full') }));
        return true;
    };
}

export const toggleBold = toggleWrap('**');

export function inCode(state: EditorState, pos: number): boolean {
    for (let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
        if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLTag', 'HTMLBlock', 'Comment', 'CommentBlock'].includes(node.name)) { return true; }
    }
    return false;
}

/** Tab indents list items and code; elsewhere it leaves the editor as usual. */
export function tab(target: EditorView, outdent: boolean): boolean {
    const { state } = target;
    const line = state.doc.lineAt(state.selection.main.head);
    const list = /^\s*([-*+]|\d+[.)])\s/.test(line.text);
    if (!list && !inCode(state, line.from + Math.min(1, line.length))) { return false; }
    if (outdent) { return indentLess(target); }
    if (!list && state.selection.main.empty) {
        target.dispatch(state.replaceSelection('  '), { scrollIntoView: true, userEvent: 'input.indent' });
        return true;
    }
    return indentMore(target);
}

/** "->" becomes "→", "=>" becomes "⇒" — outside code, and not when closing an HTML comment. */
export const arrowLigatures = EditorView.inputHandler.of((target, from, to, text) => {
    if (text !== '>' || from !== to || target.composing) { return false; }
    const { state } = target;
    const prev = state.sliceDoc(from - 1, from);
    const replacement = prev === '-' ? '→' : prev === '=' ? '⇒' : '';
    if (!replacement || /^[-=<]$/.test(state.sliceDoc(from - 2, from - 1)) || inCode(state, from)) { return false; }
    target.dispatch({ changes: { from: from - 1, to, insert: replacement }, selection: { anchor: from }, userEvent: 'input.type' });
    return true;
});
