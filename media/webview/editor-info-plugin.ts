import { remarkCtx } from '@milkdown/kit/core';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { MarkdownStatsAnalyzer } from '../../src/utils/MarkdownStatsAnalyzer';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorDocumentStats } from '../../src/services/webviewProtocol';

interface EditorInfoOptions {
    markdown: () => string;
    frontmatter: () => string;
    stats: (stats: EditorDocumentStats) => void;
}
interface SourceNode {
    type: string;
    position?: { start: { line: number } };
    children?: SourceNode[];
}
interface SourceLine { type: string; line: number }

let refreshCurrent: (() => void) | undefined;
export function refreshEditorInfo(): void { refreshCurrent?.(); }

/** Adds source positions and live statistics without replacing editing controls. */
export function editorInfoPlugin(options: EditorInfoOptions): MilkdownPlugin {
    return $prose(ctx => {
        let decorations = DecorationSet.empty;
        let view: EditorView;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sourceLines = new Map<number, number>();
        let lastStats: EditorDocumentStats = { words: 0, characters: 0, lines: 1, selectedWords: 0 };
        const analyzer = new MarkdownStatsAnalyzer();
        const gutter = document.createElement('div');
        gutter.className = 'bb-source-gutter';
        gutter.setAttribute('aria-hidden', 'true');
        let observer: ResizeObserver;
        const labels = new Map<number, HTMLElement>();
        let activeLabel: HTMLElement | undefined;

        /** Source line of the cursor, so only that number is emphasized. */
        function cursorLine(): number | undefined {
            const { $head } = view.state.selection;
            if (!$head.parent.isTextblock) { return undefined; }
            const line = sourceLines.get($head.before());
            if (line === undefined || $head.parent.type.name !== 'code_block') { return line; }
            return line + $head.parent.textBetween(0, $head.parentOffset).split('\n').length;
        }

        function markActiveLine(): void {
            const next = (() => { const line = cursorLine(); return line === undefined ? undefined : labels.get(line); })();
            if (next === activeLabel) { return; }
            activeLabel?.classList.remove('is-active');
            next?.classList.add('is-active');
            activeLabel = next;
        }

        function publishStats(): void {
            const selected = analyzer.analyze(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n'));
            lastStats = { ...lastStats, selectedWords: selected.chineseCharacters + selected.englishWords };
            options.stats(lastStats);
        }

        function measureGutter(): void {
            const container = document.getElementById('editor');
            if (!container) { return; }
            const top = container.getBoundingClientRect().top - container.scrollTop;
            labels.clear();
            activeLabel = undefined;
            gutter.replaceChildren();
            const lineHeight = (el: Element): number => {
                const style = getComputedStyle(el);
                return parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
            };
            // Each number takes its block's first-line height so it sits on that line's text, not above it.
            const label = (line: number, y: number, height: number): void => {
                if (labels.has(line)) { return; }
                const item = document.createElement('span');
                item.textContent = String(line);
                item.style.top = `${y}px`;
                item.style.lineHeight = `${height}px`;
                labels.set(line, item);
                gutter.append(item);
            };
            for (const [pos, line] of sourceLines) {
                const dom = view.nodeDOM(pos);
                if (!(dom instanceof HTMLElement) || !dom.getBoundingClientRect().height) { continue; }
                const node = view.state.doc.nodeAt(pos);
                const code = node?.type.name === 'code_block' ? dom.querySelector('code') : null;
                if (code && node) {
                    const height = lineHeight(code);
                    label(line, dom.getBoundingClientRect().top - top, height);
                    for (let i = 0; i < node.textContent.split('\n').length; i++) {
                        label(line + i + 1, code.getBoundingClientRect().top - top + i * height, height);
                    }
                } else {
                    label(line, dom.getBoundingClientRect().top - top, lineHeight(dom));
                }
            }
            markActiveLine();
        }

        function refresh(): void {
            if (!view || view.composing) { return; }
            const markdown = options.markdown();
            const frontmatter = options.frontmatter();
            const offset = frontmatter.split('\n').length - 1;
            const source: SourceLine[] = [];
            const collect = (node: SourceNode): void => {
                const type = ({ heading: 'heading', paragraph: 'paragraph', code: 'code_block', tableCell: 'paragraph', html: 'paragraph' } as Record<string, string>)[node.type];
                if (type && node.position) { source.push({ type, line: node.position.start.line + offset }); }
                if (!['paragraph', 'heading', 'code', 'tableCell', 'html'].includes(node.type)) { node.children?.forEach(collect); }
            };
            collect(ctx.get(remarkCtx).parse(markdown) as SourceNode);
            sourceLines = new Map();
            let cursor = 0;
            const decos: Decoration[] = [];
            view.state.doc.descendants((node, pos) => {
                if (node.isTextblock) {
                    const index = source.findIndex((line, i) => i >= cursor && line.type === node.type.name);
                    const line = index >= 0 ? source[index].line : 1 + offset;
                    if (index >= 0) { cursor = index + 1; }
                    sourceLines.set(pos, line);
                    const attrs: Record<string, string> = { 'data-line': String(line) };
                    if (node.type.name === 'heading') {
                        attrs['data-heading-level'] = `H${node.attrs.level}`;
                        attrs.class = 'bb-heading-hint';
                        attrs.title = `H${node.attrs.level} · ${node.attrs.level} 级标题 · 第 ${line} 行`;
                    }
                    decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
                }
            });
            decorations = DecorationSet.create(view.state.doc, decos);
            view.dispatch(view.state.tr.setMeta('bb-editor-info', true).setMeta('addToHistory', false));
            const analyzed = analyzer.analyze(markdown);
            lastStats = { words: analyzed.chineseCharacters + analyzed.englishWords, characters: analyzed.totalCharacters,
                lines: (frontmatter + markdown).split('\n').length, selectedWords: 0 };
            publishStats();
            measureGutter();
        }

        function schedule(): void {
            if (timer) { clearTimeout(timer); }
            // Line numbers and stats trail typing; a full parse + layout per pause is enough.
            timer = setTimeout(refresh, 250);
        }

        return new Plugin({
            state: {
                init: () => { decorations = DecorationSet.empty; sourceLines.clear(); return decorations; },
                apply(tr) {
                    if (tr.docChanged) { decorations = decorations.map(tr.mapping, tr.doc); }
                    return decorations;
                },
            },
            props: { decorations: () => decorations },
            view(editorView) {
                view = editorView;
                document.getElementById('editor')?.append(gutter);
                observer = new ResizeObserver(measureGutter);
                observer.observe(view.dom);
                // The frontmatter head sits above the content; its height moves every line.
                const head = document.getElementById('frontmatter-panel');
                if (head) { observer.observe(head); }
                refreshCurrent = schedule;
                window.addEventListener('bb-document-loaded', schedule);
                schedule();
                return {
                    update(next, previous) {
                        view = next;
                        if (!previous.doc.eq(next.state.doc)) { schedule(); }
                        else if (!previous.selection.eq(next.state.selection)) { publishStats(); markActiveLine(); }
                    },
                    destroy() {
                        if (timer) { clearTimeout(timer); }
                        observer.disconnect();
                        gutter.remove();
                        refreshCurrent = undefined;
                        window.removeEventListener('bb-document-loaded', schedule);
                    },
                };
            },
        });
    });
}
