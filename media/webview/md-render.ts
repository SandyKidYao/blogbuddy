import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';

/**
 * Markdown → DOM, on the same Lezer parser the editor uses. For things shown
 * beside or instead of source: tables, an agent's answer, proposed blocks.
 *
 * Built with createElement / textContent only — raw HTML in the Markdown is
 * never interpreted, except a standalone <img> tag, which becomes an image.
 */

export type UrlResolver = (url: string) => string;

const IMG_TAG = /^<img\b[^>]*>$/i;
const IMG_SRC = /\bsrc\s*=\s*(["'])(.*?)\1/i;
const IMG_ALT = /\balt\s*=\s*(["'])(.*?)\1/i;

/** Marks that carry syntax only. */
const MARKS = new Set([
    'HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'QuoteMark', 'ListMark', 'StrikethroughMark',
    'TaskMarker', 'CodeInfo', 'LinkTitle', 'LinkLabel', 'TableDelimiter', 'SubscriptMark', 'SuperscriptMark',
]);

export function renderMarkdown(markdown: string, resolve: UrlResolver = url => url): DocumentFragment {
    const tree = markdownLanguage.parser.parse(markdown);
    const slice = (from: number, to: number): string => markdown.slice(from, to);
    const out = document.createDocumentFragment();

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: Node): HTMLElementTagNameMap[K] => {
        const element = document.createElement(tag);
        parent.appendChild(element);
        return element;
    };
    const text = (parent: Node, value: string): void => { if (value) { parent.appendChild(document.createTextNode(value)); } };

    const image = (parent: Node, src: string, alt: string): void => {
        const img = el('img', parent);
        img.src = resolve(src);
        img.alt = alt;
    };

    /** Inline content of a node, from `from` to `to`, skipping syntax marks. */
    const inline = (node: SyntaxNode, parent: Node, from = node.from, to = node.to): void => {
        let pos = from;
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.to <= from || child.from >= to) { continue; }
            if (child.from > pos) { text(parent, slice(pos, child.from)); }
            inlineNode(child, parent);
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
                const link = el('a', parent);
                if (url) { link.href = resolve(unbracket(slice(url.from, url.to))); }
                inline(node, link, marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
                return;
            }
            case 'Image': {
                const marks = node.getChildren('LinkMark');
                const url = node.getChild('URL');
                image(parent, url ? unbracket(slice(url.from, url.to)) : '', slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to));
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
                const tag = slice(node.from, node.to);
                if (IMG_TAG.test(tag)) { image(parent, IMG_SRC.exec(tag)?.[2] ?? '', IMG_ALT.exec(tag)?.[2] ?? ''); }
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
            case 'HTMLBlock': {
                const source = slice(node.from, node.to).trim();
                if (IMG_TAG.test(source)) { image(el('p', parent), IMG_SRC.exec(source)?.[2] ?? '', IMG_ALT.exec(source)?.[2] ?? ''); }
                return;
            }
            case 'LinkReference': case 'CommentBlock': case 'ProcessingInstructionBlock': case 'Frontmatter': return;
            default:
                if (MARKS.has(node.name)) { return; }
                // Anything unexpected: keep its words.
                text(el('p', parent), slice(node.from, node.to));
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

/** `<a b.png>` → `a b.png` */
export function unbracket(url: string): string {
    return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url;
}

/** Drop leading / trailing whitespace text, left over from source indentation and line ends. */
function trimText(element: HTMLElement): void {
    const first = element.firstChild, last = element.lastChild;
    if (first instanceof Text) { first.data = first.data.replace(/^\s+/, ''); }
    if (last instanceof Text) { last.data = last.data.replace(/\s+$/, ''); }
}
