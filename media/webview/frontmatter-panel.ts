import yaml from 'js-yaml';

// Frontmatter is shown as the document's own head: real keys, values edited in
// place, framed by the file's real fences. Edits rewrite only the edited key's
// lines so every other byte of the frontmatter survives untouched.

type FieldKind = 'text' | 'longtext' | 'list' | 'bool' | 'complex';

interface Fenced {
    fence: string;   // "---" or "+++"
    nl: string;      // line ending used by the file
    body: string;    // text between the fences, without the surrounding newlines
    tail: string;    // newline after the closing fence ("" at end of file)
}

interface KeyBlock { key: string; start: number; end: number }

/** Value shape implied by well-known keys, regardless of what is stored today. */
const KNOWN_KINDS: Record<string, FieldKind> = {
    tags: 'list', categories: 'list', keywords: 'list',
    draft: 'bool',
    description: 'longtext', summary: 'longtext', excerpt: 'longtext',
};
const HASH_KEYS = new Set(['tags', 'categories', 'keywords']);
const SUGGESTED_KEYS = ['title', 'date', 'tags', 'categories', 'description', 'draft', 'slug', 'author', 'lastmod'];

// "---\n<body>\n---\n" (or +++); the body may be empty.
const FENCED_RE = /^(---|\+\+\+)(\r?\n)([\s\S]*?)(?:\r?\n)?\1(\r?\n?)$/;
// A top-level key at column 0: plain, single- or double-quoted.
const KEY_LINE_RE = /^(?:"([^"]*)"|'([^']*)'|([^\s#\-?:][^:]*?))\s*:(?:\s|$)/;

// ---- Module state ----

let raw = '';
let fenced: Fenced | null = null;
// Parsed mapping; null when the body is not a YAML mapping (syntax error, TOML).
let data: Record<string, unknown> | null = null;
let sourceMode = false;
let changeListener: (() => void) | null = null;

// ---- Parse / serialize ----

function splitFenced(text: string): Fenced | null {
    const m = text.match(FENCED_RE);
    return m ? { fence: m[1], nl: m[2], body: m[3], tail: m[4] } : null;
}

function joinFenced(f: Fenced): string {
    return f.fence + f.nl + f.body + (f.body ? f.nl : '') + f.fence + f.tail;
}

