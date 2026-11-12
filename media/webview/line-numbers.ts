import type { Extension } from '@codemirror/state';
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { frontmatterField } from './frontmatter';

/**
 * Source line numbers in the left margin (.bb-source-gutter): faint labels
 * placed on each line's text, only the caret's line brought forward. They are
 * the file's line numbers; lines without text, and the frontmatter (shown as
 * the properties panel), get none.
 *
 * Measured from the text itself rather than a CodeMirror gutter, so a number
 * sits on its heading's or code line's glyphs whatever the line's padding.
 */

interface Label { n: number; top: number; height: number; active: boolean }

export function sourceLineNumbers(): Extension {
    return ViewPlugin.fromClass(class {
        readonly gutter = document.createElement('div');
        readonly container = document.getElementById('editor');

        constructor(readonly view: EditorView) {
            this.gutter.className = 'bb-source-gutter';
            this.gutter.setAttribute('aria-hidden', 'true');
            this.container?.append(this.gutter);
            this.schedule();
        }

        // Any update, including the editor's own re-measure after a block (the panel, a note) changed height.
        update(_update: ViewUpdate): void { this.schedule(); }

        schedule(): void {
            this.view.requestMeasure({ key: this, read: () => this.read(), write: labels => this.write(labels) });
        }

        read(): Label[] {
            if (!this.container) { return []; }
            const { state } = this.view, doc = state.doc;
            const base = this.container.getBoundingClientRect().top - this.container.scrollTop;
            const active = doc.lineAt(state.selection.main.head).number;
            const body = state.field(frontmatterField).body;
            const labels: Label[] = [];
            let lastTop = Number.NaN;
            for (const { from, to } of this.view.visibleRanges) {
                for (let pos = from; pos <= to;) {
                    const line = doc.lineAt(pos);
                    pos = line.to + 1;
                    if (!line.text.trim() || line.from < body) { continue; }
                    const coords = this.view.coordsAtPos(line.from, 1);
                    // Lines inside a rendered table share its box: number only the first.
                    if (!coords || coords.top === lastTop) { continue; }
                    lastTop = coords.top;
                    const height = Math.min(coords.bottom - coords.top, this.view.defaultLineHeight * 2);
                    labels.push({ n: line.number, top: coords.top - base, height, active: line.number === active });
                }
            }
            return labels;
        }

        write(labels: Label[]): void {
            this.gutter.replaceChildren(...labels.map(label => {
                const item = document.createElement('span');
                item.textContent = String(label.n);
                item.style.top = `${label.top}px`;
                item.style.lineHeight = `${label.height}px`;
                if (label.active) { item.className = 'is-active'; }
                return item;
            }));
        }

        destroy(): void {
            this.gutter.remove();
        }
    });
}
