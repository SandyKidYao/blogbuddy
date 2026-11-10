import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { commandsCtx } from '@milkdown/kit/core';
import { $prose } from '@milkdown/kit/utils';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/kit/prose/view';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import {
    wrapInHeadingCommand,
    createCodeBlockCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInOrderedListCommand,
    insertHrCommand,
} from '@milkdown/kit/preset/commonmark';
import type { CommandManager } from '@milkdown/kit/core';

// ---- Types ----

interface SlashItem {
    label: string;
    desc: string;
    onSelect: (view: EditorView, slashProvider: SlashProvider) => void;
}

// ---- Helpers ----

function removeSlashText(view: EditorView): void {
    const { state } = view;
    const $from = state.doc.resolve(state.selection.from);
    const blockStart = $from.start();
    const cursorOffset = $from.parentOffset;
    const blockText = $from.parent.textContent;

    // Find the "/" before (or at) the cursor within the current block
    const textBeforeCursor = blockText.slice(0, cursorOffset);
    const slashIdx = textBeforeCursor.lastIndexOf('/');
    if (slashIdx === -1) { return; }

    // Delete from "/" to cursor position (removes "/" and any filter text like "/bb")
    const from = blockStart + slashIdx;
    const to = blockStart + cursorOffset;
    const tr = state.tr.delete(from, to);
    view.dispatch(tr);
}

// ---- Build All Slash Items ----

function buildSlashItems(commands: CommandManager): SlashItem[] {
    const items: SlashItem[] = [];

    // Formatting items
    const fmtAction = (fn: () => void) => (view: EditorView, sp: SlashProvider) => {
        sp.hide();
        removeSlashText(view);
        fn();
    };

    items.push({ label: 'Heading 1', desc: 'Large section heading',
        onSelect: fmtAction(() => commands.call(wrapInHeadingCommand.key, 1)) });
    items.push({ label: 'Heading 2', desc: 'Medium section heading',
        onSelect: fmtAction(() => commands.call(wrapInHeadingCommand.key, 2)) });
    items.push({ label: 'Heading 3', desc: 'Small section heading',
        onSelect: fmtAction(() => commands.call(wrapInHeadingCommand.key, 3)) });
    items.push({ label: 'Bullet List', desc: 'Unordered list',
        onSelect: fmtAction(() => commands.call(wrapInBulletListCommand.key)) });
    items.push({ label: 'Ordered List', desc: 'Numbered list',
        onSelect: fmtAction(() => commands.call(wrapInOrderedListCommand.key)) });
    items.push({ label: 'Code Block', desc: 'Fenced code block',
        onSelect: fmtAction(() => commands.call(createCodeBlockCommand.key)) });
    items.push({ label: 'Blockquote', desc: 'Quote block',
        onSelect: fmtAction(() => commands.call(wrapInBlockquoteCommand.key)) });
    items.push({ label: 'Divider', desc: 'Horizontal rule',
        onSelect: fmtAction(() => commands.call(insertHrCommand.key)) });

    return items;
}

// ---- Slash Menu Controller (keyboard navigation) ----

class SlashMenuController {
    private itemEls: HTMLElement[] = [];
    private activeIndex = 0;
    visible = false;

    // True while keyboard is the active input device. When the keyboard scrolls
    // the menu via scrollIntoView, items slide under a stationary mouse cursor
    // and the browser fires synthetic `mouseenter` events on whichever items
    // pass under it — which would otherwise yank the active highlight to the
    // wrong index. We ignore mouseenter in this mode, then clear it the moment
    // the mouse actually moves (mousemove only fires on real motion, not on
    // scroll-induced layout shifts).
    private keyboardNavMode = false;

    constructor(
        private items: SlashItem[],
        private view: EditorView,
        private slashProvider: SlashProvider,
    ) {}

