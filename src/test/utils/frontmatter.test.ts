import * as assert from 'assert';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import { extractFrontmatter, frontmatterSyntax } from '../../utils/frontmatter';

suite('extractFrontmatter', () => {
    test('extracts YAML frontmatter', () => {
        const input = '---\ntitle: Hello\ndate: 2026-05-15\n---\n\n# Body';
        const { frontmatter, body } = extractFrontmatter(input);
        assert.strictEqual(frontmatter, '---\ntitle: Hello\ndate: 2026-05-15\n---\n');
        assert.strictEqual(body, '\n# Body');
    });

    test('extracts TOML frontmatter', () => {
        const input = '+++\ntitle = "Hello"\n+++\n\n# Body';
        const { frontmatter, body } = extractFrontmatter(input);
        assert.strictEqual(frontmatter, '+++\ntitle = "Hello"\n+++\n');
        assert.strictEqual(body, '\n# Body');
    });

    test('handles CRLF line endings', () => {
        const input = '---\r\ntitle: Hello\r\n---\r\n\r\n# Body';
        const { frontmatter, body } = extractFrontmatter(input);
        assert.strictEqual(frontmatter, '---\r\ntitle: Hello\r\n---\r\n');
        assert.strictEqual(body, '\r\n# Body');
    });

    test('returns empty frontmatter when none present', () => {
        const input = '# Just a heading\n\nText.';
        const { frontmatter, body } = extractFrontmatter(input);
        assert.strictEqual(frontmatter, '');
        assert.strictEqual(body, input);
    });

    test('ignores frontmatter that does not start at file beginning', () => {
        const input = 'leading text\n---\ntitle: Hello\n---\n';
        const { frontmatter, body } = extractFrontmatter(input);
        assert.strictEqual(frontmatter, '');
        assert.strictEqual(body, input);
    });

    test('two-line fence (empty body between delimiters) is not recognized as frontmatter', () => {
        const input = '---\n---\n# Body';
        const { frontmatter, body } = extractFrontmatter(input);
        assert.strictEqual(frontmatter, '');
        assert.strictEqual(body, input);
    });
});

/**
 * The editor's parser with the frontmatter config. These guard the one fragile
 * part: finding the closing fence reads the parser's input, which is not public
 * API. If a @lezer/markdown upgrade takes it away, the first test fails here
 * instead of the frontmatter quietly turning into a rule and a heading.
 */
suite('frontmatter in the Markdown parser', () => {
    const parser = markdownParser.configure([GFM, frontmatterSyntax]);
    const blocks = (doc: string): string[] => {
        const out: string[] = [];
        for (let node = parser.parse(doc).topNode.firstChild; node; node = node.nextSibling) { out.push(`${node.name} ${node.from}-${node.to}`); }
        return out;
    };

    test('frontmatter is one block, and the body parses after it', () => {
        const doc = '---\ntitle: Hi\ntags: [a, b]\n---\n\n# Body\n';
        const heading = doc.indexOf('# Body');
        assert.deepStrictEqual(blocks(doc), [`Frontmatter 0-${doc.indexOf('\n\n# Body')}`, `ATXHeading1 ${heading}-${heading + 6}`]);
    });

    test('TOML fences too', () => {
        assert.deepStrictEqual(blocks('+++\ntitle = "Hi"\n+++\nText\n').slice(0, 2), ['Frontmatter 0-20', 'Paragraph 21-25']);
    });

    test('a blank line or YAML that looks like Markdown stays inside', () => {
        const doc = '---\ntitle: Hi\n\ndescription: |\n    indented, like code\n# not a heading: in YAML\n---\nBody\n';
        assert.deepStrictEqual(blocks(doc), [`Frontmatter 0-${doc.indexOf('\nBody')}`, `Paragraph ${doc.indexOf('Body')}-${doc.length - 1}`]);
    });

    test('without a closing fence it is plain Markdown', () => {
        assert.strictEqual(blocks('---\ntitle: Hi\n\n# Body\n')[0], 'HorizontalRule 0-3');
    });

    test('only at the very start of the document', () => {
        assert.ok(!blocks('Intro\n\n---\ntitle: Hi\n---\n').some(block => block.startsWith('Frontmatter')));
    });
});
