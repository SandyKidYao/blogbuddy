import type { SyntaxNode, Tree } from '@lezer/common';
import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';
import { frontmatterSyntax } from './frontmatter';

/**
 * What BB's Markdown parser adds to CommonMark + GFM: frontmatter, footnotes
 * and TeX math. The editor, the block splitter and the renderer all parse with
 * these, so a document splits into the same blocks everywhere.
 *
 * Multi-line blocks (`$$` … `$$`, a footnote with continuation lines) are only
 * recognized at the top level: inside a list or quote, telling where the
 * container ends needs parser internals. A footnote is one paragraph: GFM's
 * further paragraphs (a blank line, then 4-space indent) read as a code block.
 */

const DOLLAR = 36, BACKSLASH = 92, OPEN_BRACKET = 91, CLOSE_BRACKET = 93, CARET = 94;
const isSpace = (ch: number): boolean => ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch < 0;
const isDigit = (ch: number): boolean => ch >= 48 && ch <= 57;
const indented = (line: Line): boolean => line.indent - line.baseIndent >= 4;
const atTop = (cx: BlockContext): boolean => cx.depth === 1;

/**
 * A line that opens display math: `$$` at its start, and no other `$$` on it
 * unless at its very end (`$$x$$ is the formula` is a paragraph with inline math).
 */
function opensMath(line: Line): boolean {
    if (indented(line) || !line.text.startsWith('$$', line.pos)) { return false; }
    const rest = line.text.slice(line.pos + 2).trimEnd();
    const close = rest.indexOf('$$');
    return close < 0 || close === rest.length - 2;
}

/**
 * Per paragraph, where a single `$` is known to have no closing one from there
 * on, so a paragraph full of prices is read once rather than once per `$`.
 * (A later `$` can only find a subset of the closings an earlier one could.)
 */
const unclosed = new WeakMap<InlineContext, number>();

/**
 * `$…$` inline math and `$$…$$` display math inside a paragraph, and a `$$`
 * line opening a display block that ends at a line ending in `$$` (or at a
 * blank line, which TeX does not allow inside math). Like Pandoc, `$` followed
 * by a space, or a closing `$` after a space or before a digit, is not math,
 * so "$5 and $10" stays money.
 */
export const mathSyntax: MarkdownConfig = {
    defineNodes: ['InlineMath', 'InlineMathMark', { name: 'BlockMath', block: true }, 'BlockMathMark'],
    parseInline: [{
        name: 'InlineMath',
        parse(cx: InlineContext, next: number, pos: number): number {
            if (next !== DOLLAR) { return -1; }
            const display = cx.char(pos + 1) === DOLLAR;
            const start = pos + (display ? 2 : 1);
            if (!display && (isSpace(cx.char(start)) || pos >= (unclosed.get(cx) ?? Infinity))) { return -1; }
            for (let i = start; i < cx.end; i++) {
                const ch = cx.char(i);
                if (ch === BACKSLASH) { i++; continue; }
                if (ch !== DOLLAR || i === start) { continue; }
                if (display) {
                    if (cx.char(i + 1) !== DOLLAR) { continue; }
                    return cx.addElement(cx.elt('InlineMath', pos, i + 2, [
                        cx.elt('InlineMathMark', pos, start), cx.elt('InlineMathMark', i, i + 2),
                    ]));
                }
                if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) { continue; }
                return cx.addElement(cx.elt('InlineMath', pos, i + 1, [
                    cx.elt('InlineMathMark', pos, start), cx.elt('InlineMathMark', i, i + 1),
                ]));
            }
            if (!display) { unclosed.set(cx, pos); }
            return -1;
        },
    }],
    parseBlock: [{
        name: 'BlockMath',
        before: 'FencedCode',
        parse(cx: BlockContext, line: Line): boolean {
            if (!opensMath(line)) { return false; }
            const from = cx.lineStart + line.pos;
            const marks: Element[] = [cx.elt('BlockMathMark', from, from + 2)];
            const rest = line.text.slice(line.pos + 2).trimEnd();
            if (rest.length >= 2 && rest.endsWith('$$')) {   // $$ … $$ on one line
                const close = from + rest.length;
                marks.push(cx.elt('BlockMathMark', close, close + 2));
                cx.nextLine();
                cx.addElement(cx.elt('BlockMath', from, close + 2, marks));
                return true;
            }
            if (!atTop(cx)) { return false; }
            let end = cx.lineStart + line.text.length;
            while (cx.nextLine() && line.next !== -1) {
                const text = line.text.trimEnd();
                if (text.endsWith('$$')) {
                    const close = cx.lineStart + text.length - 2;
                    marks.push(cx.elt('BlockMathMark', close, close + 2));
                    end = close + 2;
                    cx.nextLine();
                    break;
                }
                end = cx.lineStart + line.text.length;
            }
            cx.addElement(cx.elt('BlockMath', from, end, marks));
            return true;
        },
        endLeaf: (_cx: BlockContext, line: Line): boolean => opensMath(line),
    }],
};

