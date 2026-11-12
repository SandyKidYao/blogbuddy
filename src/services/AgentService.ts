import { spawn, execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { AgentKind, AGENT_LABEL, agentArgs, parseAgentLine } from './agentProtocol';

export type AgentPreference = 'auto' | AgentKind;

export interface AgentRun {
    prompt: string;
    /** Working directory: the agent may read files under it. */
    cwd: string;
    preference: AgentPreference;
    signal: AbortSignal;
    onStep: (step: string) => void;
}

export interface AgentOutput {
    text: string;
    agent: AgentKind;
}

/** A failure the writer can act on; `message` is shown as-is. */
export class AgentError extends Error {}

const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const AUTO_ORDER: AgentKind[] = ['claude', 'codex'];

/**
 * The single door to AI: runs the agent CLI the writer already has installed
 * and signed in to, headless and read-only, and reports its progress.
 */
export class AgentService {
    private static instance: AgentService;
    private readonly binaries = new Map<AgentKind, Promise<string | undefined>>();
    private searchPath?: Promise<string>;

    static getInstance(): AgentService {
        return (AgentService.instance ??= new AgentService());
    }

    async run(run: AgentRun): Promise<AgentOutput> {
        const { kind, binary } = await this.pick(run.preference);
        const env = { ...process.env, PATH: await this.getSearchPath() };
        run.onStep(kind);

        return new Promise<AgentOutput>((resolve, reject) => {
            if (run.signal.aborted) { reject(new AgentError(l10n.t('Cancelled'))); return; }
            const child = spawn(binary, agentArgs(kind, run.cwd), {
                cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32',
            });
            let final = '', stderr = '', buffer = '', settled = false;
            let error: string | undefined;

            const finish = (action: () => void): void => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                run.signal.removeEventListener('abort', onAbort);
                action();
            };
            const onAbort = (): void => { child.kill(); finish(() => reject(new AgentError(l10n.t('Cancelled')))); };
            const timer = setTimeout(() => {
                child.kill();
                finish(() => reject(new AgentError(l10n.t("{0} didn't finish within 15 minutes and was stopped.", AGENT_LABEL[kind]))));
            }, RUN_TIMEOUT_MS);
            run.signal.addEventListener('abort', onAbort);

            const readLine = (line: string): void => {
                const event = parseAgentLine(kind, line);
                if (event.step) { run.onStep(event.step); }
                if (event.final !== undefined) { final = event.final; }
                if (event.error !== undefined) { error = event.error; }
            };
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                lines.forEach(readLine);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });

            child.on('error', cause => finish(() => reject(new AgentError(l10n.t("Couldn't start {0}: {1}", AGENT_LABEL[kind], cause.message)))));
            child.on('close', code => finish(() => {
                if (buffer) { readLine(buffer); }
                if (error !== undefined) {
                    // Our sentence in the interface language, then the agent's own words as they are.
                    const reason = l10n.t('{0} reported an error', AGENT_LABEL[kind]);
                    reject(new AgentError(error ? l10n.t('{0}: {1}', reason, error) : reason));
                }
                else if (final.trim()) { resolve({ text: final, agent: kind }); }
                else {
                    const detail = stderr.trim().split('\n').slice(-3).join(' ').trim();
                    const reason = code
                        ? l10n.t('{0} gave no answer (exit code {1})', AGENT_LABEL[kind], code)
                        : l10n.t('{0} gave no answer', AGENT_LABEL[kind]);
                    // The agent's own output is passed through as it is, untranslated.
                    reject(new AgentError(detail ? l10n.t('{0}: {1}', reason, detail) : reason));
                }
            }));

            // The prompt can be long (it carries the text being discussed); stdin has no length limit.
            child.stdin.on('error', () => { /* the process exited early; 'close' reports why */ });
            child.stdin.end(run.prompt);
        });
    }

    private async pick(preference: AgentPreference): Promise<{ kind: AgentKind; binary: string }> {
        const order = preference === 'auto' ? AUTO_ORDER : [preference];
        for (const kind of order) {
            const binary = await this.findBinary(kind);
            if (binary) { return { kind, binary }; }
        }
        throw new AgentError(preference === 'auto'
            ? l10n.t('No claude or codex command found. Margin notes use the agent you already have: install and sign in to Claude Code or Codex.')
            : l10n.t('No {0} command found. Make sure {1} is installed and signed in, or set blogbuddy.agent to auto.', preference, AGENT_LABEL[preference]));
    }

    private findBinary(kind: AgentKind): Promise<string | undefined> {
        let found = this.binaries.get(kind);
        if (!found) {
            found = this.getSearchPath().then(async searchPath => {
                const names = process.platform === 'win32' ? [`${kind}.cmd`, `${kind}.exe`, kind] : [kind];
                for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
                    for (const name of names) {
                        const candidate = path.join(dir, name);
                        try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
                    }
                }
                return undefined;
            });
            this.binaries.set(kind, found);
            // A CLI installed later should be found without restarting VS Code.
            void found.then(binary => { if (!binary) { this.binaries.delete(kind); this.searchPath = undefined; } });
        }
        return found;
    }

    /**
     * VS Code started from the Dock does not inherit the shell's PATH, which is
     * where these CLIs usually live. Combine ours, the login shell's, and the
     * common install locations.
     */
    private getSearchPath(): Promise<string> {
        return (this.searchPath ??= (async () => {
            const home = os.homedir();
            const dirs = (process.env.PATH ?? '').split(path.delimiter);
            dirs.push(...(await loginShellPath()).split(path.delimiter));
            dirs.push(
                path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
                path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'),
                path.join(home, '.volta', 'bin'), path.join(home, '.cargo', 'bin'),
            );
            return [...new Set(dirs.filter(Boolean))].join(path.delimiter);
        })());
    }
}

function loginShellPath(): Promise<string> {
    if (process.platform === 'win32') { return Promise.resolve(''); }
    const mark = '__BB_PATH__';
    return new Promise(resolve => {
        execFile(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '${mark}%s${mark}' "$PATH"`],
            { timeout: 5000, encoding: 'utf8' },
            (_error, stdout) => resolve(new RegExp(`${mark}(.*?)${mark}`, 's').exec(stdout ?? '')?.[1] ?? ''));
    });
}
