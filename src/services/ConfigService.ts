import * as vscode from 'vscode';
import type { AgentPreference } from './AgentService';

export interface ResolvedConfig {
    /** Which agent CLI answers margin notes; "auto" picks the first one installed. */
    agent: AgentPreference;
    /** Relative subdirectory for files dropped into BB Editor; empty = beside the document. */
    assetDir: string;
}

const AGENTS: AgentPreference[] = ['auto', 'claude', 'codex'];

export class ConfigService {
    private static instance: ConfigService;
    private readonly configSection = 'blogbuddy';

    private constructor() { }

    public static getInstance(): ConfigService {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }

    public getAllConfig(): ResolvedConfig {
        const config = vscode.workspace.getConfiguration(this.configSection);
        const agent = config.get<string>('agent', 'auto') as AgentPreference;
        return {
            agent: AGENTS.includes(agent) ? agent : 'auto',
            assetDir: config.get<string>('assetDir', ''),
        };
    }
}
