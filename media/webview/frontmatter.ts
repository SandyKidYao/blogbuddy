import { Annotation, EditorSelection, EditorState, type Extension, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { FRONTMATTER_SCAN, frontmatterEnd } from '../../src/utils/frontmatter';
import { frontmatterPanel } from './frontmatter-panel';

/**
 * Frontmatter is part of the document — the editor's text is the file's text —
 * but it is not written as Markdown: the head of the document shows the
 * properties panel (frontmatter-panel.ts) in its place, and ordinary editing
 * cannot reach into it. The panel edits it; undo, redo and changes from
 * outside (all unfiltered transactions) pass through. What counts as
 * frontmatter, and its parser config, live in src/utils/frontmatter.ts.
 */

export interface FrontmatterRange {
    /** End of the closing fence line; -1 when there is no frontmatter. */
    end: number;
    /** Where the body starts: after the newline that follows the frontmatter. */
    body: number;
}

function rangeOf(state: EditorState): FrontmatterRange {
    const end = frontmatterEnd(state.sliceDoc(0, Math.min(state.doc.length, FRONTMATTER_SCAN)));
    if (end < 0) { return { end: -1, body: 0 }; }
    return { end, body: Math.min(end + 1, state.doc.length) };
}

/** The frontmatter's text, fences and following newline included (what the panel edits). */
export function frontmatterText(state: EditorState): string {
    const range = state.field(frontmatterField);
    return range.end < 0 ? '' : state.sliceDoc(0, range.body);
}

export const frontmatterField = StateField.define<FrontmatterRange>({
    create: rangeOf,
    update: (value, tr) => (tr.docChanged ? rangeOf(tr.state) : value),
});

/** Marks the panel's own edits, so the panel is not refreshed with what it just wrote. */
export const fromPanel = Annotation.define<boolean>();

/** Replace the frontmatter (fences and following newline included) with the panel's text. */
export function writeFrontmatter(view: EditorView, raw: string): void {
    const range = view.state.field(frontmatterField);
    const to = range.end < 0 ? 0 : range.body;
    if (view.state.sliceDoc(0, to) === raw) { return; }
    view.dispatch({ changes: { from: 0, to, insert: raw }, annotations: fromPanel.of(true), filter: false, userEvent: 'input.frontmatter' });
}

class PanelWidget extends WidgetType {
    eq(): boolean { return true; }
    toDOM(): HTMLElement { return frontmatterPanel(); }
    ignoreEvent(): boolean { return true; }
    get estimatedHeight(): number { return 40; }
}

const panelDecoration = EditorView.decorations.compute([frontmatterField], (state): DecorationSet => {
    const range = state.field(frontmatterField);
    return range.end < 0 ? Decoration.none
        : Decoration.set(Decoration.replace({ widget: new PanelWidget(), block: true }).range(0, range.end));
});

/** Ordinary edits and the caret stay out of the frontmatter. */
const keepOut = EditorState.transactionFilter.of(tr => {
    const before = tr.startState.field(frontmatterField);
    // Typing, deleting or pasting into the frontmatter (e.g. Backspace at the start of the body) is refused.
    if (tr.docChanged && before.end >= 0) {
        let reaches = false;
        tr.changes.iterChangedRanges(fromA => { if (fromA < before.body) { reaches = true; } });
        if (reaches) { return []; }
    }
    // The caret and selections start at the body at the earliest — also right after
    // the writer typed a closing fence and so made the frontmatter.
    if (!tr.selection && !tr.docChanged) { return tr; }
    const after = tr.docChanged ? tr.state.field(frontmatterField) : before;
    if (after.end < 0) { return tr; }
    const selection = tr.newSelection;
    if (!selection.ranges.some(r => r.from < after.body)) { return tr; }
    const clamp = (pos: number): number => Math.max(pos, after.body);
    return [tr, {
        selection: EditorSelection.create(selection.ranges.map(r => EditorSelection.range(clamp(r.anchor), clamp(r.head))), selection.mainIndex),
        sequential: true,
    }];
});

export function frontmatter(): Extension {
    return [frontmatterField, panelDecoration, keepOut];
}