    buildDOM(): HTMLElement {
        const menu = document.createElement('div');
        menu.className = 'bb-slash-menu';

        // Real mouse motion releases keyboard-nav mode. We listen on the menu
        // root (one listener, not N) — a mousemove anywhere over the menu means
        // the user is back to mouse-driven selection.
        menu.addEventListener('mousemove', () => {
            this.keyboardNavMode = false;
        });

        for (const item of this.items) {
            const el = document.createElement('div');
            el.className = 'bb-slash-item';

            const labelSpan = document.createElement('span');
            labelSpan.className = 'bb-slash-item__label';
            labelSpan.textContent = item.label;

            const descSpan = document.createElement('span');
            descSpan.className = 'bb-slash-item__desc';
            descSpan.textContent = item.desc;

            el.appendChild(labelSpan);
            el.appendChild(descSpan);

            const idx = this.itemEls.length;
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.items[idx].onSelect(this.view, this.slashProvider);
            });
            el.addEventListener('mouseenter', () => {
                // Ignore mouseenter triggered by scrollIntoView during keyboard
                // navigation — the mouse hasn't actually moved.
                if (this.keyboardNavMode) { return; }
                this.setActive(idx);
            });

            this.itemEls.push(el);
            menu.appendChild(el);
        }

        this.setActive(0);
        return menu;
    }

    onShow(): void {
        this.visible = true;
        this.setActive(0);
    }

    onHide(): void {
        this.visible = false;
    }

    handleKeyDown(e: KeyboardEvent): boolean {
        if (!this.visible) { return false; }
        if (this.view.composing || e.isComposing) { return false; }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                // Clamp at the last item instead of wrapping to the top: a
                // wrap is indistinguishable from "I just hit the bottom of
                // what I can see" in a scrollable list.
                this.keyboardNavMode = true;
                this.setActive(Math.min(this.activeIndex + 1, this.itemEls.length - 1));
                return true;
            case 'ArrowUp':
                e.preventDefault();
                this.keyboardNavMode = true;
                this.setActive(Math.max(this.activeIndex - 1, 0));
                return true;
            case 'Enter':
                e.preventDefault();
                this.items[this.activeIndex].onSelect(this.view, this.slashProvider);
                return true;
            case 'Escape':
                e.preventDefault();
                this.slashProvider.hide();
                return true;
            default:
                return false;
        }
    }

    private setActive(index: number): void {
        if (this.itemEls[this.activeIndex]) {
            this.itemEls[this.activeIndex].classList.remove('bb-slash-item--active');
        }
        this.activeIndex = index;
        if (this.itemEls[this.activeIndex]) {
            this.itemEls[this.activeIndex].classList.add('bb-slash-item--active');
            this.itemEls[this.activeIndex].scrollIntoView({ block: 'nearest' });
        }
    }
}

// ---- Exported Plugin ----

const bbSlashPluginKey = new PluginKey('bb-slash');

const bbSlashProse = $prose((ctx) => {
    const commands = ctx.get(commandsCtx);
    const items = buildSlashItems(commands);

    let controller: SlashMenuController | null = null;

    return new Plugin({
        key: bbSlashPluginKey,
        props: {
            handleKeyDown(_view, event) {
                return controller?.handleKeyDown(event) ?? false;
            },
        },
        view: (editorView: EditorView) => {
            const menuContent = document.createElement('div');
            menuContent.className = 'bb-slash-dropdown';

            const slashProvider = new SlashProvider({
                content: menuContent,
                trigger: '/',
            });

            controller = new SlashMenuController(items, editorView, slashProvider);
            const menu = controller.buildDOM();
            menuContent.appendChild(menu);

            slashProvider.onShow = () => controller?.onShow();
            slashProvider.onHide = () => controller?.onHide();

            return {
                update: (view: EditorView, prevState: EditorView['state']) => {
                    slashProvider.update(view, prevState);
                },
                destroy: () => {
                    slashProvider.destroy();
                    controller = null;
                },
            };
        },
    });
});

export const bbSlashPlugin: MilkdownPlugin[] = [
    bbSlashProse,
];
