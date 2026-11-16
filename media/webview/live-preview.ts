import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import * as l10n from '@vscode/l10n';
import { imgAttrs, INLINE_TAGS, pairedTag, parseTag, readHtmlBlock } from '../../src/utils/markdownHtml';
import {
    type Definitions, documentDefinitions, mathSource, normalizeLabel, referenceLabel, unbracket,
} from '../../src/utils/markdownSyntax';
import { renderMarkdown, renderTeX, themedImage } from './md-render';

/**
 * Live preview: the document is the Markdown source; this decides how it looks.
 * On lines the selection does not touch, syntax marks are hidden and the text
 * is styled (headings, emphasis, code, links, lists, tasks, quotes, rules,
 * images, footnotes, inline HTML such as <kbd>, TeX math). On the caret's
 * lines the marks come back, faint, so they can be edited directly. Tables
 * and display math render as blocks until the caret enters them.
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

// ---- What the document defines (link URLs, footnotes), for references anywhere in it ----

type DocDefinitions = Definitions & { key: string };
const definitionsCache = new WeakMap<Tree, DocDefinitions>();

/**
 * The document's link and footnote definitions, read once per syntax tree. `key`
 * changes only when they do, so a rendered table redraws when a definition it
 * may use changes, not on every keystroke.
 */
export function definitionsOf(state: EditorState): DocDefinitions {
    const tree = syntaxTree(state);
    let defs = definitionsCache.get(tree);
    if (!defs) {
        const read = documentDefinitions(tree, (from, to) => state.sliceDoc(from, to));
        defs = { ...read, key: JSON.stringify([[...read.links], [...read.notes]]) };
        definitionsCache.set(tree, defs);
    }
    return defs;
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
        box.setAttribute('aria-label', this.checked ? l10n.t('Done') : l10n.t('Not done'));
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
    /** `dark`: the version a <picture> shows in a dark theme, when it differs. */
    constructor(readonly src: string, readonly alt: string, readonly dark = '') { super(); }
    eq(other: Image): boolean { return other.src === this.src && other.alt === this.alt && other.dark === this.dark; }
    toDOM(): HTMLElement {
        const { node, images } = themedImage(this.src, this.alt, this.dark || undefined);
        for (const img of images) {
            img.classList.add('md-img');
            img.title = this.alt;
            img.addEventListener('error', () => img.classList.add('is-broken'));
        }
        return node;
    }
    get estimatedHeight(): number { return 200; }
}

/** <br> in a paragraph: the line goes on below. */
class Break extends WidgetType {
    eq(): boolean { return true; }
    toDOM(): HTMLElement {
        const el = document.createElement('span');
        el.className = 'md-br';
        return el;
    }
}

/** TeX, drawn; clicking it puts the caret in its source. */
class TeX extends WidgetType {
    constructor(readonly tex: string, readonly display: boolean) { super(); }
    eq(other: TeX): boolean { return other.tex === this.tex && other.display === this.display; }
    toDOM(view: EditorView): HTMLElement {
        const el = renderTeX(this.tex, this.display);
        el.classList.add(this.display ? 'md-math-block' : 'md-math');
        el.addEventListener('mousedown', event => {
            event.preventDefault();
            view.dispatch({ selection: { anchor: view.posAtDOM(el) + (this.display ? 2 : 1) } });
            view.focus();
        });
        return el;
    }
    ignoreEvent(): boolean { return true; }
}

/** A rendered table standing in for its source; clicking it puts the caret inside. */
class Table extends WidgetType {
    constructor(readonly source: string, readonly base: string, readonly defs: DocDefinitions) { super(); }
    eq(other: Table): boolean { return other.source === this.source && other.base === this.base && other.defs.key === this.defs.key; }
    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'md-table';
        wrap.append(renderMarkdown(this.source, url => resolveUrl(view.state, url), this.defs));
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
    const image = (from: number, to: number, src: string, alt: string, dark?: string): void => {
        const widget = new Image(resolveUrl(state, src), alt, dark && dark !== src ? resolveUrl(state, dark) : '');
        if (live(from) && oneLine(from, to)) { items.push(Decoration.replace({ widget }).range(from, to)); }
        else {
            add(from, to, markCls('md-mk'));
            items.push(Decoration.widget({ widget, side: 1 }).range(to));
        }
    };
    const read = (from: number, to: number): string => doc.sliceString(from, to);
    // Read from the whole tree only when something on screen refers to it.
    const linkRef = (node: SyntaxNode): string | undefined => definitionsOf(state).links.get(referenceLabel(node, read));
    const footnote = (label: string): string | undefined => definitionsOf(state).notes.get(normalizeLabel(label));

