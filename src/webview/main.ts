// Webview side of the visual editor: renders the document, lets the user
// click a block to edit its LaTeX source with a live preview, and sends
// edits back to the extension host.

import { Ctx, HostResources, buildContext } from '../latex/context';
import { renderDocument, renderRange, stripTags } from '../latex/render';
import { splitAuthors } from '../latex/bib';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;
declare const pdfjsLib: any;

interface Change {
  offset: number;
  removed: number;
  inserted: number;
}

interface Editing {
  start: number;
  /** Length of the region in `text` (the host's view of the document). */
  hostLen: number;
  /** Region bounds when the editor was opened, used to remap stale DOM offsets. */
  origStart: number;
  origEnd: number;
  container: HTMLElement;
  ta: HTMLTextAreaElement;
  preview: HTMLElement;
  sendTimer?: number;
  previewTimer?: number;
  parentRange?: { start: number; end: number };
}

const vscode = acquireVsCodeApi();
const state = vscode.getState() ?? {};

/** The document as the host has it (plus edits we have sent). */
let text = '';
let host: HostResources = { images: {}, bib: '' };
let ctx: Ctx | undefined;
let editing: Editing | null = null;
let selected: { start: number; end: number } | null = null;
let pendingOpenAt: number | null = null;
let renderTimer: number | undefined;
let firstRender = true;

const page = document.createElement('div');
page.id = 'page';
const root = document.createElement('div');
root.id = 'doc';
page.appendChild(root);
const toolbar = buildToolbar();
document.body.append(toolbar, page);
applyPaperMode(state.paper ?? document.body.dataset.paper === 'true');

