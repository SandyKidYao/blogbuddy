import * as assert from 'assert';
import { agentArgs, parseAgentLine } from '../../services/agentProtocol';

suite('agentProtocol', () => {
    test('both agents run headless with read-only access', () => {
        const claude = agentArgs('claude', '/blog');
        assert.ok(claude.includes('-p') && claude.includes('stream-json'));
        assert.ok(!claude.join(' ').match(/Edit|Write|Bash/));
        const codex = agentArgs('codex', '/blog');
        assert.deepStrictEqual(codex.slice(codex.indexOf('--sandbox'), codex.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
        assert.ok(codex.includes('--search') && codex.includes('/blog'));
    });
    test('Claude Code tool calls become short symbolic progress notes', () => {
        const line = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
        assert.strictEqual(parseAgentLine('claude', line('WebSearch', { query: '写作 聊天框' })).step, '⌕ 写作 聊天框');
        assert.strictEqual(parseAgentLine('claude', line('Read', { file_path: '/blog/posts/post.md' })).step, 'post.md');
        assert.strictEqual(parseAgentLine('claude', line('WebFetch', { url: 'https://example.com/a/b' })).step, '↗ example.com');
        assert.strictEqual(parseAgentLine('claude', line('Grep', { pattern: '缓存' })).step, '⌕ 缓存');
    });
    test('Claude Code result carries the final answer or the failure', () => {
        assert.deepStrictEqual(parseAgentLine('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '答' })), { final: '答' });
        assert.strictEqual(parseAgentLine('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' })).error, 'Not logged in');
        assert.ok(parseAgentLine('claude', JSON.stringify({ type: 'result', subtype: 'error_max_turns' })).error);
    });
    test('Codex messages, commands and failures are understood', () => {
        const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '它的标题是“测试”。' } });
        assert.strictEqual(parseAgentLine('codex', message).final, '它的标题是“测试”。');
        const command = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: "/bin/zsh -lc 'cat doc.md'" } });
        assert.strictEqual(parseAgentLine('codex', command).step, '$ cat doc.md');
        assert.strictEqual(parseAgentLine('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } })).error, 'quota');
    });
    test('noise on stdout is ignored', () => {
        assert.deepStrictEqual(parseAgentLine('claude', 'warning: something'), {});
        assert.deepStrictEqual(parseAgentLine('codex', '{broken'), {});
        assert.deepStrictEqual(parseAgentLine('claude', JSON.stringify({ type: 'rate_limit_event' })), {});
    });
});