const DEFINITION = /^\[\^([^\]\s]+)\]:/;
/** A line that starts some other block, which ends a footnote's unindented continuation. */
const BLOCK_START = /^(?:#{1,6}(?:\s|$)|>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|```|~~~|\$\$|<|\||\[[^\]]+\]:|(?:[-*_][ \t]*){3,}$)/;

/**
 * GitHub-style footnotes: `[^label]` in text, and a `[^label]: …` definition,
 * which runs on over the following lines until a blank line, another
 * definition, or (unless indented) the start of another block.
 */
export const footnoteSyntax: MarkdownConfig = {
    defineNodes: ['FootnoteReference', { name: 'FootnoteDefinition', block: true }, 'FootnoteLabel', 'FootnoteMark'],
    parseInline: [{
        name: 'FootnoteReference',
        before: 'Link',
        parse(cx: InlineContext, next: number, pos: number): number {
            if (next !== OPEN_BRACKET || cx.char(pos + 1) !== CARET) { return -1; }
            let i = pos + 2;
            while (i < cx.end && cx.char(i) !== CLOSE_BRACKET && cx.char(i) !== OPEN_BRACKET && !isSpace(cx.char(i))) { i++; }
            if (i === pos + 2 || cx.char(i) !== CLOSE_BRACKET) { return -1; }
            return cx.addElement(cx.elt('FootnoteReference', pos, i + 1, [
                cx.elt('FootnoteMark', pos, pos + 2), cx.elt('FootnoteLabel', pos + 2, i), cx.elt('FootnoteMark', i, i + 1),
            ]));
        },
    }],
    parseBlock: [{
        name: 'FootnoteDefinition',
        parse(cx: BlockContext, line: Line): boolean {
            const match = DEFINITION.exec(line.text.slice(line.pos));
            if (!match || indented(line) || !atTop(cx)) { return false; }
            const from = cx.lineStart + line.pos;
            const labelEnd = from + 2 + match[1].length;
            const contentFrom = from + match[0].length;
            let content = line.text.slice(line.pos + match[0].length);
            let end = cx.lineStart + line.text.length;
            while (cx.nextLine() && line.next !== -1) {
                const rest = line.text.slice(line.pos);
                if (DEFINITION.test(rest) || (line.indent < 2 && BLOCK_START.test(rest))) { break; }
                content += '\n' + line.text;
                end = cx.lineStart + line.text.length;
            }
            cx.addElement(cx.elt('FootnoteDefinition', from, end, [
                cx.elt('FootnoteMark', from, from + 2), cx.elt('FootnoteLabel', from + 2, labelEnd), cx.elt('FootnoteMark', labelEnd, labelEnd + 2),
                ...cx.parser.parseInline(content, contentFrom),
            ]));
            return true;
        },
    }],
};

/** Everything BB adds to the Markdown parser, in one list. */
export const bbMarkdownSyntax: MarkdownConfig[] = [frontmatterSyntax, footnoteSyntax, mathSyntax];

/** A link or footnote label as Markdown compares them: case and runs of space don't matter. */
export const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();

// ---- Reading the tree ----

type Read = (from: number, to: number) => string;

/** `<a b.png>` → `a b.png` */
export function unbracket(url: string): string {
    return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url;
}

/** Link reference definitions (`[label]: url`) at the top level of a tree: normalized label → URL; the first one wins. */
export function linkReferences(tree: Tree, read: Read): Map<string, string> {
    const refs = new Map<string, string>();
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.name !== 'LinkReference') { continue; }
        const label = node.getChild('LinkLabel'), url = node.getChild('URL');
        const key = label && normalizeLabel(read(label.from + 1, label.to - 1));
        if (key && url && !refs.has(key)) { refs.set(key, unbracket(read(url.from, url.to))); }
    }
    return refs;
}

/** The label a reference-style Link or Image looks up: `[label]`, or its own text for `[text][]` and `[text]`. */
export function referenceLabel(node: SyntaxNode, read: Read): string {
    const label = node.getChild('LinkLabel');
    if (label && label.to - label.from > 2) { return normalizeLabel(read(label.from + 1, label.to - 1)); }
    const marks = node.getChildren('LinkMark');
    return normalizeLabel(read(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to));
}

/** Footnote definitions at the top level of a tree: normalized label → the note's text, on one line. */
export function footnoteDefinitions(tree: Tree, read: Read): Map<string, string> {
    const notes = new Map<string, string>();
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        const label = node.name === 'FootnoteDefinition' ? node.getChild('FootnoteLabel') : null;
        const key = label && normalizeLabel(read(label.from, label.to));
        const marks = node.getChildren('FootnoteMark');
        if (key && !notes.has(key)) { notes.set(key, read(marks[1]?.to ?? node.from, node.to).replace(/\s+/g, ' ').trim()); }
    }
    return notes;
}

/** What a document defines for its references to find: link URLs and footnote texts, by normalized label. */
export interface Definitions {
    links: ReadonlyMap<string, string>;
    notes: ReadonlyMap<string, string>;
}

export function documentDefinitions(tree: Tree, read: Read): Definitions {
    return { links: linkReferences(tree, read), notes: footnoteDefinitions(tree, read) };
}

/** The TeX inside an InlineMath or BlockMath node, and whether it is display math. */
export function mathSource(node: SyntaxNode, read: Read): { tex: string; display: boolean } {
    const marks = node.getChildren(node.name === 'BlockMath' ? 'BlockMathMark' : 'InlineMathMark');
    const open = marks[0], close = marks.length > 1 ? marks[marks.length - 1] : null;
    return {
        tex: read(open?.to ?? node.from, close?.from ?? node.to).trim(),
        display: node.name === 'BlockMath' || (open ? open.to - open.from === 2 : false),
    };
}