    /**
     * An HTML block, line by line (see readHtmlBlock): a line of presentational tags
     * shows its images and words with the tags hidden, centered inside align="center";
     * any other line stays faint source.
     */
    const htmlBlock = (from: number, to: number): void => {
        for (const line of readHtmlBlock(read(from, to))) {
            const start = from + line.from, end = from + line.to;
            if (!line.shown) { add(start, end, markCls('md-html')); continue; }
            for (const part of line.parts) {
                const a = from + part.from, b = from + part.to;
                if (part.kind === 'img') { image(a, b, part.src, part.alt, part.dark); }
                else if (part.kind === 'tag') { add(a, b, live(a) ? hide : markCls('md-mk')); }
            }
            if (!live(start)) { continue; }
            if (!line.content) { items.push(lineCls('md-gap').range(doc.lineAt(start).from)); continue; }
            // The indent would push a centered image off center.
            const text = read(start, end);
            add(start, start + text.length - text.trimStart().length, hide);
            const cls = [line.images ? 'md-html-img' : '', line.centered ? 'md-center' : ''].filter(Boolean).join(' ');
            if (cls) { items.push(lineCls(cls).range(doc.lineAt(start).from)); }
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
                        // ![alt][label] looks its URL up; with no definition it is just text.
                        const src = url ? unbracket(doc.sliceString(url.from, url.to)) : linkRef(n.node);
                        if (src) { image(n.from, n.to, src, alt); }
                        return false;
                    }
                    case 'InlineMath': {
                        const { tex, display } = mathSource(n.node, read);
                        if (tex && live(n.from) && oneLine(n.from, n.to)) {
                            add(n.from, n.to, Decoration.replace({ widget: new TeX(tex, display) }));
                        } else {
                            add(n.from, n.to, markCls('md-math-src'));
                            for (const mark of n.node.getChildren('InlineMathMark')) { add(mark.from, mark.to, markCls('md-mk')); }
                        }
                        return false;
                    }
                    case 'BlockMath': {
                        // Drawn by the block field while the caret is elsewhere; here it is being edited.
                        const { tex } = mathSource(n.node, read);
                        if (n.node.parent?.name !== 'Document' && tex && live(n.from) && oneLine(n.from, n.to)) {
                            add(n.from, n.to, Decoration.replace({ widget: new TeX(tex, true) }));   // $$…$$ in a list or quote
                            return false;
                        }
                        lines(n.from, n.to, 'md-math-src');
                        for (const mark of n.node.getChildren('BlockMathMark')) { add(mark.from, mark.to, markCls('md-mk')); }
                        return false;
                    }
                    case 'FootnoteReference': case 'FootnoteDefinition': {
                        const label = n.node.getChild('FootnoteLabel');
                        const marks = n.node.getChildren('FootnoteMark');
                        const definition = name === 'FootnoteDefinition';
                        // Like GitHub: without a definition, [^x] is just text.
                        const note = !definition && label ? footnote(read(label.from, label.to)) : undefined;
                        if (!label || (!definition && note === undefined)) { return false; }
                        if (definition) { lines(n.from, n.to, 'md-fn'); }
                        add(label.from, label.to, Decoration.mark({ class: 'md-fnref', attributes: note ? { title: note } : undefined }));
                        marks.forEach((mark, i) => marker(mark.from, mark.to, definition && i === 1));
                        return definition ? undefined : false;
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
                    case 'HTMLTag': {
                        const tag = parseTag(read(n.from, n.to));
                        const pair = pairedTag(n.node, read);
                        if (tag?.name === 'img') {
                            const { src, alt } = imgAttrs(tag.source);
                            image(n.from, n.to, src, alt);
                        } else if (tag?.name === 'br') {
                            if (live(n.from)) { add(n.from, n.to, Decoration.replace({ widget: new Break() })); }
                            else { add(n.from, n.to, markCls('md-mk')); }
                        } else if (tag && pair) {
                            // <kbd>…</kbd> and the like: the tags step back like Markdown's marks.
                            const cls = INLINE_TAGS.get(tag.name)?.[1];
                            if (!tag.close && cls) { add(n.to, pair.from, markCls(cls)); }
                            marker(n.from, n.to);
                        } else {
                            add(n.from, n.to, markCls('md-html'));
                        }
                        return false;
                    }
                    case 'HTMLBlock': htmlBlock(n.from, n.to); return false;
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

// ---- Tables and display math: block widgets, so they come from a state field ----

function buildBlocks(state: EditorState): DecorationSet {
    const items: Range<Decoration>[] = [];
    const base = state.field(baseUriField, false) ?? '';
    syntaxTree(state).iterate({
        enter: (n) => {
            if (n.name !== 'Table' && n.name !== 'BlockMath') { return n.name === 'Document' ? undefined : false; }
            const from = state.doc.lineAt(n.from).from, to = state.doc.lineAt(n.to).to;
            const tex = n.name === 'BlockMath' ? mathSource(n.node, (a, b) => state.sliceDoc(a, b)).tex : '';
            // An empty $$ … $$ stays source: drawn, it would be a block of no height to click.
            if (!touches(state, from, to) && (n.name === 'Table' || tex)) {
                const widget = n.name === 'Table' ? new Table(state.sliceDoc(from, to), base, definitionsOf(state)) : new TeX(tex, true);
                items.push(Decoration.replace({ widget, block: true }).range(from, to));
            }
            return false;
        },
    });
    return Decoration.set(items, true);
}

const blockField = StateField.define<DecorationSet>({
    create: buildBlocks,
    update(value, tr) {
        if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)
            || tr.effects.some(effect => effect.is(setBaseUri))) {
            return buildBlocks(tr.state);
        }
        return value;
    },
    provide: field => EditorView.decorations.from(field),
});

export function livePreview(): Extension {
    return [baseUriField, livePlugin, blockField];
}