window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: `${e.message} @ ${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => vscode.postMessage({ type: 'error', message: String(e.reason) }));

// ---------------------------------------------------------------------------
// Messages from the extension host

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'update':
      onUpdate(msg.text, msg.host, msg.external, msg.changes ?? []);
      break;
    case 'cursor':
      if (!editing) highlightOffset(msg.offset);
      break;
    case 'openAt':
      pendingOpenAt = msg.offset;
      scheduleRender(0);
      break;
    case 'insertTemplate':
      insertBlock(msg.text, msg.at);
      break;
    case '__test':
      runTest(msg);
      break;
  }
});

function onUpdate(newText: string, newHost: HostResources, external: boolean, changes: Change[]) {
  const hostChanged = JSON.stringify(newHost) !== JSON.stringify(host);
  host = newHost;
  if (editing) {
    if (!external) {
      if (hostChanged) updatePreview();
      return; // echo of our own edit; local text is already ahead
    }
    // Someone else edited the document: shift our region, or give up if they touched it.
    let shift = 0;
    const regionEnd = editing.start + editing.hostLen;
    let overlap = false;
    for (const c of changes) {
      if (c.offset + c.removed <= editing.start) shift += c.inserted - c.removed;
      else if (c.offset >= regionEnd) continue;
      else overlap = true;
    }
    text = newText;
    if (overlap) {
      closeEditor(false);
      return;
    }
    editing.start += shift;
    editing.origStart += shift;
    editing.origEnd += shift;
    updatePreview();
    return;
  }
  if (newText === text && !hostChanged && !firstRender) return;
  text = newText;
  scheduleRender(firstRender ? 0 : 60);
}

// ---------------------------------------------------------------------------
// Rendering

function scheduleRender(delay: number) {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderAll, delay);
}

function renderAll() {
  if (editing) return;
  const t0 = performance.now();
  ctx = buildContext(text, host);
  const scroller = document.scrollingElement ?? document.documentElement;
  const y = firstRender && state.scrollY ? state.scrollY : scroller.scrollTop;
  root.innerHTML = renderDocument(ctx) + `<div class="add-block" title="Add a paragraph at the end">+ Add paragraph</div>`;
  postRender(root);
  scroller.scrollTop = y;
  firstRender = false;
  if (selected) markSelected(selected.start);
  if (pendingOpenAt !== null) {
    const el = elementForOffset(pendingOpenAt, true);
    pendingOpenAt = null;
    if (el) openEditor(el);
  }
  vscode.postMessage({ type: 'rendered', stats: collectStats(performance.now() - t0) });
}

function collectStats(ms: number) {
  const kinds: Record<string, number> = {};
  root.querySelectorAll<HTMLElement>('.blk').forEach((el) => {
    const k = [...el.classList].find((c) => c.startsWith('blk-'))!.slice(4);
    kinds[k] = (kinds[k] ?? 0) + 1;
  });
  return {
    ms: Math.round(ms),
    kinds,
    katexErrors: root.querySelectorAll('.katex-error').length,
    renderErrors: root.querySelectorAll('.render-error').length,
    undefinedRefs: root.querySelectorAll('.ref.undef').length,
    undefinedCites: root.querySelectorAll('.cite.undef').length,
    images: root.querySelectorAll('img.graphic').length,
    textLength: text.length,
  };
}

function postRender(el: HTMLElement) {
  el.querySelectorAll<HTMLImageElement>('img[data-pdf]').forEach((img) => loadPdfInto(img));
}

const pdfCache = new Map<string, Promise<string>>();
let pdfReady: Promise<void> | undefined;

function setupPdf(): Promise<void> {
  if (pdfReady) return pdfReady;
  pdfReady = (async () => {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js not loaded');
    const workerUri = document.body.dataset.pdfWorker!;
    try {
      // Webview resources are cross-origin for Worker(); load via a blob URL.
      const src = await (await fetch(workerUri)).text();
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUri;
    }
  })();
  return pdfReady;
}

function loadPdfInto(img: HTMLImageElement) {
  const url = img.dataset.pdf!;
  let p = pdfCache.get(url);
  if (!p) {
    p = setupPdf().then(async () => {
      const pdf = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
      const pg = await pdf.getPage(1);
      const viewport = pg.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await pg.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      return canvas.toDataURL('image/png');
    });
    pdfCache.set(url, p);
  }
  img.classList.add('loading');
  p.then(
    (dataUrl) => {
      img.src = dataUrl;
      img.classList.remove('loading');
    },
    (err) => {
      img.classList.remove('loading');
      const span = document.createElement('span');
      span.className = 'graphic placeholder missing';
      span.textContent = `Could not render PDF: ${img.alt} (${err?.message ?? err})`;
      img.replaceWith(span);
    },
  );
}

// ---------------------------------------------------------------------------
// Offsets ↔ elements

/** Maps an offset from the last full render to the current text (accounts for an open editor). */
function remap(offset: number): number {
  if (!editing) return offset;
  const delta = editing.hostLen - (editing.origEnd - editing.origStart);
  return offset >= editing.origEnd ? offset + delta : offset;
}

function elementForOffset(offset: number, exactStart = false): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestLen = Infinity;
  root.querySelectorAll<HTMLElement>('[data-start]').forEach((el) => {
    const s = Number(el.dataset.start);
    const e = Number(el.dataset.end);
    if (exactStart ? s === offset : s <= offset && offset <= e) {
      if (e - s < bestLen) {
        best = el;
        bestLen = e - s;
      }
    }
  });
  if (!best && exactStart) return elementForOffset(offset, false);
  return best;
}

function highlightOffset(offset: number) {
  const el = elementForOffset(offset);
  root.querySelectorAll('.synced').forEach((e) => e.classList.remove('synced'));
  if (!el) return;
  el.classList.add('synced');
  const r = el.getBoundingClientRect();
  if (r.bottom < 40 || r.top > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function markSelected(start: number) {
  root.querySelectorAll('.selected').forEach((e) => e.classList.remove('selected'));
  root.querySelector(`[data-start="${start}"]`)?.classList.add('selected');
}

function flash(el: Element) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('flash');
}

// ---------------------------------------------------------------------------
// Clicks

root.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (editing && editing.container.contains(target)) return;

  const link = target.closest('a');
  if (link) {
    e.preventDefault();
    e.stopPropagation();
    handleLink(link as HTMLAnchorElement);
    return;
  }
  if (target.closest('.add-block')) {
    if (editing) closeEditor();
    insertBlock('New paragraph.', ctx?.doc.insertPoint);
    return;
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && root.contains(sel.anchorNode)) return; // user is selecting text

  const blk = target.closest<HTMLElement>('[data-start]');
  const start = blk ? remap(Number(blk.dataset.start)) : null;
  if (editing) closeEditor();
  if (start === null) return;
  const el = elementForOffset(start, true);
  if (el) openEditor(el);
});

function handleLink(a: HTMLAnchorElement) {
  if (a.dataset.goto !== undefined) {
    const el = elementForOffset(remap(Number(a.dataset.goto)), true);
    if (el) flash(el);
  } else if (a.dataset.cite) {
    const el = document.getElementById(`bib-${a.dataset.cite}`);
    if (el) flash(el);
  } else if (a.dataset.external) {
    vscode.postMessage({ type: 'openExternal', url: a.getAttribute('href') });
  } else if (a.dataset.file) {
    vscode.postMessage({ type: 'openFile', file: a.dataset.file });
  }
}

// ---------------------------------------------------------------------------
// Block editor

function openEditor(el: HTMLElement) {
  const start = Number(el.dataset.start);
  const end = Number(el.dataset.end);
  selected = { start, end };
  const kind = el.classList.contains('item') ? 'item' : ([...el.classList].find((c) => c.startsWith('blk-'))?.slice(4) ?? 'block');

  const container = document.createElement('div');
  container.className = 'editor';
  const parentEl = el.parentElement?.closest<HTMLElement>('[data-start]');
  container.innerHTML = `
    <div class="editor-bar">
      <span class="editor-kind">${kind}</span>
      <span class="editor-hint">Edits apply live · Esc or ⌘↵ to finish</span>
      <span class="spacer"></span>
      ${parentEl ? '<button class="btn-parent" title="Edit the enclosing block">Edit enclosing</button>' : ''}
      <button class="btn-source" title="Show this block in the LaTeX source">Show source</button>
      <button class="btn-done primary">Done</button>
    </div>
    <textarea spellcheck="false"></textarea>
    <div class="preview-label">Preview</div>
    <div class="preview"></div>`;
  const ta = container.querySelector('textarea')!;
  const preview = container.querySelector<HTMLElement>('.preview')!;
  ta.value = text.slice(start, end);
  el.replaceWith(container);

  editing = {
    start,
    hostLen: end - start,
    origStart: start,
    origEnd: end,
    container,
    ta,
    preview,
    parentRange: parentEl ? { start: Number(parentEl.dataset.start), end: Number(parentEl.dataset.end) } : undefined,
  };
  autosize(ta);
  updatePreview(true);
  ta.focus();
  if (kind === 'paragraph' || kind === 'heading') ta.setSelectionRange(ta.value.length, ta.value.length);
  else ta.setSelectionRange(0, 0);
  updateToolbarState();

  ta.addEventListener('input', () => {
    autosize(ta);
    schedulePreview();
    scheduleSend();
  });
  ta.addEventListener('keydown', onEditorKey);
  container.querySelector('.btn-done')!.addEventListener('click', () => closeEditor());
  container.querySelector('.btn-source')!.addEventListener('click', () => {
    if (!editing) return;
    flushSend();
    vscode.postMessage({ type: 'reveal', start: editing.start, end: editing.start + editing.hostLen });
  });
  container.querySelector('.btn-parent')?.addEventListener('click', () => {
    if (!editing?.parentRange) return;
    // The parent starts before the edited region, so its offset is unaffected.
    const parentStart = editing.parentRange.start;
    closeEditor();
    const el2 = elementForOffset(parentStart, true);
    if (el2) openEditor(el2);
  });
}

function onEditorKey(e: KeyboardEvent) {
  const ta = e.target as HTMLTextAreaElement;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape' || (mod && e.key === 'Enter')) {
    e.preventDefault();
    closeEditor();
  } else if (e.key === 'Tab' && !mod) {
    e.preventDefault();
    insertAtCursor(ta, '  ');
  } else if (mod && (e.key === 'b' || e.key === 'i')) {
    e.preventDefault();
    wrapSelection(ta, e.key === 'b' ? '\\textbf{' : '\\emph{', '}');
  } else if (mod && e.key === 'm') {
    e.preventDefault();
    wrapSelection(ta, '$', '$');
  }
}

function insertAtCursor(ta: HTMLTextAreaElement, s: string) {
  ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input'));
}

function wrapSelection(ta: HTMLTextAreaElement, open: string, close: string) {
  const { selectionStart: a, selectionEnd: b } = ta;
  const inner = ta.value.slice(a, b);
  ta.setRangeText(open + inner + close, a, b, 'select');
  ta.setSelectionRange(a + open.length, a + open.length + inner.length);
  ta.dispatchEvent(new Event('input'));
}

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 4, window.innerHeight * 0.7)}px`;
}

