import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { renderMarkdown, unbracket } from './md-render';

/**
 * Live preview: the document is the Markdown source; this decides how it looks.
 * On lines the selection does not touch, syntax marks are hidden and the text
 * is styled (headings, emphasis, code, links, lists, tasks, quotes, rules,
 * images). On the caret's lines the marks come back, faint, so they can be
 * edited directly. Tables render as tables until the caret enters them.
 * Nothing here changes the document, except ticking a task box.
 */

// ---- Where relative image paths point (the document's folder, as a webview URI) ----

export const setBaseUri = StateEffect.define<string>();
const baseUriField = StateField.define<string>({
    create: () => '',
    update(value, tr) {
        for (const effect of tr.effects) { if (effect.is(setBaseUri)) { value = effect.value; } }
        return value;
    },
});

export function resolveUrl(state: EditorState, url: string): string {
    const base = state.field(baseUriField, false) ?? '';
    if (!base || !url || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(url)) { return url; }
    return `${base}/${url.replace(/^\.\//, '')}`;
}

// ---- Widgets ----

class Bullet extends WidgetType {
    eq(): boolean { return true; }
    toDOM(): HTMLElement {
        const el = document.createElement('span');
        el.className = 'md-bullet';
        el.textContent = '•';
        return el;
    }
}

class Checkbox extends WidgetType {
    constructor(readonly checked: boolean) { super(); }
    eq(other: Checkbox): boolean { return other.checked === this.checked; }
    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('span');
        wrap.className = 'md-task';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = this.checked;
        box.tabIndex = -1;
        box.setAttribute('aria-label', this.checked ? '已完成' : '未完成');
        // Ticking edits the [ ] / [x] in the source; the caret stays where it was.
        box.addEventListener('mousedown', event => {
            event.preventDefault();
            if (!view.state.facet(EditorView.editable)) { return; }
            const pos = view.posAtDOM(wrap);
            const line = view.state.doc.lineAt(pos);
            const match = /\[( |x|X)\]/.exec(line.text.slice(pos - line.from));
            if (!match) { return; }
            const at = pos + match.index + 1;
            view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.task' });
        });
        wrap.appendChild(box);
        return wrap;
    }
    ignoreEvent(): boolean { return true; }
}

class Image extends WidgetType {
    constructor(readonly src: string, readonly alt: string) { super(); }
    eq(other: Image): boolean { return other.src === this.src && other.alt === this.alt; }
    toDOM(): HTMLElement {
        const img = document.createElement('img');
        img.className = 'md-img';
        img.src = this.src;
        img.alt = this.alt;
        img.title = this.alt;
        img.addEventListener('error', () => img.classList.add('is-broken'));
        return img;
    }
    get estimatedHeight(): number { return 200; }
}

/** A rendered table standing in for its source; clicking it puts the caret inside. */
class Table extends WidgetType {
    constructor(readonly source: string, readonly base: string) { super(); }
    eq(other: Table): boolean { return other.source === this.source && other.base === this.base; }
    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'md-table';
        wrap.append(renderMarkdown(this.source, url => resolveUrl(view.state, url)));
        wrap.addEventListener('mousedown', event => {
            event.preventDefault();
            const pos = view.posAtDOM(wrap);
            view.dispatch({ selection: { anchor: pos } });
            view.focus();
        });
        return wrap;
    }
    ignoreEvent(): boolean { return true; }
}

// ---- Which lines show their marks ----

function activeLines(state: EditorState): Set<number> {
    const out = new Set<number>();
    for (const range of state.selection.ranges) {
        const a = state.doc.lineAt(range.from).number, b = state.doc.lineAt(range.to).number;
        for (let n = a; n <= b; n++) { out.add(n); }
    }
    return out;
}

const touches = (state: EditorState, from: number, to: number): boolean =>
    state.selection.ranges.some(range => range.from <= to && range.to >= from);

