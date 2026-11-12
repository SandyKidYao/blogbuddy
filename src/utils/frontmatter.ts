import type { MarkdownConfig } from '@lezer/markdown';

/**
 * Frontmatter: YAML (---) or TOML (+++) between two fences at the very start of
 * a Markdown file. One definition for the extension host (word counts leave it
 * out) and for the editor (which parses it as one block and shows the
 * properties panel in its place). Pure: no VS Code, no DOM.
 */

/** The fences and what lies between them. Two bare fences with nothing between are two rules, not frontmatter. */
const FRONTMATTER = /^(---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n\1[ \t]*(?=\r?\n|$)/;

/** Frontmatter is short: never scan a long document for a closing fence beyond this. */
export const FRONTMATTER_SCAN = 64 * 1024;

/** End of the closing fence line (before its line break), or -1 when the text has no frontmatter. */
export function frontmatterEnd(text: string): number {
    const match = FRONTMATTER.exec(text);
    return match ? match[0].length : -1;
}

/**
 * Parse YAML (`---`) or TOML (`+++`) frontmatter from the head of a document.
 * Returns the raw frontmatter block (including delimiters and trailing newline)
 * and the remaining body. Frontmatter is only recognized at the start of input.
 */
export function extractFrontmatter(content: string): { frontmatter: string; body: string } {
    const end = frontmatterEnd(content);
    if (end < 0) { return { frontmatter: '', body: content }; }
    const lineBreak = /^\r?\n/.exec(content.slice(end))?.[0] ?? '';
    return { frontmatter: content.slice(0, end + lineBreak.length), body: content.slice(end + lineBreak.length) };
}

/**
 * The Markdown parser's view of it: one `Frontmatter` block, so it never parses
 * as a rule followed by a setext heading.
 *
 * Finding the closing fence needs more lookahead than the parser's BlockContext
 * offers (peekLine sees one line); its input is there at runtime but is not
 * public API. Without it, the text parses as plain Markdown — and the tests
 * for this config say so, which is the point of them.
 */
export const frontmatterSyntax: MarkdownConfig = {
    defineNodes: [{ name: 'Frontmatter', block: true }],
    parseBlock: [{
        name: 'Frontmatter',
        before: 'HorizontalRule',
        parse(cx, line) {
            if (cx.lineStart !== 0 || !/^(---|\+\+\+)[ \t]*$/.test(line.text)) { return false; }
            const input = (cx as unknown as { input?: { length: number; read(from: number, to: number): string } }).input;
            if (!input || typeof input.read !== 'function') { return false; }
            const end = frontmatterEnd(input.read(0, Math.min(input.length, FRONTMATTER_SCAN)));
            if (end < 0) { return false; }
            while (cx.lineStart + line.text.length < end) { if (!cx.nextLine()) { break; } }
            cx.addElement(cx.elt('Frontmatter', 0, end));
            cx.nextLine();
            return true;
        },
    }],
};