function parseBody(f: Fenced | null): Record<string, unknown> | null {
    if (!f || f.fence !== '---') { return null; }
    try {
        // CORE_SCHEMA keeps dates as the strings written in the file.
        const obj = yaml.load(f.body, { schema: yaml.CORE_SCHEMA });
        if (obj == null) { return {}; }
        return typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function keyBlocks(lines: string[]): KeyBlock[] {
    const blocks: KeyBlock[] = [];
    lines.forEach((line, i) => {
        const m = KEY_LINE_RE.exec(line);
        if (m) { blocks.push({ key: m[1] ?? m[2] ?? m[3], start: i, end: i }); }
    });
    blocks.forEach((block, i) => {
        let end = (blocks[i + 1]?.start ?? lines.length) - 1;
        // Blank lines and column-0 comments between keys stay where they are.
        while (end > block.start && (lines[end].trim() === '' || lines[end].startsWith('#'))) { end--; }
        block.end = end;
    });
    return blocks;
}

function dumpField(key: string, value: unknown, original: string): string {
    const afterColon = original.slice(original.indexOf(':') + 1).trimStart();
    // Keep the author's quoting for single-line strings.
    if (typeof value === 'string' && !value.includes('\n') && /^["']/.test(afterColon)) {
        const quoted = afterColon.startsWith('"') ? JSON.stringify(value) : `'${value.replace(/'/g, "''")}'`;
        return original.slice(0, original.indexOf(':') + 1) + ' ' + quoted;
    }
    const text = yaml.dump({ [key]: value }, {
        schema: yaml.CORE_SCHEMA,
        lineWidth: -1,
        noRefs: true,
        flowLevel: /^[[{]/.test(afterColon) ? 1 : -1,
        noArrayIndent: /\n-/.test(original),
    }).replace(/\n$/, '');
    return value === null ? text.replace(/: null$/, ':') : text;
}

/** Replace (or append) one key's lines, leaving every other line byte-identical. */
function writeField(key: string, value: unknown): void {
    if (!fenced || !data) { return; }
    data[key] = value;
    const lines = fenced.body === '' ? [] : fenced.body.split(fenced.nl);
    const block = keyBlocks(lines).find(b => b.key === key);
    const original = block ? lines.slice(block.start, block.end + 1).join('\n') : '';
    const next = dumpField(key, value, original).split('\n');
    if (block) { lines.splice(block.start, block.end - block.start + 1, ...next); }
    else { lines.push(...next); }
    fenced = { ...fenced, body: lines.join(fenced.nl) };
    raw = joinFenced(fenced);
    syncTextarea();
    renderSummary();
    changeListener?.();
}

// ---- Field kinds ----

function isScalar(v: unknown): boolean {
    return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function kindOf(key: string, value: unknown): FieldKind {
    const known = KNOWN_KINDS[key];
    if (known === 'list' && value == null) { return 'list'; }
    if (known === 'bool' && value == null) { return 'bool'; }
    if (typeof value === 'boolean') { return 'bool'; }
    if (Array.isArray(value)) { return value.every(isScalar) ? 'list' : 'complex'; }
    if (value !== null && typeof value === 'object') { return 'complex'; }
    if (known === 'longtext' || (typeof value === 'string' && (value.includes('\n') || value.length > 60))) { return 'longtext'; }
    return 'text';
}

function defaultValue(key: string): unknown {
    const kind = KNOWN_KINDS[key];
    if (kind === 'list') { return []; }
    if (kind === 'bool') { return false; }
    if (key === 'date' || key === 'lastmod') {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return null; // written as a bare "key:" until a value is typed
}

/** Keep the stored type when the text still fits it (numbers stay numbers, empty stays null). */
function coerceText(text: string, previous: unknown): unknown {
    if (typeof previous === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) { return Number(text); }
    if (previous === null && text === '') { return null; }
    return text;
}

function scalarText(v: unknown): string {
    return v == null ? '' : String(v);
}

// ---- Controls ----

function autoGrow(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

function textControl(key: string, value: unknown, multiline: boolean): HTMLElement {
    const input = multiline ? document.createElement('textarea') : document.createElement('input');
    input.className = 'fm-input';
    input.value = scalarText(value);
    input.spellcheck = false;
    input.setAttribute('aria-label', key);
    let previous = value;
    input.addEventListener('input', () => {
        if (input instanceof HTMLTextAreaElement) { autoGrow(input); }
        previous = coerceText(input.value, previous);
        writeField(key, previous);
    });
    if (input instanceof HTMLTextAreaElement) {
        input.rows = 1;
        requestAnimationFrame(() => autoGrow(input));
    }
    return input;
}

function boolControl(key: string, value: unknown): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fm-bool';
    let on = value === true;
    const paint = (): void => {
        button.textContent = String(on);
        button.setAttribute('aria-pressed', String(on));
        button.setAttribute('aria-label', `${key}: ${on}`);
    };
    paint();
    button.addEventListener('click', () => { on = !on; paint(); writeField(key, on); });
    return button;
}

function listControl(key: string, value: unknown): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'fm-list';
    let items: unknown[] = Array.isArray(value) ? [...value] : [];
    const prefix = HASH_KEYS.has(key) ? '#' : '';

    const render = (focus: boolean): void => {
        wrap.replaceChildren();
        items.forEach((item, index) => {
            const chip = document.createElement('span');
            chip.className = 'fm-item';
            chip.textContent = prefix + scalarText(item);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'fm-item-remove';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `移除 ${scalarText(item)}`);
            remove.addEventListener('click', () => {
                items = items.filter((_, i) => i !== index);
                writeField(key, items);
                render(true);
            });
            chip.append(remove);
            wrap.append(chip);
        });
        const input = document.createElement('input');
        input.className = 'fm-list-input';
        input.placeholder = '+';
        input.spellcheck = false;
        input.setAttribute('aria-label', `添加到 ${key}`);
        input.addEventListener('keydown', (e) => {
            if (e.isComposing) { return; }
            if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
                e.preventDefault();
                const v = input.value.trim();
                if (v && !items.map(scalarText).includes(v)) {
                    items = [...items, v];
                    writeField(key, items);
                    render(true);
                }
            } else if (e.key === 'Backspace' && input.value === '' && items.length > 0) {
                items = items.slice(0, -1);
                writeField(key, items);
                render(true);
            }
        });
        wrap.append(input);
        if (focus) { input.focus(); }
    };
    render(false);
    return wrap;
}

function complexControl(value: unknown): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fm-complex';
    const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
    button.textContent = Array.isArray(value) ? `[ ${count} 项 ]` : `{ ${count} 项 }`;
    button.title = '嵌套值，在源码中编辑';
    button.addEventListener('click', () => setSourceMode(true));
    return button;
}

function control(key: string, value: unknown): HTMLElement {
    switch (kindOf(key, value)) {
        case 'bool': return boolControl(key, value);
        case 'list': return listControl(key, value);
        case 'complex': return complexControl(value);
        case 'longtext': return textControl(key, value, true);
        default: return textControl(key, value, false);
    }
}

// ---- Rendering ----

function el(id: string): HTMLElement | null { return document.getElementById(id); }

function renderProps(): void {
    const props = el('frontmatter-props');
    if (!props) { return; }
    props.replaceChildren();

    if (!data) {
        const error = document.createElement('div');
        error.className = 'fm-error';
        error.textContent = fenced?.fence === '+++' ? 'TOML 属性只能在源码中编辑。' : 'YAML 有语法错误，属性暂时无法显示。';
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.textContent = '打开源码';
        fix.addEventListener('click', () => setSourceMode(true));
        error.append(' ', fix);
        props.append(error);
        return;
    }

    for (const [key, value] of Object.entries(data)) {
        const dt = document.createElement('dt');
        dt.textContent = key;
        dt.title = key;
        const dd = document.createElement('dd');
        dd.append(control(key, value));
        props.append(dt, dd);
    }
    props.append(addFieldRow());
}

function addFieldRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'fm-add';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fm-add-button';
    button.textContent = '+ 添加属性';
    button.addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'fm-add-input';
        input.placeholder = '属性名';
        input.spellcheck = false;
        input.setAttribute('list', 'frontmatter-key-suggestions');
        const suggestions = document.createElement('datalist');
        suggestions.id = 'frontmatter-key-suggestions';
        for (const key of SUGGESTED_KEYS.filter(k => !(k in (data ?? {})))) {
            const option = document.createElement('option');
            option.value = key;
            suggestions.append(option);
        }
        let done = false;
        const close = (): void => {
            if (done) { return; }
            done = true;
            row.replaceWith(addFieldRow());
        };
        input.addEventListener('keydown', (e) => {
            if (e.isComposing) { return; }
            if (e.key === 'Escape') { close(); return; }
            if (e.key !== 'Enter') { return; }
            e.preventDefault();
            const key = input.value.trim();
            if (!key || key.includes(':') || !data) { return; }
            if (!(key in data)) { writeField(key, defaultValue(key)); }
            done = true; // re-rendering detaches this input and fires blur
            renderProps();
            const target = [...document.querySelectorAll('#frontmatter-props dt')].find(dt => dt.textContent === key);
            target?.nextElementSibling?.querySelector<HTMLElement>('input, textarea, button')?.focus();
        });
        input.addEventListener('blur', close);
        row.replaceChildren(input, suggestions);
        input.focus();
    });
    row.append(button);
    return row;
}

