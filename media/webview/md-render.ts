import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import katex from 'katex';
import { imgAttrs, INLINE_TAGS, pairedTag, parseTag, readHtmlBlock } from '../../src/utils/markdownHtml';
import {
    bbMarkdownSyntax, type Definitions, documentDefinitions, mathSource, normalizeLabel, referenceLabel, unbracket,
} from '../../src/utils/markdownSyntax';

/**
 * Markdown → DOM, on the same Lezer parser the editor uses. For things shown
 * beside or instead of source: tables, an agent's answer, proposed blocks.
 *
 * Built with createElement / textContent only — raw HTML in the Markdown is
 * never interpreted: what an HTML block shows is read by markdownHtml (images,
 * alignment, words between presentational tags), anything else stays source,
 * and a few inline tags (<kbd>, <sub>, <br>, …) become the element they name.
 */

export type UrlResolver = (url: string) => string;

/** TeX as MathML (the webview draws it natively, so no fonts or styles ship); a mistake shows in place. */
export function renderTeX(tex: string, display: boolean): HTMLElement {
    const wrap = document.createElement(display ? 'div' : 'span');
    wrap.className = display ? 'bb-math bb-math-display' : 'bb-math';
    try {
        katex.render(tex, wrap, { displayMode: display, output: 'mathml', throwOnError: false, trust: false, strict: 'ignore' });
    } catch {
        wrap.textContent = tex;
        wrap.classList.add('is-error');
    }
    return wrap;
}

/** An image, or a pair that follows the theme when a dark version differs. */
export function themedImage(src: string, alt: string, dark?: string): { node: HTMLElement; images: HTMLImageElement[] } {
    const make = (url: string, cls = ''): HTMLImageElement => {
        const img = document.createElement('img');
        img.src = url;
        img.alt = alt;
        if (cls) { img.className = cls; }
        return img;
    };
    if (!dark || dark === src) { const img = make(src); return { node: img, images: [img] }; }
    const wrap = document.createElement('span');
    wrap.className = 'bb-picture';
    const images = [make(src, 'bb-light-only'), make(dark, 'bb-dark-only')];
    wrap.append(...images);
    return { node: wrap, images };
}

/** Marks that carry syntax only. */
const MARKS = new Set([
    'HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'QuoteMark', 'ListMark', 'StrikethroughMark',
    'TaskMarker', 'CodeInfo', 'LinkTitle', 'LinkLabel', 'TableDelimiter', 'SubscriptMark', 'SuperscriptMark',
    'InlineMathMark', 'BlockMathMark', 'FootnoteMark', 'FootnoteLabel',
]);

const parser = (markdownLanguage.parser as MarkdownParser).configure(bbMarkdownSyntax);

/**
 * `context`: what the whole document defines, when the Markdown is part of it
 * (a table, a proposed block), so `![x][logo]` and `[^1]` find definitions kept
 * at its end. The Markdown's own definitions come first.
 */
