import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { AgentService, AgentPreference } from '../services/AgentService';
import { AGENT_LABEL } from '../services/agentProtocol';
import type { NoteScopeKind, NoteTurnWire } from '../services/webviewProtocol';

/** A margin note's question, as the business layer sees it. */
export interface NoteRequest {
    question: string;
    scopeKind: NoteScopeKind;
    /** Markdown of the blocks the note is about. */
    scopeMarkdown: string;
    /** Text the writer had selected inside the block, if any. */
    quote?: string;
    /** Earlier turns of the same note, oldest first. */
    history: NoteTurnWire[];
    /** The document on disk; absent for an unsaved document. */
    filePath?: string;
    /** The editor holds changes not yet saved, so the file on disk may be behind. */
    unsavedChanges?: boolean;
    /** Folder the agent may read from. */
    cwd: string;
}

export interface NoteAnswer {
    /** The agent's answer, Markdown. */
    reply: string;
    /** A rewrite of the whole scope, when the writer asked for changes. */
    replacement?: string;
    /** Display name of the agent that answered. */
    agent: string;
    seconds: number;
}

const SCOPE_NAME: Record<NoteScopeKind, string> = {
    block: '文档里的一个块（一段、一个列表、一段代码等）',
    section: '一个小节（标题和它下面的内容）',
    range: '相邻的几个块',
};

/** The agent returns a rewrite between these tags; everything else is the answer. */
const REPLACE = /<bb-replace>\s*\n?([\s\S]*?)\n?\s*<\/bb-replace>/g;

export function buildNotePrompt(request: NoteRequest): string {
    const lines: string[] = [
        '你在协助一位正在写 Markdown 文档的写作者。写作者没有离开编辑器，只是在文档旁给你留了一句话；你的回答会显示在那段文字下方的窄栏里，写作者稍后才看。',
        '',
        !request.filePath
            ? '文档还没有保存到磁盘，下面的范围就是你能看到的全部内容。'
            : request.unsavedChanges
                ? `文档：${request.filePath}（需要上下文时用读文件工具读全文；编辑器里有还没保存的修改，磁盘上的版本可能较旧，下面的范围以编辑器为准）`
                : `文档：${request.filePath}（需要上下文时用读文件工具读全文）`,
        `这句话针对的范围是${SCOPE_NAME[request.scopeKind]}，Markdown 原文如下：`,
        '<bb-scope>',
        request.scopeMarkdown.trim(),
        '</bb-scope>',
    ];
    if (request.quote) { lines.push(`写作者选中了其中这几个字：「${request.quote}」`); }
    if (request.history.length) {
        lines.push('', '这条旁注里之前的对话：');
        for (const turn of request.history) { lines.push(`${turn.role === 'me' ? '写作者' : '你'}：${turn.text.trim()}`); }
    }
    lines.push(
        '',
        `写作者现在说：${request.question.trim()}`,
        '',
        '要求：',
        '- 直接回答，尽量短，用写作者所用的语言。只用简单的 Markdown（段落、列表、粗体、链接），不要标题和表格。',
        '- 需要查资料就联网搜索，并在回答末尾用链接列出来源。没有查到就明说，不要编造。',
        '- 不要修改磁盘上的任何文件。',
        '- 只有当写作者要你改文字（润色、收紧、改写、纠错、调整结构、翻译等）时才给修改稿。做法是：正文用一两句话说明改了什么，然后在回答的最后输出',
        '<bb-replace>',
        '（<bb-scope> 里全部内容改完之后的 Markdown）',
        '</bb-replace>',
        '  修改稿会完整替换 <bb-scope> 的内容，所以没有改动的块必须原样保留、一字不动；不要把 <bb-scope> 以外的内容写进去。写作者没有要求改文字时，不要输出 <bb-replace>。',
    );
    return lines.join('\n');
}

/** Split the agent's raw answer into what it says and what it proposes to change. */
export function parseNoteReply(raw: string, scopeMarkdown: string): { reply: string; replacement?: string } {
    const matches = [...raw.matchAll(REPLACE)];
    const replacement = matches.length ? matches[matches.length - 1][1].replace(/\s+$/, '') : undefined;
    const reply = raw.replace(REPLACE, '').trim();
    if (replacement === undefined || replacement.trim() === scopeMarkdown.trim()) {
        return { reply: reply || l10n.t('(No answer)') };
    }
    return { reply: reply || l10n.t('Done. The changes are marked on the text.'), replacement };
}

/** Answers margin notes by handing them to the writer's own agent. */
export class NoteAssistant {
    static async ask(
        request: NoteRequest,
        preference: AgentPreference,
        onStep: (step: string) => void,
        signal: AbortSignal,
    ): Promise<NoteAnswer> {
        const started = Date.now();
        const output = await AgentService.getInstance().run({
            prompt: buildNotePrompt(request),
            cwd: request.cwd || (request.filePath ? path.dirname(request.filePath) : process.cwd()),
            preference, signal, onStep,
        });
        return {
            ...parseNoteReply(output.text, request.scopeMarkdown),
            agent: AGENT_LABEL[output.agent],
            seconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
        };
    }
}