function renderSummary(): void {
    const summary = el('frontmatter-summary');
    if (!summary) { return; }
    summary.replaceChildren();
    const add = (text: string, className?: string): void => {
        const span = document.createElement('span');
        span.textContent = text;
        if (className) { span.className = className; }
        summary.append(span);
    };
    if (!data) {
        add(fenced?.fence === '+++' ? 'TOML' : 'YAML 有语法错误', 'fm-dim');
        return;
    }
    if (data.draft === true) { add('draft', 'fm-flag'); }
    if (typeof data.date === 'string' || typeof data.date === 'number') { add(String(data.date)); }
    const tags = Array.isArray(data.tags) ? data.tags.filter(isScalar).map(scalarText) : [];
    tags.slice(0, 4).forEach(tag => add(`#${tag}`, 'fm-tag'));
    if (tags.length > 4) { add(`+${tags.length - 4}`, 'fm-dim'); }
    if (!summary.childElementCount) {
        add(Object.keys(data).join('  ') || '空', 'fm-dim');
    }
}

function syncTextarea(): void {
    const textarea = el('frontmatter-editor') as HTMLTextAreaElement | null;
    if (!textarea) { return; }
    textarea.value = fenced ? fenced.body : raw;
    if (sourceMode) { autoGrow(textarea); }
}

