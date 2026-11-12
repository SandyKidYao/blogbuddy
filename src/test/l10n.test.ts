import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { getL10nJson } from '@vscode/l10n-dev';

/**
 * Interface text is written in English inside l10n.t / vscode.l10n.t and
 * translated in l10n/bundle.l10n.zh-cn.json; the manifest's text lives in
 * package.nls(.zh-cn).json. These tests keep the two languages in step and
 * catch Chinese text written straight into the code.
 */

const ROOT = path.resolve(__dirname, '../..');
const CJK = /[㐀-鿿＀-￯　-〿]/;

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) { return entry.name === 'test' ? [] : sourceFiles(rel); }
        return entry.name.endsWith('.ts') ? [rel] : [];
    });
}

const FILES = [...sourceFiles('src'), ...sourceFiles('media/webview')];
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;

/** Chinese that is meant to stay Chinese: what BlogBuddy says to the agent, keys it listens for, and an unused report. */
const ALLOWED: { file: string; within?: string; literal?: string }[] = [
    { file: 'src/core/notes.ts', within: 'buildNotePrompt' },
    { file: 'src/core/notes.ts', within: 'SCOPE_NAME' },
    { file: 'media/webview/notes.ts', literal: '\n（当时附了一份修改稿）' },
    { file: 'media/webview/frontmatter-panel.ts', literal: '，' },   // the full-width comma also ends a list item
    { file: 'src/utils/MarkdownStatsAnalyzer.ts', within: 'formatStats' },
];

function declarationNames(node: ts.Node): string[] {
    const names: string[] = [];
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
        if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isVariableDeclaration(at)) && at.name) {
            names.push(at.name.getText());
        }
    }
    return names;
}

function chineseLiterals(rel: string): string[] {
    const source = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const check = (node: ts.Node, text: string): void => {
        if (!CJK.test(text)) { return; }
        const file = rel.split(path.sep).join('/');
        const names = declarationNames(node);
        const allowed = ALLOWED.some(rule => rule.file === file
            && (rule.within ? names.includes(rule.within) : true)
            && (rule.literal !== undefined ? rule.literal === text : true));
        if (!allowed) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            found.push(`${file}:${line + 1} ${JSON.stringify(text)}`);
        }
    };
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { check(node, node.text); }
        else if (ts.isTemplateExpression(node)) {
            check(node, [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(''));
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

suite('l10n', () => {
    test('every string the code asks for has a Chinese translation, and none is left over', async () => {
        const used = Object.keys(await getL10nJson(FILES.map(rel => ({ extension: '.ts', contents: read(rel) }))));
        const zh = readJson('l10n/bundle.l10n.zh-cn.json');
        assert.ok(used.length > 50, `only ${used.length} strings found; is the scan looking in the right place?`);
        assert.deepStrictEqual(used.filter(key => !(key in zh)), [], 'missing from l10n/bundle.l10n.zh-cn.json');
        assert.deepStrictEqual(Object.keys(zh).filter(key => !used.includes(key)), [], 'no longer used, remove from l10n/bundle.l10n.zh-cn.json');
        for (const [key, value] of Object.entries(zh)) {
            const args = (text: string): string[] => (text.match(/\{\d+\}/g) ?? []).sort();
            assert.deepStrictEqual(args(String(value)), args(key), `placeholders differ for ${JSON.stringify(key)}`);
        }
    });

    test('every %key% in package.json is in both package.nls files', () => {
        const keys = [...read('package.json').matchAll(/"%([^"%]+)%"/g)].map(match => match[1]).sort();
        const en = Object.keys(readJson('package.nls.json')).sort();
        const zh = Object.keys(readJson('package.nls.zh-cn.json')).sort();
        assert.ok(keys.length > 0);
        assert.deepStrictEqual(en, keys, 'package.nls.json');
        assert.deepStrictEqual(zh, keys, 'package.nls.zh-cn.json');
    });

    test('no Chinese written straight into interface code', () => {
        assert.deepStrictEqual(FILES.flatMap(chineseLiterals), []);
    });
});
