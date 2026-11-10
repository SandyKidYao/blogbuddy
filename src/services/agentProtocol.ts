/**
 * How BlogBuddy talks to the agent CLIs it borrows (Claude Code, Codex):
 * the arguments for a headless, read-only run and the meaning of each line
 * they stream back. Pure — no process handling, no VS Code API.
 */

export type AgentKind = 'claude' | 'codex';

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

/** What one line of agent output means to us. */
export interface AgentEvent {
    /** A short progress note in symbols: "⌕ query", "↗ host", a file name, "$ command", "✎", "…". */
    step?: string;
    /** The agent's final answer. */
    final?: string;
    /** The run failed; this is why. */
    error?: string;
}

/** Read-only tools: the agent may look things up, never change the workspace. */
const CLAUDE_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch';

/** Arguments for a headless run; the prompt is written to stdin. */
export function agentArgs(kind: AgentKind, cwd: string): string[] {
    if (kind === 'claude') {
        return ['-p', '--output-format', 'stream-json', '--verbose',
            '--tools', CLAUDE_TOOLS, '--allowedTools', CLAUDE_TOOLS, '--no-session-persistence'];
    }
    return ['--search', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', cwd, '-'];
}

const clip = (text: string, max = 48): string => {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
};

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;

function hostOf(url: string): string {
    try { return new URL(url).hostname; } catch { return clip(url, 32); }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function claudeToolStep(name: string, input: Json): string {
    switch (name) {
        case 'Read': return fileName(text(input.file_path));
        case 'Grep': case 'Glob': return `⌕ ${clip(text(input.pattern), 32)}`;
        case 'WebSearch': return `⌕ ${clip(text(input.query))}`;
        case 'WebFetch': return `↗ ${hostOf(text(input.url))}`;
        default: return name;
    }
}

function claudeEvent(event: Json): AgentEvent {
    if (event.type === 'system' && event.subtype === 'init') { return { step: '…' }; }
    if (event.type === 'assistant' && isObject(event.message) && Array.isArray(event.message.content)) {
        let step: string | undefined;
        for (const part of event.message.content) {
            if (!isObject(part)) { continue; }
            if (part.type === 'tool_use') { step = claudeToolStep(text(part.name), isObject(part.input) ? part.input : {}); }
            else if (part.type === 'text' && !step) { step = '✎'; }
        }
        return { step };
    }
    if (event.type === 'result') {
        const result = text(event.result);
        if (event.is_error || event.subtype !== 'success') { return { error: result || `Claude Code 没有完成（${text(event.subtype) || '未知原因'}）` }; }
        return { final: result };
    }
    return {};
}

/** Codex wraps commands as `/bin/zsh -lc '…'`; show what it actually ran. */
function shellCommand(command: string): string {
    const inner = /-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
    return clip(inner ? inner[2] : command, 40);
}

function codexEvent(event: Json): AgentEvent {
    const item = isObject(event.item) ? event.item : undefined;
    if (event.type === 'thread.started') { return { step: '…' }; }
    if (event.type === 'error') { return { error: text(event.message) || 'Codex 报告了一个错误' }; }
    if (event.type === 'turn.failed') {
        return { error: (isObject(event.error) && text(event.error.message)) || 'Codex 没有完成这次请求' };
    }
    if (!item) { return {}; }
    if (item.type === 'agent_message' && event.type === 'item.completed') { return { step: '✎', final: text(item.text) }; }
    if (event.type !== 'item.started') { return {}; }
    if (item.type === 'command_execution') { return { step: `$ ${shellCommand(text(item.command))}` }; }
    if (item.type === 'web_search') { return { step: `⌕ ${clip(text(item.query))}` }; }
    if (item.type === 'reasoning') { return { step: '…' }; }
    return {};
}

/** Interpret one line of the agent's stdout. Lines that are not JSON events are ignored. */
export function parseAgentLine(kind: AgentKind, line: string): AgentEvent {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) { return {}; }
    let event: unknown;
    try { event = JSON.parse(trimmed); } catch { return {}; }
    if (!isObject(event)) { return {}; }
    return kind === 'claude' ? claudeEvent(event) : codexEvent(event);
}
