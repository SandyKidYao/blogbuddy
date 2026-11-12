import * as l10n from '@vscode/l10n';
import { lastProposalTurn, lensOn, type AiTurn, type Mark, type Note, type NoteActions, type Scope } from './notes-model';

/**
 * Everything a margin note shows.
 *
 * Layout rule: what informs sits on the left (the rail beside a note's blocks,
 * the sign beside a changed block, the summary line under the block); what
 * acts sits on the right (accept / reject beside each changed block, and the
 * note's own buttons at the right end of its rows).
 *
 * The UI speaks in signs, not words: the same ~ + − ⤷ that mark changed blocks
 * also count them, and every button is a glyph. Words appear only in tooltips
 * and in messages that explain a failure.
 *
 * A note's own line / card is a widget in the document flow (see the plugin);
 * rails, signs and controls are measured onto a layer over the editor, the
 * same way the source line numbers are.
 *
 * The view knows nothing about the editor engine: it reads block geometry
 * through a NotesSurface, which each engine provides.
 */

/** What the note UI needs to know about the editor, in viewport coordinates. */
export interface NotesSurface {
    /** The editor's root element; when its size changes, every note moves. */
    readonly dom: HTMLElement;
    readonly editable: boolean;
    readonly selectionEmpty: boolean;
    /** Start position of the top-level block under a viewport y, if any. */
    blockAt(clientY: number): number | null;
    /** Box of the top-level block starting at pos, with the height of its first line; null when not laid out. */
    blockBox(pos: number): { top: number; bottom: number; line: number } | null;
    /** Bottom of the caret. */
    caretBottom(): number | null;
}

/** Line height of an element, for centering a sign on its first line. */
function lineHeightOf(target: Element): number {
    return parseFloat(getComputedStyle(target).lineHeight) || 26;
}

/** What a change sign in the gutter means, for its tooltip. */
function signTitle(sign: string): string {
    switch (sign) {
        case '~': return l10n.t('Rewritten');
        case '+': return l10n.t('Added');
        case '−': return l10n.t('Removed');
        case '⤷': return l10n.t('Moved here from elsewhere');
        case '↑': return l10n.t('This block moved up');
        case '↓': return l10n.t('This block moved down');
        default: return '';
    }
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) { element.className = className; }
    if (text) { element.textContent = text; }
    return element;
}

function button(className: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
    const element = h('button', className, label);
    element.type = 'button';
    if (title) { element.title = title; }
    element.addEventListener('click', event => { event.preventDefault(); onClick(); });
    return element;
}