function setCollapsed(collapsed: boolean): void {
    const panel = el('frontmatter-panel');
    panel?.classList.toggle('fm-collapsed', collapsed);
    el('frontmatter-toggle')?.setAttribute('aria-expanded', String(!collapsed));
}

function setSourceMode(on: boolean): void {
    sourceMode = on;
    el('frontmatter-panel')?.classList.toggle('fm-source', on);
    el('frontmatter-source')?.setAttribute('aria-pressed', String(on));
    setCollapsed(false);
    if (on) {
        const textarea = el('frontmatter-editor') as HTMLTextAreaElement | null;
        if (textarea) { syncTextarea(); textarea.focus(); }
    } else {
        renderProps();
    }
}

// ---- Public API ----

export function initFrontmatterPanel(): void {
    const toggle = el('frontmatter-toggle');
    const source = el('frontmatter-source');
    const textarea = el('frontmatter-editor') as HTMLTextAreaElement | null;
    if (!toggle || !source || !textarea) { return; }

    toggle.addEventListener('click', () => {
        const collapsed = el('frontmatter-panel')?.classList.contains('fm-collapsed') ?? true;
        if (collapsed && !data) { setSourceMode(true); return; }
        setCollapsed(!collapsed);
    });
    source.addEventListener('click', () => setSourceMode(!sourceMode));

    textarea.addEventListener('input', () => {
        autoGrow(textarea);
        if (fenced) {
            const body = textarea.value.replace(/\r?\n/g, fenced.nl);
            fenced = { ...fenced, body };
            // Clearing the source removes the frontmatter block entirely.
            raw = body.trim() === '' ? '' : joinFenced(fenced);
        } else {
            raw = textarea.value;
        }
        data = parseBody(fenced);
        renderSummary();
        changeListener?.();
    });
}

export function updateFrontmatterPanel(frontmatter: string): void {
    const panel = el('frontmatter-panel');
    if (!panel) { return; }
    raw = frontmatter || '';
    fenced = splitFenced(raw);
    data = parseBody(fenced);
    panel.hidden = !raw;
    // Collapsed on every load: frontmatter is reached for on purpose.
    sourceMode = false;
    panel.classList.remove('fm-source');
    el('frontmatter-source')?.setAttribute('aria-pressed', 'false');
    const fence = el('frontmatter-fence');
    if (fence) { fence.textContent = fenced?.fence ?? '---'; }
    panel.querySelectorAll('.fm-close').forEach(close => { close.textContent = fenced?.fence ?? '---'; });
    setCollapsed(true);
    syncTextarea();
    renderSummary();
    renderProps();
}

export function onFrontmatterChange(listener: () => void): void {
    changeListener = listener;
}

export function getFrontmatter(): string { return raw; }
