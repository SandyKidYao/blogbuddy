import type { SyntaxNode } from '@lezer/common';

/**
 * Raw HTML in Markdown, read but never interpreted. The live preview and the
 * Markdown renderer both ask this module what an HTML block or tag shows:
 * images (with <picture>'s dark / light sources), alignment, the words between
 * presentational tags, and a few inline tags that mean a style (<kbd>, <sub>…).
 * Pure: no DOM, so it is unit-tested.
 */

export type Read = (from: number, to: number) => string;

export interface HtmlTag {
    /** Offsets in the text the tag was found in. */
    from: number;
    to: number;
    /** Lower case. */
    name: string;
    close: boolean;
    source: string;
}

/** Every tag in a text, in order. A fresh regex per call, so no lastIndex is shared between callers. */
export function htmlTags(text: string): HtmlTag[] {
    return [...text.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi)].map(match => ({
        from: match.index ?? 0,
        to: (match.index ?? 0) + match[0].length,
        name: match[2].toLowerCase(),
        close: match[1] === '/',
        source: match[0],
    }));
}

/** A text that is exactly one tag; null otherwise. */
export function parseTag(source: string): HtmlTag | null {
    const [tag] = htmlTags(source);
    return tag && tag.from === 0 && tag.to === source.length ? tag : null;
}

const attr = (tag: string, name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];

/** An <img> tag's source and alt text. */
export function imgAttrs(tag: string): { src: string; alt: string } {
    return { src: attr(tag, 'src') ?? '', alt: attr(tag, 'alt') ?? '' };
}

/** An opening tag that centers its content: <center>, align="center", or text-align: center. */
export function centers(tag: HtmlTag): boolean {
    return !tag.close && (tag.name === 'center' || /\balign\s*=\s*["']?center\b|\btext-align\s*:\s*center\b/i.test(tag.source));
}

/** A <source> that picks an image by color scheme, as in GitHub's <picture> for dark and light; its first srcset URL. */
export function colorSource(tag: HtmlTag): { scheme: 'dark' | 'light'; src: string } | null {
    if (tag.name !== 'source' || tag.close) { return null; }
    const scheme = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(attr(tag.source, 'media') ?? '')?.[1];
    const srcset = attr(tag.source, 'srcset');
    if (!scheme || !srcset) { return null; }
    return { scheme: scheme.toLowerCase() as 'dark' | 'light', src: srcset.trim().split(',')[0].trim().split(/\s+/)[0] };
}

/** Inline HTML shown as what it means: tag → [element in rendered Markdown, class in the editor]. */
export const INLINE_TAGS: ReadonlyMap<string, readonly [string, string]> = new Map([
    ['b', ['strong', 'md-strong']], ['strong', ['strong', 'md-strong']], ['i', ['em', 'md-em']], ['em', ['em', 'md-em']],
    ['s', ['del', 'md-strike']], ['del', ['del', 'md-strike']], ['strike', ['del', 'md-strike']], ['code', ['code', 'md-code']],
    ['kbd', ['kbd', 'md-kbd']], ['sub', ['sub', 'md-sub']], ['sup', ['sup', 'md-sup']], ['mark', ['mark', 'md-mark']],
    ['u', ['u', 'md-u']], ['ins', ['ins', 'md-u']], ['small', ['small', 'md-small']], ['span', ['span', '']], ['a', ['span', 'md-link']],
]);

/** The tag that pairs with an inline HTMLTag node among its siblings (a closing one for an opening one, and back). */
export function pairedTag(node: SyntaxNode, read: Read): SyntaxNode | null {
    const tag = parseTag(read(node.from, node.to));
    if (!tag || !INLINE_TAGS.has(tag.name)) { return null; }
    let depth = 0;
    for (let sib = tag.close ? node.prevSibling : node.nextSibling; sib; sib = tag.close ? sib.prevSibling : sib.nextSibling) {
        if (sib.name !== 'HTMLTag') { continue; }
        const other = parseTag(read(sib.from, sib.to));
        if (other?.name !== tag.name) { continue; }
        if (other.close === tag.close) { depth++; } else if (depth-- === 0) { return sib; }
    }
    return null;
}

/** Tags that only arrange what is inside them; a line of these (and text) shows its content. */
const PRESENTATIONAL = new Set(['div', 'p', 'span', 'center', 'section', 'figure', 'figcaption', 'picture', 'source', 'br',
    'details', 'summary', 'sup', 'sub', 'kbd', 'a', 'img']);
const VOID = new Set(['img', 'br', 'source', 'hr', 'wbr']);

export type HtmlPart =
    | { kind: 'text' | 'tag'; from: number; to: number }
    /** `dark`: the version a <picture> shows in a dark theme, when it differs. */
    | { kind: 'img'; from: number; to: number; src: string; alt: string; dark?: string };

export interface HtmlLine {
    /** Offsets in the block's text, without the line break. */
    from: number;
    to: number;
    /** Presentational tags only: show the parts. Otherwise the line is shown as source. */
    shown: boolean;
    /** Inside an element that centers at the line's start, or opening one on it. */
    centered: boolean;
    /** Some image, or words that are not whitespace. */
    content: boolean;
    images: boolean;
    /** In order; empty for a line not shown. */
    parts: HtmlPart[];
}

/**
 * An HTML block, line by line (<p align="center"> / <img …> / </p> spans lines).
 * A line of presentational tags shows its images and words with the tags hidden;
 * anything else (a <table>, a <script>, a comment) stays source.
 */
export function readHtmlBlock(block: string): HtmlLine[] {
    const lines: HtmlLine[] = [];
    const open: { name: string; center: boolean }[] = [];
    let picture: { dark?: string; light?: string } = {};   // the sources of the <picture> being read
    let at = 0;
    for (const text of block.split('\n')) {
        const from = at, to = at + text.length;
        at = to + 1;
        const tags = htmlTags(text);
        let centered = open.some(element => element.center);
        for (const tag of tags) {
            if (tag.close) {
                const index = open.map(element => element.name).lastIndexOf(tag.name);
                if (index >= 0) { open.length = index; }
            } else if (!VOID.has(tag.name) && !tag.source.endsWith('/>')) {
                open.push({ name: tag.name, center: centers(tag) });
                centered ||= centers(tag);
            }
        }
        const words = tags.reduceRight((rest, tag) => rest.slice(0, tag.from) + rest.slice(tag.to), text);
        const shown = !words.includes('<') && tags.every(tag => PRESENTATIONAL.has(tag.name));
        const parts: HtmlPart[] = [];
        if (shown) {
            let pos = 0;
            for (const tag of tags) {
                if (tag.from > pos) { parts.push({ kind: 'text', from: from + pos, to: from + tag.from }); }
                pos = tag.to;
                // A <picture>'s sources are its own: they start and end with it.
                if (tag.name === 'picture') { picture = {}; }
                const source = colorSource(tag);
                if (source) { picture[source.scheme] = source.src; }
                if (tag.name === 'img') {
                    const { src, alt } = imgAttrs(tag.source);
                    const light = picture.light ?? src, dark = picture.dark ?? src;
                    parts.push({ kind: 'img', from: from + tag.from, to: from + tag.to, src: light, alt, ...(dark !== light ? { dark } : {}) });
                } else {
                    parts.push({ kind: 'tag', from: from + tag.from, to: from + tag.to });
                }
            }
            if (pos < text.length) { parts.push({ kind: 'text', from: from + pos, to }); }
        }
        const images = parts.some(part => part.kind === 'img');
        lines.push({ from, to, shown, centered, images, content: shown && (images || words.trim() !== ''), parts });
    }
    return lines;
}
