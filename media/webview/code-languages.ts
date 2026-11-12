import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';

/**
 * Languages highlighted inside fenced code blocks, named by what follows the ```.
 * A curated set bundled up front (the webview is one IIFE file, so there is no
 * lazy loading); anything else shows as plain code.
 */

const legacy = (parser: StreamParser<unknown>): LanguageSupport => new LanguageSupport(StreamLanguage.define(parser));

const lang = (name: string, alias: string[], support: () => LanguageSupport): LanguageDescription =>
    LanguageDescription.of({ name, alias, support: support() });

export const codeLanguages: LanguageDescription[] = [
    lang('JavaScript', ['javascript', 'js', 'mjs', 'cjs', 'node'], () => javascript()),
    lang('JSX', ['jsx'], () => javascript({ jsx: true })),
    lang('TypeScript', ['typescript', 'ts', 'mts', 'cts'], () => javascript({ typescript: true })),
    lang('TSX', ['tsx'], () => javascript({ typescript: true, jsx: true })),
    lang('JSON', ['json', 'jsonc', 'json5'], () => json()),
    lang('CSS', ['css', 'scss', 'less'], () => css()),
    lang('HTML', ['html', 'htm', 'vue', 'svelte'], () => html()),
    lang('XML', ['xml', 'svg'], () => xml()),
    lang('Python', ['python', 'py'], () => python()),
    lang('Rust', ['rust', 'rs'], () => rust()),
    lang('Go', ['go', 'golang'], () => go()),
    lang('Java', ['java', 'kotlin', 'kt'], () => java()),
    lang('C++', ['cpp', 'c++', 'cc', 'c', 'h', 'hpp', 'objc', 'cs', 'csharp'], () => cpp()),
    lang('SQL', ['sql', 'mysql', 'postgresql', 'sqlite'], () => sql()),
    lang('YAML', ['yaml', 'yml'], () => yaml()),
    lang('Shell', ['shell', 'bash', 'sh', 'zsh', 'console', 'shellscript'], () => legacy(shell)),
    lang('Diff', ['diff', 'patch'], () => legacy(diff)),
    lang('TOML', ['toml'], () => legacy(toml)),
];
