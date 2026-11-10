import * as assert from 'assert';
import { buildNotePrompt, parseNoteReply } from '../../core/notes';

suite('notes', () => {
    const request = { question: '收紧一点', scopeKind: 'block' as const, scopeMarkdown: '其实这一段很啰嗦。', history: [], cwd: '/blog' };

    test('the prompt carries the scope, the question and the reply contract', () => {
        const prompt = buildNotePrompt({ ...request, filePath: '/blog/post.md', quote: '很啰嗦' });
        assert.ok(prompt.includes('<bb-scope>\n其实这一段很啰嗦。\n</bb-scope>'));
        assert.ok(prompt.includes('写作者现在说：收紧一点'));
        assert.ok(prompt.includes('/blog/post.md'));
        assert.ok(prompt.includes('「很啰嗦」'));
        assert.ok(prompt.includes('<bb-replace>'));
        assert.ok(prompt.includes('不要修改磁盘上的任何文件'));
    });
    test('an unsaved document is described as such instead of pointing at a file', () => {
        assert.ok(buildNotePrompt(request).includes('还没有保存到磁盘'));
    });
    test('earlier turns of the note are replayed in order', () => {
        const prompt = buildNotePrompt({ ...request, history: [{ role: 'me', text: '这段怎么样' }, { role: 'ai', text: '有点长' }] });
        assert.ok(prompt.indexOf('写作者：这段怎么样') < prompt.indexOf('你：有点长'));
        assert.ok(prompt.indexOf('你：有点长') < prompt.indexOf('写作者现在说'));
    });
    test('a plain answer has no replacement', () => {
        assert.deepStrictEqual(parseNoteReply('大致三种看法。', request.scopeMarkdown), { reply: '大致三种看法。' });
    });
    test('the rewrite is split from the answer', () => {
        const parsed = parseNoteReply('删掉了铺垫。\n\n<bb-replace>\n这一段很啰嗦。\n</bb-replace>\n', request.scopeMarkdown);
        assert.deepStrictEqual(parsed, { reply: '删掉了铺垫。', replacement: '这一段很啰嗦。' });
    });
    test('a rewrite identical to the scope is not a proposal', () => {
        const parsed = parseNoteReply('没有可改的。\n<bb-replace>\n其实这一段很啰嗦。\n</bb-replace>', request.scopeMarkdown);
        assert.deepStrictEqual(parsed, { reply: '没有可改的。' });
    });
    test('a multi-block rewrite keeps its blank lines; the last one wins', () => {
        const parsed = parseNoteReply('<bb-replace>\n旧稿\n</bb-replace>\n改好了。\n<bb-replace>\n第一段。\n\n- 一\n- 二\n</bb-replace>', request.scopeMarkdown);
        assert.strictEqual(parsed.replacement, '第一段。\n\n- 一\n- 二');
        assert.strictEqual(parsed.reply, '改好了。');
    });
    test('a rewrite with no explanation still gets a line of answer', () => {
        assert.ok(parseNoteReply('<bb-replace>\n短。\n</bb-replace>', request.scopeMarkdown).reply.length > 0);
    });
});