export function renderMarkdown(markdown: string, resolve: UrlResolver = url => url, context?: Definitions): DocumentFragment {
    const tree = parser.parse(markdown);
    const slice = (from: number, to: number): string => markdown.slice(from, to);
    const out = document.createDocumentFragment();
    let own: Definitions | undefined;
    const defs = (): Definitions => (own ??= documentDefinitions(tree, slice));
    const lookup = (node: SyntaxNode): string | undefined => {
        const label = referenceLabel(node, slice);
        return defs().links.get(label) ?? context?.links.get(label);
    };
    const noted = (label: string): boolean => {
        const key = normalizeLabel(label);
        return defs().notes.has(key) || !!context?.notes.has(key);
    };

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: Node): HTMLElementTagNameMap[K] => {
        const element = document.createElement(tag);
        parent.appendChild(element);
        return element;
    };
    const text = (parent: Node, value: string): void => { if (value) { parent.appendChild(document.createTextNode(value)); } };

    const image = (parent: Node, src: string, alt: string, dark?: string): void => {
        parent.appendChild(themedImage(resolve(src), alt, dark ? resolve(dark) : undefined).node);
    };

    /** Inline content of a node, from `from` to `to`, skipping syntax marks. */
    const inline = (node: SyntaxNode, parent: Node, from = node.from, to = node.to): void => {
        let pos = from;
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.to <= from || child.from >= to) { continue; }
            if (child.from > pos) { text(parent, slice(pos, child.from)); }
            // <kbd>…</kbd> and the like: the element, around what lies between the two tags.
            const close = child.name === 'HTMLTag' ? pairedTag(child, slice) : null;
            const element = close && close.from > child.from && close.to <= to
                ? INLINE_TAGS.get(parseTag(slice(child.from, child.to))?.name ?? '')?.[0] : undefined;
            if (close && element) {
                inline(node, parent.appendChild(document.createElement(element)), child.to, close.from);
                child = close;
            } else {
                inlineNode(child, parent);
            }
            pos = child.to;
        }
        if (pos < to) { text(parent, slice(pos, to)); }
    };

    const inlineNode = (node: SyntaxNode, parent: Node): void => {
        switch (node.name) {
            case 'Emphasis': inline(node, el('em', parent)); return;
            case 'StrongEmphasis': inline(node, el('strong', parent)); return;
            case 'Strikethrough': inline(node, el('del', parent)); return;
            case 'Subscript': inline(node, el('sub', parent)); return;
            case 'Superscript': inline(node, el('sup', parent)); return;
            case 'InlineCode': {
                const marks = node.getChildren('CodeMark');
                const code = el('code', parent);
                text(code, slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to));
                return;
            }
            case 'Link': {
                const marks = node.getChildren('LinkMark');
                const url = node.getChild('URL');
                const href = url ? unbracket(slice(url.from, url.to)) : lookup(node);
                const link = el('a', parent);
                if (href) { link.href = resolve(href); }
                inline(node, link, marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
                return;
            }
            case 'Image': {
                const marks = node.getChildren('LinkMark');
                const url = node.getChild('URL');
                const src = url ? unbracket(slice(url.from, url.to)) : lookup(node);
                const alt = slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
                if (src) { image(parent, src, alt); } else { text(parent, slice(node.from, node.to)); }
                return;
            }
            case 'InlineMath': {
                const { tex, display } = mathSource(node, slice);
                if (tex) { parent.appendChild(renderTeX(tex, display)); } else { text(parent, slice(node.from, node.to)); }
                return;
            }
            case 'FootnoteReference': {
                // Like GitHub: without a definition, [^x] is just text.
                const label = node.getChild('FootnoteLabel');
                if (!label || !noted(slice(label.from, label.to))) { text(parent, slice(node.from, node.to)); return; }
                const sup = el('sup', parent);
                sup.className = 'bb-fnref';
                text(sup, slice(label.from, label.to));
                return;
            }
            case 'Autolink': case 'URL': {
                const value = slice(node.from, node.to).replace(/^<|>$/g, '');
                const link = el('a', parent);
                link.href = /^[\w.+-]+@[\w-]+\./.test(value) ? `mailto:${value}` : value;
                link.textContent = value;
                return;
            }
            case 'Escape': text(parent, slice(node.from + 1, node.to)); return;
            case 'HardBreak': el('br', parent); return;
            case 'HTMLTag': {
                const tag = parseTag(slice(node.from, node.to));
                if (tag?.name === 'img') { const { src, alt } = imgAttrs(tag.source); image(parent, src, alt); }
                else if (tag?.name === 'br') { el('br', parent); }
                return;
            }
            case 'Comment': return;
            default:
                if (MARKS.has(node.name)) { return; }
                inline(node, parent);
        }
    };

    const block = (node: SyntaxNode, parent: Node): void => {
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
        if (heading) {
            const h = el(`h${Math.min(6, Number(heading[1]))}` as 'h1', parent);
            inline(node, h);
            trimText(h);
            return;
        }
        switch (node.name) {
            case 'Paragraph': { const p = el('p', parent); inline(node, p); trimText(p); return; }
            case 'BulletList': children(node, el('ul', parent)); return;
            case 'OrderedList': {
                const list = el('ol', parent);
                const start = parseInt(slice(node.firstChild?.firstChild?.from ?? node.from, node.to), 10);
                if (Number.isFinite(start) && start !== 1) { list.start = start; }
                children(node, list);
                return;
            }
            case 'ListItem': children(node, el('li', parent)); return;
            case 'Task': {
                const marker = node.getChild('TaskMarker');
                const box = el('input', parent);
                box.type = 'checkbox';
                box.disabled = true;
                box.checked = !!marker && /x/i.test(slice(marker.from, marker.to));
                const span = el('span', parent);
                inline(node, span, marker?.to ?? node.from);
                trimText(span);
                return;
            }
            case 'Blockquote': children(node, el('blockquote', parent)); return;
            case 'FencedCode': case 'CodeBlock': {
                const pre = el('pre', parent);
                const code = el('code', pre);
                const info = node.getChild('CodeInfo');
                if (info) { code.dataset.lang = slice(info.from, info.to); }
                const parts = node.getChildren('CodeText');
                code.textContent = parts.map(part => slice(part.from, part.to)).join('');
                if (!parts.length && node.name === 'CodeBlock') { code.textContent = slice(node.from, node.to); }
                return;
            }
            case 'HorizontalRule': el('hr', parent); return;
            case 'Table': table(node, parent); return;
            case 'HTMLBlock': htmlBlock(node, parent); return;
            case 'BlockMath': {
                const { tex } = mathSource(node, slice);
                if (tex) { parent.appendChild(renderTeX(tex, true)); } else { text(el('p', parent), slice(node.from, node.to)); }
                return;
            }
            case 'FootnoteDefinition': {
                const label = node.getChild('FootnoteLabel');
                const marks = node.getChildren('FootnoteMark');
                const p = el('p', parent);
                p.className = 'bb-fn';
                const sup = el('sup', p);
                sup.className = 'bb-fnref';
                text(sup, label ? slice(label.from, label.to) : '');
                text(p, ' ');
                const span = el('span', p);
                inline(node, span, marks[1]?.to ?? node.from);
                trimText(span);
                return;
            }
            case 'LinkReference': case 'CommentBlock': case 'ProcessingInstructionBlock': case 'Frontmatter': return;
            default:
                if (MARKS.has(node.name)) { return; }
                // Anything unexpected: keep its words.
                text(el('p', parent), slice(node.from, node.to));
        }
    };

    /** Lines of presentational HTML show their images and words; runs of other lines stay source. */
    const htmlBlock = (node: SyntaxNode, parent: Node): void => {
        const block = slice(node.from, node.to);
        let source: HTMLElement | null = null;
        for (const line of readHtmlBlock(block)) {
            if (!line.shown) {
                source ??= Object.assign(el('div', parent), { className: 'bb-html' });
                text(source, (source.textContent ? '\n' : '') + block.slice(line.from, line.to));
                continue;
            }
            source = null;
            if (!line.content) { continue; }
            const row = el('div', parent);
            if (line.centered) { row.style.textAlign = 'center'; }
            for (const part of line.parts) {
                if (part.kind === 'img') { image(row, part.src, part.alt, part.dark); }
                else if (part.kind === 'text') { text(row, block.slice(part.from, part.to)); }
            }
            trimText(row);
        }
    };

    const children = (node: SyntaxNode, parent: Node): void => {
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (MARKS.has(child.name)) { continue; }
            block(child, parent);
        }
    };

    const table = (node: SyntaxNode, parent: Node): void => {
        const tableEl = el('table', parent);
        for (let row = node.firstChild; row; row = row.nextSibling) {
            if (row.name !== 'TableHeader' && row.name !== 'TableRow') { continue; }
            const section = row.name === 'TableHeader' ? el('thead', tableEl) : (tableEl.tBodies[0] ?? el('tbody', tableEl));
            const tr = el('tr', section);
            for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
                if (cell.name !== 'TableCell') { continue; }
                const td = el(row.name === 'TableHeader' ? 'th' : 'td', tr);
                inline(cell, td);
                trimText(td);
            }
        }
    };

    children(tree.topNode, out);
    return out;
}

/** Drop leading / trailing whitespace text, left over from source indentation and line ends. */
function trimText(element: HTMLElement): void {
    const first = element.firstChild, last = element.lastChild;
    if (first instanceof Text) { first.data = first.data.replace(/^\s+/, ''); }
    if (last instanceof Text) { last.data = last.data.replace(/\s+$/, ''); }
}
