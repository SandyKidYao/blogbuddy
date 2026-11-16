import * as assert from 'assert';
import type { SyntaxNode } from '@lezer/common';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import {
    centers, colorSource, htmlTags, imgAttrs, INLINE_TAGS, pairedTag, parseTag, readHtmlBlock,
} from '../../utils/markdownHtml';

suite('raw HTML in Markdown', () => {
    test('tags in a text, and a text that is one tag', () => {
        assert.deepStrictEqual(htmlTags('a <B class="x">b</b>').map(t => [t.from, t.to, t.name, t.close]),
            [[2, 15, 'b', false], [16, 20, 'b', true]]);
        assert.strictEqual(parseTag('<kbd>')?.name, 'kbd');
        assert.strictEqual(parseTag('</KBD>')?.close, true);
        assert.strictEqual(parseTag('<kbd> x'), null);
        assert.strictEqual(parseTag('a < b'), null);
        // Every call starts afresh: a shared /g regex would remember where the last one stopped.
        assert.strictEqual(htmlTags('<p>').length, 1);
        assert.strictEqual(htmlTags('<p>').length, 1);
    });

    test('img attributes', () => {
        assert.deepStrictEqual(imgAttrs('<img width="2" alt=\'A "b"\' src="x.png">'), { src: 'x.png', alt: 'A "b"' });
        assert.deepStrictEqual(imgAttrs('<img>'), { src: '', alt: '' });
    });

    test('what centers', () => {
        const tag = (source: string) => parseTag(source)!;
        assert.ok(centers(tag('<p align="center">')));
        assert.ok(centers(tag('<p align=center>')));
        assert.ok(centers(tag('<div style="margin: 0; text-align: center">')));
        assert.ok(centers(tag('<CENTER>')));
        assert.ok(!centers(tag('</center>')));
        assert.ok(!centers(tag('<p align="right">')));
    });

    test('<source> for a color scheme', () => {
        const tag = (source: string) => parseTag(source)!;
        assert.deepStrictEqual(colorSource(tag('<source media="(prefers-color-scheme: dark)" srcset="d.png 2x, d1.png 1x">')),
            { scheme: 'dark', src: 'd.png' });
        assert.deepStrictEqual(colorSource(tag('<source srcset=\'l.png\' media=\'(prefers-color-scheme:light)\'>')),
            { scheme: 'light', src: 'l.png' });
        assert.strictEqual(colorSource(tag('<source media="(min-width: 600px)" srcset="w.png">')), null);
        assert.strictEqual(colorSource(tag('<img media="(prefers-color-scheme: dark)" srcset="x.png">')), null);
    });

    test('inline tags look themselves up, not the prototype', () => {
        assert.deepStrictEqual(INLINE_TAGS.get('kbd'), ['kbd', 'md-kbd']);
        assert.strictEqual(INLINE_TAGS.get('constructor'), undefined);
        const doc = 'a <constructor>x</constructor> <kbd>K</kbd> <sub>1 <sub>2</sub></sub>';
        const read = (from: number, to: number) => doc.slice(from, to);
        const tags: SyntaxNode[] = [];
        markdownParser.configure(GFM).parse(doc).iterate({ enter: n => { if (n.name === 'HTMLTag') { tags.push(n.node); } } });
        const pair = (i: number) => { const p = pairedTag(tags[i], read); return p ? read(p.from, p.to) + '@' + p.from : null; };
        assert.strictEqual(pair(0), null);                                         // <constructor>
        assert.strictEqual(pair(2), `</kbd>@${doc.indexOf('</kbd>')}`);            // <kbd> → </kbd>
        assert.strictEqual(pair(3), `<kbd>@${doc.indexOf('<kbd>')}`);              // and back
        assert.strictEqual(pair(4), `</sub>@${doc.lastIndexOf('</sub>')}`);        // nested: the outer pair
        assert.strictEqual(pair(5), `</sub>@${doc.indexOf('</sub>')}`);
    });
});

suite('an HTML block, line by line', () => {
    const summary = (block: string) => readHtmlBlock(block).map(line => ({
        line: block.slice(line.from, line.to),
        shown: line.shown, centered: line.centered, content: line.content,
        parts: line.parts.map(part => part.kind === 'img'
            ? `img ${part.src}${part.dark ? ' / ' + part.dark : ''}`
            : `${part.kind} ${block.slice(part.from, part.to)}`),
    }));

    test('a centered image across three lines', () => {
        assert.deepStrictEqual(summary('<p align="center">\n  <img src="a.jpg" alt="A">\n</p>'), [
            { line: '<p align="center">', shown: true, centered: true, content: false, parts: ['tag <p align="center">'] },
            { line: '  <img src="a.jpg" alt="A">', shown: true, centered: true, content: true, parts: ['text   ', 'img a.jpg'] },
            { line: '</p>', shown: true, centered: true, content: false, parts: ['tag </p>'] },
        ]);
    });

    test('one line, linked badges, and a caption', () => {
        const [line] = summary('<p align="center"><a href="x"><img src="b1.svg"></a> <img src="b2.svg"><br>Caption</p>');
        assert.ok(line.shown && line.centered && line.content);
        assert.deepStrictEqual(line.parts.filter(p => !p.startsWith('tag')), ['img b1.svg', 'text  ', 'img b2.svg', 'text Caption']);
    });

    test('a <picture> pairs its dark source with the image; the next picture starts over', () => {
        const block = [
            '<picture>', '  <source media="(prefers-color-scheme: dark)" srcset="d.png">', '  <img src="l.png">', '</picture>',
            '<picture>', '  <img src="plain.png">', '</picture>',
        ].join('\n');
        const images = summary(block).flatMap(line => line.parts.filter(p => p.startsWith('img')));
        assert.deepStrictEqual(images, ['img l.png / d.png', 'img plain.png']);
    });

    test('an <img> after </picture> keeps its own source', () => {
        const images = (block: string) => summary(block).flatMap(line => line.parts.filter(p => p.startsWith('img')));
        const dark = '<source media="(prefers-color-scheme: dark)" srcset="d.png">';
        const light = '<source media="(prefers-color-scheme: light)" srcset="l2.png">';
        assert.deepStrictEqual(images(['<picture>', dark, '<img src="l.png">', '</picture>', '<img src="x.png">'].join('\n')),
            ['img l.png / d.png', 'img x.png']);
        assert.deepStrictEqual(images(`<p><picture>${dark}${light}<img src="l.png"></picture> <img src="x.png"></p>`),
            ['img l2.png / d.png', 'img x.png']);
    });

    test('words between tags are content; other HTML stays source', () => {
        const lines = summary('<details>\n<summary>More</summary>\n<table><tr><td>x</td></tr></table>\n<!-- note -->');
        assert.deepStrictEqual(lines.map(l => [l.shown, l.content]), [[true, false], [true, true], [false, false], [false, false]]);
        assert.deepStrictEqual(lines[2].parts, []);
    });

    test('centering ends with its element, nested or not', () => {
        const lines = summary('<div align="center">\n<div>\n<img src="a.png">\n</div>\n<img src="b.png">\n</div>\n<img src="c.png">');
        // The line that closes it still starts inside it.
        assert.deepStrictEqual(lines.map(l => l.centered), [true, true, true, true, true, true, false]);
    });
});