const IMG_TAG = /^<img\b[^>]*>$/i;
const IMG_SRC = /\bsrc\s*=\s*(["'])(.*?)\1/i;
const IMG_ALT = /\balt\s*=\s*(["'])(.*?)\1/i;
const STRUCTURAL = /^<\/?(?:div|p|span|center|section|figure|figcaption|picture|source|br|details|summary|sup|sub|kbd|a)\b[^>]*>$/i;

const hide = Decoration.replace({});
const markCls = (cls: string): Decoration => Decoration.mark({ class: cls });
const lineCls = (cls: string): Decoration => Decoration.line({ class: cls });

function inCode(node: SyntaxNode | null): boolean {
    for (let n = node; n; n = n.parent) { if (n.name === 'FencedCode' || n.name === 'CodeBlock') { return true; } }
    return false;
}

// ---- Inline and line decorations (viewport only) ----

function build(view: EditorView): DecorationSet {
    const { state } = view;
    const doc = state.doc;
    const active = activeLines(state);
    const live = (pos: number): boolean => !active.has(doc.lineAt(pos).number);
    const items: Range<Decoration>[] = [];
    const add = (from: number, to: number, deco: Decoration): void => { if (to > from) { items.push(deco.range(from, to)); } };
    const oneLine = (from: number, to: number): boolean => doc.lineAt(from).number === doc.lineAt(to).number;
    /** Hide a range; a plugin may not hide line breaks, so a range across lines only turns faint. */
    const conceal = (from: number, to: number): void => add(from, to, oneLine(from, to) ? hide : markCls('md-mk'));
    const lines = (from: number, to: number, cls: string): void => {
        for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) { items.push(lineCls(cls).range(doc.line(n).from)); }
    };
    /** A syntax mark: hidden (with the space after it) off the caret's line, faint on it. */
    const marker = (from: number, to: number, withSpace = false): void => {
        const end = withSpace && doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
        if (live(from)) { conceal(from, end); } else { add(from, to, markCls('md-mk')); }
    };
    const image = (from: number, to: number, src: string, alt: string): void => {
        const widget = new Image(resolveUrl(state, src), alt);
        if (live(from) && oneLine(from, to)) { items.push(Decoration.replace({ widget }).range(from, to)); }
        else {
            add(from, to, markCls('md-mk'));
            items.push(Decoration.widget({ widget, side: 1 }).range(to));
        }
    };

    for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
            from, to,
            enter: (n) => {
                const name = n.name;
                const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
                if (heading) {
                    lines(n.from, n.to, `md-h md-h${Math.min(4, Number(heading[2]))}`);
                    return;
                }
                switch (name) {
                    case 'Frontmatter': return false;   // shown as the properties panel
                    case 'HeaderMark':
                        if (n.node.parent?.name.startsWith('Setext')) {
                            if (live(n.from)) { add(n.from, n.to, hide); items.push(lineCls('md-setext-rule').range(doc.lineAt(n.from).from)); }
                            else { add(n.from, n.to, markCls('md-mk')); }
                        } else { marker(n.from, n.to, true); }
                        return;
                    case 'StrongEmphasis': add(n.from, n.to, markCls('md-strong')); return;
                    case 'Emphasis': add(n.from, n.to, markCls('md-em')); return;
                    case 'Strikethrough': add(n.from, n.to, markCls('md-strike')); return;
                    case 'EmphasisMark': case 'StrikethroughMark': marker(n.from, n.to); return;
                    case 'InlineCode': add(n.from, n.to, markCls('md-code')); return;
                    case 'CodeMark':
                        if (n.node.parent?.name === 'InlineCode') { marker(n.from, n.to); }
                        return;
                    case 'Escape':
                        if (live(n.from)) { add(n.from, n.from + 1, hide); }
                        return;
                    case 'FencedCode': {
                        lines(n.from, n.to, 'md-codeblock');
                        const quiet = !touches(state, n.from, n.to);
                        const open = doc.lineAt(n.from), close = doc.lineAt(n.to);
                        items.push(lineCls(`md-fence md-fence-open${quiet ? ' is-quiet' : ''}`).range(open.from));
                        if (close.number > open.number && /^\s*(`{3,}|~{3,})\s*$/.test(close.text)) {
                            items.push(lineCls(`md-fence md-fence-close${quiet ? ' is-quiet' : ''}`).range(close.from));
                        }
                        const info = n.node.getChild('CodeInfo');
                        if (info) { add(info.from, info.to, markCls('md-code-info')); }
                        return false;
                    }
                    case 'CodeBlock': lines(n.from, n.to, 'md-codeblock md-codeblock-indented'); return false;
                    case 'Link': {
                        const marks = n.node.getChildren('LinkMark');
                        if (marks.length >= 2) {
                            add(marks[0].to, marks[1].from, markCls('md-link'));
                            if (live(n.from)) { conceal(marks[0].from, marks[0].to); conceal(marks[1].from, n.to); }
                            else { add(marks[0].from, marks[0].to, markCls('md-mk')); add(marks[1].from, n.to, markCls('md-mk')); }
                        }
                        return;
                    }
                    case 'LinkMark': case 'URL': case 'LinkTitle': case 'LinkLabel':
                        if (name === 'URL' && !['Link', 'Image', 'LinkReference', 'Autolink'].includes(n.node.parent?.name ?? '')) {
                            add(n.from, n.to, markCls('md-link'));   // a bare URL (GFM autolink)
                        }
                        return;
                    case 'Autolink': {
                        add(n.from + 1, n.to - 1, markCls('md-link'));
                        if (live(n.from)) { add(n.from, n.from + 1, hide); add(n.to - 1, n.to, hide); }
                        else { add(n.from, n.from + 1, markCls('md-mk')); add(n.to - 1, n.to, markCls('md-mk')); }
                        return false;
                    }
                    case 'Image': {
                        const marks = n.node.getChildren('LinkMark');
                        const url = n.node.getChild('URL');
                        const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
                        image(n.from, n.to, url ? unbracket(doc.sliceString(url.from, url.to)) : '', alt);
                        return false;
                    }
                    case 'Blockquote': lines(n.from, n.to, 'md-quote'); return;
                    case 'QuoteMark': marker(n.from, n.to, true); return;
                    case 'ListItem': {
                        const ordered = n.node.parent?.name === 'OrderedList';
                        const task = n.node.getChild('Task');
                        const listMark = n.node.getChild('ListMark');
                        if (!listMark) { return; }
                        items.push(lineCls(task ? 'md-li md-li-task' : ordered ? 'md-li md-li-ol' : 'md-li').range(doc.lineAt(listMark.from).from));
                        const taskMarker = task?.getChild('TaskMarker');
                        if (taskMarker) {
                            const checked = /x/i.test(doc.sliceString(taskMarker.from, taskMarker.to));
                            if (checked) { add(taskMarker.to, task?.to ?? taskMarker.to, markCls('md-done')); }
                            if (live(listMark.from)) {
                                const end = doc.sliceString(taskMarker.to, taskMarker.to + 1) === ' ' ? taskMarker.to + 1 : taskMarker.to;
                                add(listMark.from, end, Decoration.replace({ widget: new Checkbox(checked) }));
                            } else {
                                add(listMark.from, listMark.to, markCls('md-mk'));
                                add(taskMarker.from, taskMarker.to, markCls('md-mk'));
                            }
                        } else if (live(listMark.from) && !ordered) {
                            add(listMark.from, listMark.to, Decoration.replace({ widget: new Bullet() }));
                        } else {
                            add(listMark.from, listMark.to, markCls(ordered ? 'md-num' : 'md-mk'));
                        }
                        return;
                    }
                    case 'HorizontalRule':
                        if (live(n.from)) { add(n.from, n.to, hide); items.push(lineCls('md-hr').range(doc.lineAt(n.from).from)); }
                        else { add(n.from, n.to, markCls('md-mk')); }
                        return;
                    case 'HTMLTag': case 'HTMLBlock': {
                        const source = doc.sliceString(n.from, n.to).trim();
                        if (IMG_TAG.test(source)) {
                            image(n.from, n.to, IMG_SRC.exec(source)?.[2] ?? '', IMG_ALT.exec(source)?.[2] ?? '');
                        } else if (STRUCTURAL.test(source) && live(n.from) && name === 'HTMLBlock' && oneLine(n.from, n.to)) {
                            add(n.from, n.to, hide);
                            items.push(lineCls('md-gap').range(doc.lineAt(n.from).from));
                        } else {
                            add(n.from, n.to, markCls('md-html'));
                        }
                        return false;
                    }
                    case 'Comment': case 'CommentBlock': add(n.from, n.to, markCls('md-html')); return false;
                    case 'Table':
                        // Rendered by the table field while the caret is elsewhere; here it is being edited.
                        lines(n.from, n.to, 'md-table-src');
                        return false;
                }
                return undefined;
            },
        });

        // Blank lines between blocks shrink to paragraph spacing, unless the caret is on them.
        for (let pos = from; pos <= to;) {
            const line = doc.lineAt(pos);
            if (!line.text.trim() && !active.has(line.number) && !inCode(syntaxTree(state).resolveInner(line.from, 1))) {
                items.push(lineCls('md-gap').range(line.from));
            }
            pos = line.to + 1;
        }
    }
    return Decoration.set(items, true);
}

const livePlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged
            || syntaxTree(update.startState) !== syntaxTree(update.state)
            || update.startState.field(baseUriField, false) !== update.state.field(baseUriField, false)) {
            this.decorations = build(update.view);
        }
    }
}, { decorations: plugin => plugin.decorations });

// ---- Tables: block widgets, so they come from a state field ----

function buildTables(state: EditorState): DecorationSet {
    const items: Range<Decoration>[] = [];
    const base = state.field(baseUriField, false) ?? '';
    syntaxTree(state).iterate({
        enter: (n) => {
            if (n.name !== 'Table') { return n.name === 'Document' ? undefined : false; }
            const from = state.doc.lineAt(n.from).from, to = state.doc.lineAt(n.to).to;
            if (!touches(state, from, to)) {
                items.push(Decoration.replace({ widget: new Table(state.sliceDoc(from, to), base), block: true }).range(from, to));
            }
            return false;
        },
    });
    return Decoration.set(items, true);
}

const tableField = StateField.define<DecorationSet>({
    create: buildTables,
    update(value, tr) {
        if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)
            || tr.effects.some(effect => effect.is(setBaseUri))) {
            return buildTables(tr.state);
        }
        return value;
    },
    provide: field => EditorView.decorations.from(field),
});

export function livePreview(): Extension {
    return [baseUriField, livePlugin, tableField];
}
