import * as assert from 'assert';
import type { SyntaxNode } from '@lezer/common';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import {
    bbMarkdownSyntax, footnoteDefinitions, linkReferences, mathSource, referenceLabel, unbracket,
} from '../../utils/markdownSyntax';

suite('footnotes and math in the Markdown parser', () => {
    const parser = markdownParser.configure([GFM, ...bbMarkdownSyntax]);
    /** Every node below the document, as "Name text". */
    const nodes = (doc: string): string[] => {
        const out: string[] = [];
        parser.parse(doc).iterate({ enter: n => { if (n.name !== 'Document') { out.push(`${n.name} ${doc.slice(n.from, n.to)}`); } } });
        return out;
    };
    const top = (doc: string): string[] => {
        const out: string[] = [];
        for (let node = parser.parse(doc).topNode.firstChild; node; node = node.nextSibling) { out.push(`${node.name} ${doc.slice(node.from, node.to)}`); }
        return out;
    };

    test('inline math, and money that is not math', () => {
        assert.ok(nodes('area $\\pi r^2$ here').includes('InlineMath $\\pi r^2$'));
        assert.ok(nodes('show $$\\sum x$$ inline').includes('InlineMath $$\\sum x$$'));
        assert.ok(!nodes('costs $5 and $10 each').some(n => n.startsWith('InlineMath')));
        assert.ok(!nodes('a $ b$ c').some(n => n.startsWith('InlineMath')));
        assert.ok(!nodes('escaped \\$x$ here').some(n => n.startsWith('InlineMath')));
    });

    test('math keeps emphasis marks inside it', () => {
        const out = nodes('$a*b*c$ and *em*');
        assert.ok(out.includes('InlineMath $a*b*c$'));
        assert.ok(out.includes('Emphasis *em*'));
        assert.strictEqual(out.filter(n => n.startsWith('Emphasis ')).length, 1);
    });

    test('display math blocks', () => {
        assert.deepStrictEqual(top('text\n\n$$\na = b\n\\\\ c\n$$\n\nafter'),
            ['Paragraph text', 'BlockMath $$\na = b\n\\\\ c\n$$', 'Paragraph after']);
        assert.deepStrictEqual(top('$$ x^2 $$\nnext'), ['BlockMath $$ x^2 $$', 'Paragraph next']);
        // A $$ line ends a paragraph, like a fence.
        assert.deepStrictEqual(top('text\n$$\nx\n$$'), ['Paragraph text', 'BlockMath $$\nx\n$$']);
        // Unclosed: it stops at the blank line instead of taking the rest of the document.
        assert.deepStrictEqual(top('$$\nx\n\nmore'), ['BlockMath $$\nx', 'Paragraph more']);
    });

    test('footnote references and definitions', () => {
        const doc = 'Text[^1] and [^note].\n\n[^1]: First *one*.\n[^note]: Second,\n  continued.\n\n# After';
        assert.deepStrictEqual(top(doc), [
            'Paragraph Text[^1] and [^note].',
            'FootnoteDefinition [^1]: First *one*.',
            'FootnoteDefinition [^note]: Second,\n  continued.',
            'ATXHeading1 # After',
        ]);
        const out = nodes(doc);
        assert.ok(out.includes('FootnoteReference [^1]'));
        assert.ok(out.includes('FootnoteLabel note'));
        assert.ok(out.includes('Emphasis *one*'));
        assert.ok(!out.some(n => n.startsWith('Link ')));
    });

    test('a footnote ends at the start of another block', () => {
        assert.deepStrictEqual(top('[^1]: note\n# Heading'), ['FootnoteDefinition [^1]: note', 'ATXHeading1 # Heading']);
    });

    test('$$…$$ followed by words is inline math in a paragraph, not a block', () => {
        assert.deepStrictEqual(top('intro\n$$x$$ is inline here\nmore\n\nafter'),
            ['Paragraph intro\n$$x$$ is inline here\nmore', 'Paragraph after']);
        assert.ok(nodes('intro\n$$x$$ is inline here').includes('InlineMath $$x$$'));
        const two = nodes('$$ a $$ and $$ b $$');
        assert.deepStrictEqual(top('$$ a $$ and $$ b $$'), ['Paragraph $$ a $$ and $$ b $$']);
        assert.ok(two.includes('InlineMath $$ a $$') && two.includes('InlineMath $$ b $$'));
        // Still a block: content after the opening $$, closed on a later line.
        assert.deepStrictEqual(top('$$ a =\nb $$'), ['BlockMath $$ a =\nb $$']);
    });

    test('a footnote stops at a link reference or a thematic break', () => {
        assert.deepStrictEqual(top('[^1]: note\n[a]: http://x'), ['FootnoteDefinition [^1]: note', 'LinkReference [a]: http://x']);
        assert.deepStrictEqual(top('[^1]: note\n***'), ['FootnoteDefinition [^1]: note', 'HorizontalRule ***']);
        assert.deepStrictEqual(top('[^1]: note\n---'), ['FootnoteDefinition [^1]: note', 'HorizontalRule ---']);
        assert.deepStrictEqual(top('[^1]: note\n_ _ _'), ['FootnoteDefinition [^1]: note', 'HorizontalRule _ _ _']);
    });

    // ~20ms locally; the 1s bound only catches a return to quadratic time. Loosen it if a slow CI ever trips it.
    test('a paragraph full of unmatched $ is read in linear time', () => {
        const doc = 'costs $5 '.repeat(20000);
        const start = Date.now();
        assert.ok(!nodes(doc).some(n => n.startsWith('InlineMath')));
        assert.ok(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
    });

    test('links and link references are untouched', () => {
        const out = nodes('[a](b) [c][d]\n\n[d]: ./e.png');
        assert.ok(out.includes('Link [a](b)'));
        assert.ok(out.includes('Link [c][d]'));
        assert.ok(out.includes('LinkReference [d]: ./e.png'));
    });
});

suite('reading the Markdown tree', () => {
    const parser = markdownParser.configure([GFM, ...bbMarkdownSyntax]);
    const parse = (doc: string) => ({ tree: parser.parse(doc), read: (from: number, to: number) => doc.slice(from, to) });
    const find = (doc: string, name: string): SyntaxNode[] => {
        const out: SyntaxNode[] = [];
        parser.parse(doc).iterate({ enter: n => { if (n.name === name) { out.push(n.node); } } });
        return out;
    };

    test('link references: labels compare loosely, the first wins, brackets come off', () => {
        const { tree, read } = parse('x\n\n[Logo  Ref]: <./a b.png>\n[logo ref]: ./other.png\n[c]: ./c.png "title"');
        const refs = linkReferences(tree, read);
        assert.strictEqual(refs.get('logo ref'), './a b.png');
        assert.strictEqual(refs.get('c'), './c.png');
        assert.strictEqual(refs.size, 2);
    });

    test('the label a reference-style image looks up', () => {
        const doc = '![alt][Lab El] ![Alt Two][] ![three]';
        const read = (from: number, to: number) => doc.slice(from, to);
        assert.deepStrictEqual(find(doc, 'Image').map(node => referenceLabel(node, read)), ['lab el', 'alt two', 'three']);
    });

    test('footnote definitions, as one line of text', () => {
        const { tree, read } = parse('a[^x]\n\n[^X]: one *two*\n  three');
        assert.deepStrictEqual([...footnoteDefinitions(tree, read)], [['x', 'one *two* three']]);
    });

    test('the TeX inside math nodes', () => {
        const doc = '$a+b$ and $$ c $$\n\n$$\n\\frac{1}{2}\n$$\n\n$$\n$$';
        const read = (from: number, to: number) => doc.slice(from, to);
        assert.deepStrictEqual(find(doc, 'InlineMath').map(node => mathSource(node, read)),
            [{ tex: 'a+b', display: false }, { tex: 'c', display: true }]);
        assert.deepStrictEqual(find(doc, 'BlockMath').map(node => mathSource(node, read)),
            [{ tex: '\\frac{1}{2}', display: true }, { tex: '', display: true }]);
    });

    test('unbracket', () => {
        assert.strictEqual(unbracket('<a b.png>'), 'a b.png');
        assert.strictEqual(unbracket('a.png'), 'a.png');
    });
});