function localText(): string {
  if (!editing) return text;
  return text.slice(0, editing.start) + editing.ta.value + text.slice(editing.start + editing.hostLen);
}

function schedulePreview() {
  if (!editing) return;
  clearTimeout(editing.previewTimer);
  editing.previewTimer = window.setTimeout(() => updatePreview(), text.length > 100000 ? 250 : 40);
}

function updatePreview(initial = false) {
  if (!editing) return;
  const c = buildContext(localText(), host);
  const html = renderRange(c, editing.start, editing.start + editing.ta.value.length);
  editing.preview.innerHTML = html || '<span class="chip">empty — this block will be removed</span>';
  postRender(editing.preview);
  if (initial) ctx = c;
}

function scheduleSend() {
  if (!editing) return;
  clearTimeout(editing.sendTimer);
  editing.sendTimer = window.setTimeout(flushSend, 300);
}

function flushSend() {
  if (!editing) return;
  clearTimeout(editing.sendTimer);
  const value = editing.ta.value;
  const old = text.slice(editing.start, editing.start + editing.hostLen);
  if (value === old) return;
  vscode.postMessage({ type: 'edit', start: editing.start, end: editing.start + editing.hostLen, text: value });
  text = text.slice(0, editing.start) + value + text.slice(editing.start + editing.hostLen);
  editing.hostLen = value.length;
}