const composing = (event: KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;
const plain = (markdown: string): string => markdown.replace(/[*_`#>]|\[|\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

interface MarkElements { sign?: HTMLElement; bar?: HTMLElement; controls?: HTMLElement }

export class NotesView {
    private readonly container: HTMLElement;
    private readonly layer = h('div', 'bb-notes-layer');
    private readonly rails = new Map<string, HTMLButtonElement>();
    private readonly markEls = new Map<string, MarkElements>();
    private marks: Mark[] = [];
    private readonly ghost: HTMLButtonElement;
    private readonly askBox = h('div', 'bb-ask');
    private readonly askInput = h('input');
    private readonly askScope = h('span', 'bb-ask-scope');
    private readonly askRail = h('div', 'bb-rail is-preview');
    private readonly inbox: HTMLButtonElement;
    private ask: Scope | null = null;
    private hoverPos: number | null = null;
    private frame = 0;
    private readonly observer: ResizeObserver;
    private readonly ticker: ReturnType<typeof setInterval>;

    constructor(private surface: NotesSurface, private readonly notes: () => Note[], private readonly actions: NoteActions) {
        this.container = document.getElementById('editor') as HTMLElement;
        this.layer.setAttribute('aria-hidden', 'false');
        this.container.append(this.layer);

        this.ghost = button('bb-ghost', '※', l10n.t('Ask about this block (⌘B ⌘B)'), () => {
            const scope = this.hoverPos === null ? null : this.actions.scopeForBlock(this.hoverPos);
            if (scope) { this.openAsk(scope); }
        });
        this.ghost.addEventListener('mousedown', event => event.preventDefault());
        this.ghost.hidden = true;

        this.askInput.autocomplete = 'off';
        this.askInput.setAttribute('aria-label', l10n.t('Ask about this block'));
        this.askBox.append(h('span', 'bb-ask-glyph', '※'), this.askInput, this.askScope, h('span', 'bb-ask-key', '↵'));
        this.askBox.hidden = true;
        this.askRail.hidden = true;
        this.askInput.addEventListener('keydown', event => {
            if (composing(event)) { return; }
            if (event.key === 'Enter' && this.askInput.value.trim()) { event.preventDefault(); this.send(this.askInput.value.trim()); }
            if (event.key === 'Escape') { event.preventDefault(); this.closeAsk(true); }
        });
        this.askBox.addEventListener('focusout', event => {
            if (!this.askBox.contains(event.relatedTarget as globalThis.Node | null)) { this.closeAsk(false); }
        });
        this.layer.append(this.askRail, this.ghost, this.askBox);

        this.inbox = button('bb-inbox', '', '', () => {
            const next = [...this.notes()].sort((a, b) => a.from - b.from).find(note => note.unread);
            if (!next) { return; }
            this.actions.toggle(next, true);
            next.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        this.inbox.hidden = true;
        document.body.append(this.inbox);

        this.container.addEventListener('mousemove', this.onMouseMove);
        this.container.addEventListener('mouseleave', this.onMouseLeave);
        this.observer = new ResizeObserver(() => this.requestMeasure());
        // The frontmatter panel is part of the content, so its height is covered too.
        this.observer.observe(surface.dom);
        this.ticker = setInterval(() => this.tick(), 1000);
    }

    update(surface: NotesSurface): void { this.surface = surface; }

    destroy(): void {
        cancelAnimationFrame(this.frame);
        clearInterval(this.ticker);
        this.observer.disconnect();
        this.container.removeEventListener('mousemove', this.onMouseMove);
        this.container.removeEventListener('mouseleave', this.onMouseLeave);
        this.layer.remove();
        this.inbox.remove();
    }

    // ---- The note's own line / card ----

    render(note: Note): void {
        const root = note.el;
        root.className = `bb-note ${note.open ? 'is-open' : 'is-strip'} is-${note.status}${note.unread ? ' is-unread' : ''}`;
        const body = note.open ? h('div', 'bb-note-card') : this.strip(note);
        if (note.open) { body.append(...this.card(note)); }
        root.replaceChildren(body);
        this.refreshInbox();
        this.requestMeasure();
    }

    /**
     * Collapsed: one tinted band — state, the question, the first words of the
     * answer, and who answered in how long. ● unread, ○ read, ± changes to look at.
     * (The band is itself a button, so retry lives in the expanded card.)
     */
    private strip(note: Note): HTMLElement {
        const line = button('bb-note-strip', '', '', () => this.actions.toggle(note, true));
        const glyph = h('span', 'bb-note-g');
        const mine = note.thread.filter(turn => turn.role === 'me');
        const answer = [...note.thread].reverse().find((turn): turn is AiTurn => turn.role === 'ai');
        const tail = h('span', 'bb-note-tail');
        let meta = '';
        if (note.status === 'working') {
            glyph.append(h('i', 'bb-ring'));
            tail.append(h('span', 'bb-note-step', note.step));
        } else if (note.status === 'error') {
            glyph.textContent = '!';
            tail.textContent = note.error;
        } else {
            const pending = note.summary?.pending.length ?? 0;
            glyph.textContent = pending ? '±' : note.unread ? '●' : '○';
            if (pending > 1 && note.summary) { tail.append(tallyChips(note.summary.kinds), ' '); }
            tail.append(plain(answer?.markdown ?? '').slice(0, 140));
            if (answer) { meta = `${answer.agent} · ${answer.seconds}s`; }
        }
        line.append(glyph, h('span', 'bb-note-ask', mine[mine.length - 1]?.text ?? ''), tail);
        // While working, the elapsed time sits where the agent and its time will be.
        if (note.status === 'working') { line.append(h('span', 'bb-note-meta bb-note-t')); }
        else if (meta) { line.append(h('span', 'bb-note-meta', meta)); }
        return line;
    }

    /** Expanded: the whole thread, the proposal's decisions, and a place to follow up. */
    private card(note: Note): HTMLElement[] {
        const parts: HTMLElement[] = [button('bb-note-x', '⌃', l10n.t('Collapse'), () => this.actions.toggle(note, false))];
        const proposalTurn = lastProposalTurn(note);
        note.thread.forEach((turn, index) => {
            if (turn.role === 'me') {
                const question = h('div', 'bb-note-q');
                question.append(h('span', 'bb-note-g', '※'), h('span', '', turn.text));
                if (index === 0 && note.tag) { question.append(h('span', 'bb-note-scope', note.tag)); }
                parts.push(question);
                if (index === 0 && note.quote) { parts.push(h('div', 'bb-note-quote', l10n.t('“{0}”', note.quote))); }
                return;
            }
            const answer = h('div', 'bb-note-a');
            answer.append(this.actions.renderMarkdown(turn.markdown));
            parts.push(answer);
            if (turn === proposalTurn) { parts.push(this.decisions(note)); }
        });
        if (note.status === 'working') {
            const working = h('div', 'bb-note-w');
            working.append(h('i', 'bb-ring'), h('span', 'bb-note-step', note.step), h('span', 'bb-note-t'),
                ops(button('bb-btn', '×', l10n.t('Cancel this question'), () => this.actions.cancel(note))));
            parts.push(working);
            return parts;
        }
        if (note.status === 'error') {
            const failed = h('div', 'bb-note-e');
            const reason = h('span', '', note.error);
            if (note.error === '…') { reason.title = l10n.t('The editor closed before this was answered'); }
            failed.append(reason, ops(button('bb-btn', '↻', l10n.t('Retry'), () => this.actions.retry(note))));
            parts.push(failed);
        }
        const footer = h('div', 'bb-note-f');
        const followUp = h('input', 'bb-note-fu');
        followUp.autocomplete = 'off';
        followUp.setAttribute('aria-label', l10n.t('Follow up'));
        followUp.addEventListener('keydown', event => {
            if (composing(event)) { return; }
            if (event.key === 'Enter' && followUp.value.trim()) { event.preventDefault(); this.actions.followUp(note, followUp.value.trim()); }
            if (event.key === 'Escape') { event.preventDefault(); this.actions.toggle(note, false); this.actions.focusEditor(); }
        });
        const answered = [...note.thread].reverse().find((turn): turn is AiTurn => turn.role === 'ai');
        // A new line that starts with ※, like every question above it: type here to follow up.
        footer.append(h('span', 'bb-note-g', '※'), followUp);
        if (answered) { footer.append(h('span', 'bb-note-meta', `${answered.agent} · ${answered.seconds}s`)); }
        const resolve = button('bb-btn bb-note-resolve', '', l10n.t('Resolve this note and remove it from the margin'), () => this.actions.resolve(note));
        resolve.setAttribute('aria-label', l10n.t('Resolve this note'));
        resolve.append(trashIcon());
        footer.append(resolve);
        parts.push(footer);
        return parts;
    }

    /** The proposal's status line, in the gutter's own signs: what is left (~2 +1 −1 ⤷1), then ✓ / × for all of it. */
    private decisions(note: Note): HTMLElement {
        const bar = h('div', 'bb-note-p');
        const summary = note.summary;
        if (!summary) { return bar; }
        const multi = summary.total > 1;
        if (summary.pending.length) {
            const stat = summary.chars && !multi
                ? chips([['−', summary.chars.del, 'del'], ['+', summary.chars.ins, 'add']])
                : tallyChips(summary.kinds);
            stat.title = summary.chars && !multi
                ? l10n.t('Characters removed and added')
                : l10n.t('Pending changes: ~ rewritten · + added · − removed · ⤷ moved');
            bar.append(stat);
        }
        if (summary.accepted || summary.rejected) {
            const done = h('span', 'bb-note-stat', [summary.accepted ? `✓${summary.accepted}` : '', summary.rejected ? `×${summary.rejected}` : ''].filter(Boolean).join(' '));
            done.title = l10n.t('Accepted / rejected changes');
            bar.append(done);
        }
        if (summary.stale) {
            const stale = h('span', 'bb-note-stat bb-note-stale', `≠${summary.stale}`);
            stale.title = l10n.t('You edited these blocks after asking; these changes no longer apply');
            bar.append(stale);
        }
        if (summary.pending.length && !note.lens) {
            bar.append(ops(button('bb-btn', '±', l10n.t('Mark the changes on the text'), () => this.actions.showChanges(note))));
        } else if (summary.pending.length) {
            bar.append(ops(
                button('bb-btn is-yes', '✓', multi ? l10n.t('Accept all (⌘Z to undo)') : l10n.t('Accept (⌘Z to undo)'), () => this.actions.accept(note)),
                button('bb-btn', '×', multi ? l10n.t('Reject all') : l10n.t('Reject'), () => this.actions.reject(note)),
            ));
        } else if (summary.rejected) {
            bar.append(ops(button('bb-btn', '↺', l10n.t('Show rejected changes again'), () => this.actions.review(note))));
        }
        return bar;
    }

    remove(note: Note): void {
        this.rails.get(note.id)?.remove();
        this.rails.delete(note.id);
        this.refreshInbox();
        this.requestMeasure();
    }

    updateStep(note: Note): void {
        const step = note.el.querySelector('.bb-note-step');
        if (step) { step.textContent = note.step; }
    }

    private tick(): void {
        for (const note of this.notes()) {
            const elapsed = note.status === 'working' ? note.el.querySelector('.bb-note-t') : null;
            if (elapsed) { elapsed.textContent = `${Math.max(0, Math.round((Date.now() - note.startedAt) / 1000))}s`; }
        }
    }

    refreshInbox(): void {
        const unread = this.notes().filter(note => note.unread).length;
        const working = this.notes().filter(note => note.status === 'working').length;
        this.inbox.hidden = !(unread || working);
        this.inbox.replaceChildren();
        if (working) { this.inbox.append(h('i', 'bb-ring')); }
        if (unread) { this.inbox.append(h('i', 'bb-dot'), h('b', '', String(unread))); }
        this.inbox.title = [
            working === 1 ? l10n.t('1 note in progress') : working ? l10n.t('{0} notes in progress', working) : '',
            unread ? l10n.t('{0} unread, click to go to the next', unread) : '',
        ].filter(Boolean).join(' · ');
    }

    // ---- Asking ----

    openAsk(scope: Scope): void {
        this.ask = scope;
        this.askScope.textContent = scope.chip;
        this.askInput.value = '';
        this.askBox.hidden = false;
        this.ghost.hidden = true;
        this.measure();
        this.askInput.focus({ preventScroll: true });
    }

    closeAsk(refocus: boolean): void {
        if (!this.ask) { return; }
        this.ask = null;
        this.askBox.hidden = true;
        this.askRail.hidden = true;
        // The editor's selection was never touched, so the caret is where the writer left it.
        if (refocus) { this.actions.focusEditor(); }
    }

    private send(question: string): void {
        const scope = this.ask;
        if (!scope) { return; }
        this.closeAsk(true);
        this.actions.ask(scope, question);
    }

    // ---- Left / right gutters ----

    setMarks(marks: Mark[]): void {
        this.marks = marks;
        this.requestMeasure();
    }

    requestMeasure(): void {
        if (this.frame) { return; }
        this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
    }

    private readonly onMouseMove = (event: MouseEvent): void => {
        if (this.ask) { return; }
        const pos = this.blockAt(event.clientY);
        if (pos !== this.hoverPos) { this.hoverPos = pos; this.requestMeasure(); }
    };

    private readonly onMouseLeave = (): void => {
        if (this.hoverPos !== null) { this.hoverPos = null; this.requestMeasure(); }
    };

    private blockAt(y: number): number | null { return this.surface.blockAt(y); }

    private measure(): void {
        const base = this.container.getBoundingClientRect().top - this.container.scrollTop;
        type Box = { top: number; bottom: number; line: number };
        const box = (target: Element): Box => {
            const rect = target.getBoundingClientRect();
            const inner = target.classList.contains('bb-preview') && target.firstElementChild ? target.firstElementChild : target;
            return { top: rect.top - base, bottom: rect.bottom - base, line: lineHeightOf(inner) };
        };
        const block = (pos: number): Box | null => {
            const found = this.surface.blockBox(pos);
            return found && { top: found.top - base, bottom: found.bottom - base, line: found.line };
        };
        const place = (target: HTMLElement, top: number, bottom: number): void => {
            target.style.top = `${top}px`;
            target.style.height = `${Math.max(0, bottom - top)}px`;
        };

        // Rails: one per note, beside the blocks it is about and its line / card.
        const live = new Set<string>();
        for (const note of this.notes()) {
            live.add(note.id);
            let rail = this.rails.get(note.id);
            if (!rail) {
                rail = button('bb-rail', '', '', () => this.actions.toggle(note));
                this.rails.set(note.id, rail);
                this.layer.append(rail);
            }
            const first = block(note.from), last = block(note.last);
            // The visible band or card, without the spacing below it.
            const card = note.el.isConnected ? box(note.el.firstElementChild ?? note.el) : null;
            rail.hidden = !first || !last;
            if (!first || !last) { continue; }
            // With the changes shown, each changed block carries its own coloured bar; the rail keeps to the card.
            const lens = lensOn(note) && card;
            place(rail, lens ? card.top - 2 : first.top, lens ? card.bottom + 2 : Math.max(last.bottom, card ? card.bottom + 2 : 0));
            rail.className = `bb-rail is-${note.status}${note.unread ? ' is-unread' : ''}${note.open ? ' is-open' : ''}`;
            const question = note.thread.find(turn => turn.role === 'me');
            const asked = question?.role === 'me' ? question.text : '';
            rail.title = note.status === 'working' ? l10n.t('{0} (in progress)', asked).trim()
                : note.unread ? l10n.t('{0} (unread)', asked).trim()
                : asked;
        }
        for (const [id, rail] of this.rails) { if (!live.has(id)) { rail.remove(); this.rails.delete(id); } }

        // Signs on the left, accept / reject on the right, for every changed block on show.
        const used = new Set<string>();
        for (const mark of this.marks) {
            const rect = mark.el ? (mark.el.isConnected ? box(mark.el) : null) : mark.pos === undefined ? null : block(mark.pos);
            if (!rect) { continue; }
            used.add(mark.key);
            let els = this.markEls.get(mark.key);
            if (!els) {
                els = {};
                if (mark.sign) {
                    els.sign = h('span', `bb-sign is-${mark.tone}`, mark.sign);
                    els.sign.title = signTitle(mark.sign);
                    els.bar = h('span', `bb-bar is-${mark.tone}`);
                    this.layer.append(els.bar, els.sign);
                }
                if (mark.controls && mark.item !== undefined) {
                    const item = mark.item;
                    els.controls = h('span', 'bb-ops');
                    els.controls.append(
                        button('bb-btn is-yes', '✓', l10n.t('Accept this change'), () => this.actions.accept(mark.note, item)),
                        button('bb-btn', '×', l10n.t('Reject this change'), () => this.actions.reject(mark.note, item)),
                    );
                    this.layer.append(els.controls);
                }
                this.markEls.set(mark.key, els);
            }
            const line = rect.top + (rect.line - 18) / 2;
            if (els.sign) { els.sign.style.top = `${line}px`; }
            if (els.bar) { place(els.bar, rect.top + 4, Math.max(rect.top + 10, rect.bottom - 4)); }
            if (els.controls) { els.controls.style.top = `${line}px`; }
        }
        for (const [key, els] of this.markEls) {
            if (used.has(key)) { continue; }
            els.sign?.remove(); els.bar?.remove(); els.controls?.remove();
            this.markEls.delete(key);
        }

        // While asking: a dashed rail shows which blocks the question covers.
        this.askRail.hidden = !this.ask;
        if (this.ask) {
            const first = block(this.ask.from), last = block(this.ask.last);
            if (first && last) {
                place(this.askRail, first.top, last.bottom);
                const head = this.surface.selectionEmpty && this.ask.kind === 'block'
                    ? this.caretBottom() ?? last.bottom : (this.ask.kind === 'section' ? first : last).bottom;
                this.askBox.style.top = `${head + 8}px`;
            } else { this.closeAsk(false); }
        }

        // Hovering a block that has no note yet: a faint ※ to ask by mouse.
        const hovered = this.hoverPos !== null && !this.ask ? block(this.hoverPos) : null;
        const taken = hovered !== null && this.notes().some(note => this.hoverPos! >= note.from && this.hoverPos! <= note.last);
        this.ghost.hidden = !hovered || taken || !this.surface.editable;
        if (hovered && !taken) { this.ghost.style.top = `${hovered.top + (hovered.line - 18) / 2}px`; }
    }

    private caretBottom(): number | null {
        try {
            const base = this.container.getBoundingClientRect().top - this.container.scrollTop;
            const bottom = this.surface.caretBottom();
            return bottom === null ? null : bottom - base;
        } catch { return null; }
    }
}

/** A wastebasket drawn in the text colour (no emoji: it would come in colour and out of style). */
function trashIcon(): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [name, value] of Object.entries({
        viewBox: '0 0 16 16', width: '14', height: '14', fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    })) { svg.setAttribute(name, value); }
    for (const d of ['M2.5 4h11', 'M6 4V2.5h4V4', 'M3.8 4l.7 9.2c.05.7.6 1.3 1.3 1.3h4.4c.7 0 1.25-.6 1.3-1.3l.7-9.2', 'M6.6 6.8v4.9M9.4 6.8v4.9']) {
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

/** Buttons gathered at the right end of a row. */
function ops(...buttons: HTMLElement[]): HTMLElement {
    const group = h('span', 'bb-note-ops');
    group.append(...buttons);
    return group;
}

/** Counts as small chips, each in the colour of its sign in the gutter. */
function chips(items: Array<[string, number, 'mod' | 'add' | 'del']>): HTMLElement {
    const group = h('span', 'bb-chips');
    for (const [sign, count, tone] of items) { if (count) { group.append(h('span', `bb-chip is-${tone}`, `${sign}${count}`)); } }
    return group;
}

/** Pending changes counted in the same signs that mark them in the gutter: ~2 +1 −1 ⤷1. */
function tallyChips(kinds: { mod: number; add: number; del: number; move: number }): HTMLElement {
    return chips([['~', kinds.mod, 'mod'], ['+', kinds.add, 'add'], ['−', kinds.del, 'del'], ['⤷', kinds.move, 'mod']]);
}

