import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import type { BlockInfo } from '../../src/core/blockDiff';
import { frontmatterSyntax } from '../../src/utils/frontmatter';

/**
 * Top-level Markdown blocks: the children of the syntax tree's Document node.
 * Margin notes cover whole blocks and proposals are compared block by block.
 * The frontmatter is not a block: it belongs to the properties panel.
 *
 * Because this editor keeps the Markdown source as its document, a block's
 * text is its source: a diff of two blocks is a diff of their Markdown, and
 * applying a proposal is replacing source text.
 */

export interface MdBlock {
    from: number;
    /** End of the block's last line (no trailing newline). */
    to: number;
    /** paragraph, heading, bullet_list, ordered_list, code_block, blockquote, table, hr, html. */
    type: string;
    /** Heading level; 0 for anything else. */
    level: number;
    info: BlockInfo;
}

const TYPES: Record<string, string> = {
    Paragraph: 'paragraph', BulletList: 'bullet_list', OrderedList: 'ordered_list', FencedCode: 'code_block',
    CodeBlock: 'code_block', Blockquote: 'blockquote', Table: 'table', HorizontalRule: 'hr', HTMLBlock: 'html',
    CommentBlock: 'html', ProcessingInstructionBlock: 'html', LinkReference: 'paragraph',
};

function kind(name: string): { type: string; level: number } {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    return heading ? { type: 'heading', level: Number(heading[1]) } : { type: TYPES[name] ?? 'paragraph', level: 0 };
}

/** Two blocks are the same block when their Markdown matches up to whitespace (re-wrapping is not a change). */
export function infoOf(type: string, level: number, source: string): BlockInfo {
    return { type, text: source, sig: `${level}|${source.replace(/\s+/g, ' ').trim()}` };
}

function blocksOfTree(tree: Tree, slice: (from: number, to: number) => string): MdBlock[] {
    const out: MdBlock[] = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.type.isError || node.name === 'Frontmatter') { continue; }
        const source = slice(node.from, node.to).replace(/\s+$/, '');
        if (!source) { continue; }
        const { type, level } = kind(node.name);
        out.push({ from: node.from, to: node.from + source.length, type, level, info: infoOf(type, level, source) });
    }
    return out;
}

const cache = new WeakMap<Tree, MdBlock[]>();

/** The blocks of a document state, from a syntax tree parsed to the end. */
export function blocksOf(state: EditorState): MdBlock[] {
    const tree = ensureSyntaxTree(state, state.doc.length, 400) ?? syntaxTree(state);
    let blocks = cache.get(tree);
    if (!blocks) {
        blocks = blocksOfTree(tree, (from, to) => state.sliceDoc(from, to));
        cache.set(tree, blocks);
    }
    return blocks;
}

/** The editor's Markdown parser, for text outside the editor. */
const parser = (markdownLanguage.parser as MarkdownParser).configure([frontmatterSyntax]);

/** The blocks of a Markdown string outside any editor (an agent's rewrite, an intermediate document). */
export function parseBlocks(markdown: string): MdBlock[] {
    return blocksOfTree(parser.parse(markdown), (from, to) => markdown.slice(from, to));
}

/** Index of the block containing pos, or -1 when pos sits between blocks. */
export function blockIndexAt(blocks: MdBlock[], pos: number): number {
    let lo = 0, hi = blocks.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pos < blocks[mid].from) { hi = mid - 1; }
        else if (pos > blocks[mid].to) { lo = mid + 1; }
        else { return mid; }
    }
    return -1;
}

/** The plain words of a heading block, without its # marks or setext underline. */
export function headingText(block: MdBlock): string {
    const first = block.info.text.split('\n')[0];
    return first.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').trim();
}