function closeEditor(send = true) {
  if (!editing) return;
  if (send) flushSend();
  clearTimeout(editing.previewTimer);
  const { start, hostLen } = editing;
  editing = null;
  selected = { start, end: start + hostLen };
  updateToolbarState();
  renderAll();
}

// ---------------------------------------------------------------------------
// Inserting blocks

const TEMPLATES: Record<string, string> = {
  text: 'New paragraph.',
  section: '\\section{New section}',
  equation: '\\begin{equation}\n  f(x) = \\int_{-\\infty}^{\\infty} \\hat f(\\xi)\\, e^{2\\pi i \\xi x} \\, d\\xi\n  \\label{eq:new}\n\\end{equation}',
  table:
    '\\begin{table}[htbp]\n  \\centering\n  \\begin{tabular}{lcc}\n    \\toprule\n    Item & A & B \\\\\n    \\midrule\n    First & 1 & 2 \\\\\n    Second & 3 & 4 \\\\\n    \\bottomrule\n  \\end{tabular}\n  \\caption{New table.}\n  \\label{tab:new}\n\\end{table}',
  list: '\\begin{itemize}\n  \\item First item\n  \\item Second item\n\\end{itemize}',
};

/** Inserts a new block after the selected block (or at the end of the body). */
function insertBlock(src: string, at?: number) {
  if (editing) closeEditor();
  if (!ctx) ctx = buildContext(text, host);
  let pos = at;
  if (pos === undefined) {
    if (selected && ctx.doc.preamble && selected.start === ctx.doc.preamble.start) pos = ctx.doc.bodyStart;
    else pos = selected ? selected.end : ctx.doc.insertPoint;
  }
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const lead = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const insert = lead + src + trail;
  vscode.postMessage({ type: 'edit', start: pos, end: pos, text: insert });
  text = before + insert + after;
  pendingOpenAt = pos + lead.length;
  renderAll();
}

function buildToolbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'toolbar';
  bar.innerHTML = `
    <span class="tb-group">
      <button data-insert="text" title="Insert paragraph">¶ Text</button>
      <button data-insert="section" title="Insert section heading">§ Section</button>
      <button data-insert="equation" title="Insert numbered equation">∑ Equation</button>
      <button data-insert="table" title="Insert table">▦ Table</button>
      <button data-action="figure" title="Insert figure from an image file">▣ Figure</button>
      <button data-insert="list" title="Insert bulleted list">• List</button>
    </span>
    <span class="tb-group">
      <button data-action="ref" class="needs-edit" title="Insert a cross-reference at the cursor">→ Ref</button>
      <button data-action="cite" class="needs-edit" title="Insert a citation at the cursor">❝ Cite</button>
    </span>
    <span class="spacer"></span>
    <span class="tb-group">
      <button data-action="paper" title="Toggle paper / theme colours">◐ Paper</button>
      <button data-action="source" title="Open the LaTeX source to the side">{ } Source</button>
    </span>`;
  bar.addEventListener('mousedown', (e) => {
    // Keep focus (and the caret) in the editor textarea.
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const ins = btn.dataset.insert;
    if (ins) return insertBlock(TEMPLATES[ins]);
    switch (btn.dataset.action) {
      case 'figure': {
        if (editing) closeEditor();
        const c = ctx ?? buildContext(text, host);
        const pos = selected && !(c.doc.preamble && selected.start === c.doc.preamble.start) ? selected.end : c.doc.insertPoint;
        vscode.postMessage({ type: 'pickImage', at: pos });
        break;
      }
      case 'ref':
        showPicker(btn, refItems(), (key, item) => insertAtCursor(editing!.ta, item.kind === 'equation' ? `\\eqref{${key}}` : `\\ref{${key}}`));
        break;
      case 'cite':
        showPicker(btn, citeItems(), (key) => insertAtCursor(editing!.ta, `\\cite{${key}}`));
        break;
      case 'paper':
        applyPaperMode(!document.body.classList.contains('paper'));
        break;
      case 'source':
        vscode.postMessage({ type: 'reveal', start: selected?.start ?? 0, end: selected?.start ?? 0 });
        break;
    }
  });
  return bar;
}

function applyPaperMode(on: boolean) {
  document.body.classList.toggle('paper', on);
  saveState({ paper: on });
}

function updateToolbarState() {
  toolbar.querySelectorAll<HTMLButtonElement>('.needs-edit').forEach((b) => {
    b.disabled = !editing;
    b.title = editing ? b.title.replace(' (click into a block first)', '') : b.title.includes('click into') ? b.title : `${b.title} (click into a block first)`;
  });
}
updateToolbarState();

interface PickItem {
  key: string;
  label: string;
  detail: string;
  kind?: string;
}

function refItems(): PickItem[] {
  const c = buildContext(localText(), host);
  const kindName: Record<string, string> = { equation: 'Eq.', figure: 'Figure', table: 'Table', section: 'Section', theorem: 'Theorem', item: 'Item', other: '' };
  return [...c.labels.entries()].map(([key, l]) => ({ key, label: key, detail: `${kindName[l.kind] ?? ''} ${l.num}`.trim(), kind: l.kind }));
}

function citeItems(): PickItem[] {
  const c = buildContext(localText(), host);
  const items: PickItem[] = [...c.bib.values()].map((e) => ({
    key: e.key,
    label: e.key,
    detail: `${splitAuthors(e.fields.author ?? '').map((a) => a.split(' ').pop()).join(', ')}${e.fields.year ? ` (${e.fields.year})` : ''} — ${(e.fields.title ?? '').replace(/[{}]/g, '')}`,
  }));
  for (const [key, r] of c.bibitemText) {
    if (!c.bib.has(key)) items.push({ key, label: key, detail: stripTags(c.text.slice(r.start, r.end)).slice(0, 80) });
  }
  return items;
}

function showPicker(anchor: HTMLElement, items: PickItem[], onPick: (key: string, item: PickItem) => void) {
  if (!editing) return;
  document.querySelector('.picker')?.remove();
  const ta = editing.ta;
  const sel = [ta.selectionStart, ta.selectionEnd];
  const box = document.createElement('div');
  box.className = 'picker';
  box.innerHTML = `<input placeholder="Filter…"><div class="picker-list"></div>`;
  const input = box.querySelector('input')!;
  const list = box.querySelector<HTMLElement>('.picker-list')!;
  let active = 0;
  let shown: PickItem[] = [];
  const draw = () => {
    const q = input.value.toLowerCase();
    shown = items.filter((i) => (i.label + ' ' + i.detail).toLowerCase().includes(q)).slice(0, 50);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((i, k) => `<div class="pick${k === active ? ' active' : ''}" data-k="${k}"><b>${esc(i.label)}</b> <span>${esc(i.detail)}</span></div>`).join('')
      : `<div class="pick empty">${items.length ? 'No matches' : 'Nothing to insert yet'}</div>`;
  };
  const choose = (k: number) => {
    const item = shown[k];
    box.remove();
    ta.focus();
    ta.setSelectionRange(sel[0], sel[1]);
    if (item) onPick(item.key, item);
  };
  input.addEventListener('input', () => {
    active = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') active = Math.min(active + 1, shown.length - 1);
    else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
    else if (e.key === 'Enter') {
      // Prevent the Enter from reaching the textarea once focus moves back.
      e.preventDefault();
      return choose(active);
    }
    else if (e.key === 'Escape') {
      e.preventDefault();
      box.remove();
      ta.focus();
      return;
    } else return;
    e.preventDefault();
    draw();
  });
  list.addEventListener('mousedown', (e) => {
    const p = (e.target as HTMLElement).closest<HTMLElement>('.pick[data-k]');
    if (p) {
      e.preventDefault();
      choose(Number(p.dataset.k));
    }
  });
  input.addEventListener('blur', () => setTimeout(() => box.remove(), 150));
  const r = anchor.getBoundingClientRect();
  box.style.left = `${r.left}px`;
  box.style.top = `${r.bottom + 4}px`;
  document.body.appendChild(box);
  draw();
  input.focus();
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// State & test hooks

function saveState(patch: Record<string, unknown>) {
  Object.assign(state, patch);
  vscode.setState(state);
}

let scrollSave: number | undefined;
window.addEventListener('scroll', () => {
  clearTimeout(scrollSave);
  scrollSave = window.setTimeout(() => saveState({ scrollY: (document.scrollingElement ?? document.documentElement).scrollTop }), 200);
});

/** Hooks used by the integration tests to drive the UI end to end. */
function runTest(msg: any) {
  const reply = (data: unknown) => vscode.postMessage({ type: '__testResult', id: msg.id, data });
  try {
    if (msg.action === 'stats') return reply(collectStats(0));
    if (msg.action === 'editBlock') {
      const els = [...root.querySelectorAll<HTMLElement>('.blk')].filter((el) => el.matches(msg.selector ?? '.blk'));
      const el = els[msg.index];
      if (!el) return reply({ error: 'no such block' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (!editing) return reply({ error: 'editor did not open' });
      const ed = editing as Editing;
      ed.ta.value = msg.replace ? msg.text : ed.ta.value + msg.text;
      ed.ta.dispatchEvent(new Event('input'));
      const preview = ed.preview.innerHTML;
      closeEditor();
      return reply({ ok: true, preview: stripTags(preview).slice(0, 200) });
    }
    if (msg.action === 'html') return reply(root.innerHTML);
    if (msg.action === 'insert') {
      insertBlock(TEMPLATES[msg.template]);
      const open = !!editing;
      closeEditor();
      return reply({ ok: open });
    }
  } catch (e) {
    reply({ error: String(e) });
  }
}

vscode.postMessage({ type: 'ready' });
