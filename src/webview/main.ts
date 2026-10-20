// Webview side of the visual editor.
//
// The rendered document is a single contenteditable surface. Every piece of
// rendered text knows the source range it came from (see render.ts), so
// keystrokes are translated into small edits of the LaTeX source, the
// affected block is re-rendered, and the caret is put back at the matching
// source offset. Atomic pieces (math, references, figures...) are edited in a
// source popover instead.

import { Ctx, HostResources, buildContext } from '../latex/context';
import { bibCard, renderBlock, renderDocument, renderInline, renderKatex, renderRange, scanRun, stripTags } from '../latex/render';
import { Block } from '../latex/parser';
import {
  CompletionContext, CompletionItem, citationItems, commandItems, completionAt, environmentItems, fileItems, filterCompletions, inMath, labelItems,
} from '../latex/complete';
import {
  Align, CellPos, SettingKey, TableModel, TextEdit, cellAt, cellPosAt, colInfo, deleteCol, deleteRow, ensurePackage, fillCells, findTableAt,
  floatSettings, floatToLongtable, hasRule, insertCol, insertRow, isDataRow, longtableToFloat, mergeCells, parseTable, parseTsv,
  serializeTable, setBooktabs, setColAlign, setColWidth, setFloatSetting, splitCell, tableContainer, toggleRule, usesBooktabs,
} from '../latex/table';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
}
declare const acquireVsCodeApi: () => VsCodeApi;
declare const pdfjsLib: any;
/** Set by the build: true for development/test builds, false for published packages. */
declare const __TEST_HOOKS__: boolean;

interface Change {
  offset: number;
  removed: number;
  inserted: number;
}

/** The block source editor (textarea + live preview). */
interface SourceEditor {
  start: number;
  /** Length of the region in `text`. */
  hostLen: number;
  /** Region bounds when the editor was opened, used to remap stale DOM offsets. */
  origStart: number;
  origEnd: number;
  container: HTMLElement;
  ta: HTMLTextAreaElement;
  preview: HTMLElement;
  sendTimer?: number;
  previewTimer?: number;
  parentStart?: number;
  /** Removes the completion dropdown. */
  cleanup?: () => void;
  /** New block in an empty paragraph: separator written before the first content (e.g. a blank line). */
  prefix?: string;
  /** Length of `prefix` once it has been written. */
  added: number;
}

const vscode = acquireVsCodeApi();
const state = vscode.getState() ?? {};

/** The document text, including local edits not yet sent to the host. */
let text = '';
let host: HostResources = { images: {}, bib: '' };
let ctx: Ctx | undefined;
let sourceEd: SourceEditor | null = null;
let selected: { start: number; end: number } | null = null;
let pendingOpenAt: number | null = null;
let renderTimer: number | undefined;
let firstRender = true;
let expectUndoCaret = false;

const page = document.createElement('div');
page.id = 'page';
const root = document.createElement('div');
root.id = 'doc';
root.contentEditable = 'true';
root.spellcheck = true;
page.appendChild(root);
const gutter = document.createElement('button');
gutter.id = 'gutter';
gutter.title = 'Edit the LaTeX source of this block';
gutter.textContent = '</>';
page.appendChild(gutter);
const toolbar = buildToolbar();
document.body.append(toolbar, page);
applyPaperMode(state.paper ?? document.body.dataset.paper === 'true');

window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: `${e.message} @ ${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => vscode.postMessage({ type: 'error', message: String(e.reason) }));

// ---------------------------------------------------------------------------
// Sending edits. Consecutive keystrokes are coalesced into one edit window so
// the host (and VS Code's undo stack) sees word-sized changes.

let seq = 0;
let hostAck = 0;
let win: { start: number; hostLen: number; len: number; timer?: number } | null = null;

function sendEdit(start: number, end: number, newText: string) {
  seq++;
  vscode.postMessage({ type: 'edit', start, end, text: newText, seq });
}

/** Applies an edit to the local text and queues it for the host. */
function localEdit(a: number, b: number, ins: string) {
  if (win && (a < win.start || b > win.start + win.len)) flushWin();
  if (!win) win = { start: a, hostLen: b - a, len: b - a };
  win.len += ins.length - (b - a);
  text = text.slice(0, a) + ins + text.slice(b);
  shiftDiagnostics(a, b, ins.length);
  clearTimeout(win.timer);
  win.timer = window.setTimeout(flushWin, 250);
}

function flushWin() {
  if (!win) return;
  clearTimeout(win.timer);
  const w = win;
  win = null;
  sendEdit(w.start, w.start + w.hostLen, text.slice(w.start, w.start + w.len));
}

window.addEventListener('blur', flushWin);

// ---------------------------------------------------------------------------
// Messages from the extension host

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'update':
      onUpdate(msg.text, msg.host, msg.external, msg.changes ?? [], msg.ack ?? 0);
      break;
    case 'cursor':
      if (!sourceEd && !root.contains(document.activeElement)) highlightOffset(msg.offset);
      break;
    case 'insertTemplate':
      insertBlock(msg.text, msg.at);
      break;
    case 'resources':
      onResources(msg.host);
      break;
    case 'diagnostics':
      onDiagnostics(msg.batch, msg.items);
      break;
    case 'files':
      fileList = { files: msg.files, at: Date.now() };
      fileWaiters.splice(0).forEach((f) => f());
      break;
    case 'codeActionsResult':
      fixWaiters.get(msg.id)?.(msg.items);
      fixWaiters.delete(msg.id);
      break;
    case '__test':
      if (__TEST_HOOKS__) void runTest(msg);
      break;
  }
});

function onUpdate(newText: string, newHost: HostResources, external: boolean, changes: Change[], ack: number) {
  const hostChanged = JSON.stringify(newHost) !== JSON.stringify(host);
  host = newHost;
  hostAck = ack;
  if (firstRender) {
    text = newText;
    scheduleRender(0);
    return;
  }
  if (sourceEd) {
    if (!external) {
      if (hostChanged) updatePreview();
      return; // echo of our own edit; local text is already ahead
    }
    // Someone else edited the document: shift our region, or give up if they touched it.
    let shift = 0;
    const regionEnd = sourceEd.start + sourceEd.hostLen;
    let overlap = false;
    for (const c of changes) {
      if (c.offset + c.removed <= sourceEd.start) shift += c.inserted - c.removed;
      else if (c.offset >= regionEnd) continue;
      else overlap = true;
    }
    text = newText;
    for (const c of changes) shiftDiagnostics(c.offset, c.offset + c.removed, c.inserted);
    if (overlap) {
      closeEditor(false);
      return;
    }
    sourceEd.start += shift;
    sourceEd.origStart += shift;
    sourceEd.origEnd += shift;
    updatePreview();
    return;
  }
  if (external) {
    flushWin();
    let caret = caretSource();
    if (expectUndoCaret && changes.length) {
      caret = changes[0].offset + changes[0].inserted;
      expectUndoCaret = false;
    } else if (caret !== null) {
      let shifted = caret;
      for (const c of changes) {
        if (c.offset + c.removed <= caret) shifted += c.inserted - c.removed;
        else if (c.offset < caret) shifted = c.offset + c.inserted;
      }
      caret = shifted;
    }
    text = newText;
    for (const c of changes) shiftDiagnostics(c.offset, c.offset + c.removed, c.inserted);
    renderAll(caret);
    return;
  }
  // Echo of our own edits. Once the host has caught up, its text must match
  // ours; if it doesn't (an edit was rejected), resynchronise.
  if (!win && ack === seq && newText !== text) {
    text = newText;
    renderAll(caretSource());
  } else if (hostChanged) {
    renderAll(caretSource());
  }
}

/** Included files or other host resources changed; the text did not. */
function onResources(newHost: HostResources) {
  if (JSON.stringify(newHost) === JSON.stringify(host)) return;
  host = newHost;
  if (sourceEd) updatePreview();
  else if (!firstRender) renderAll(caretSource());
}

// ---------------------------------------------------------------------------
// Rendering

function scheduleRender(delay: number) {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => renderAll(caretSource()), delay);
}

function renderAll(caret: number | null = null) {
  if (sourceEd) return;
  const t0 = performance.now();
  ctx = buildContext(text, host);
  const scroller = document.scrollingElement ?? document.documentElement;
  const y = firstRender && state.scrollY ? state.scrollY : scroller.scrollTop;
  hideDiagPopup();
  root.innerHTML = renderDocument(ctx) + `<div class="add-block" contenteditable="false" title="Add a paragraph at the end">+ Add paragraph</div>`;
  postRender(root);
  drawDiagnostics();
  scroller.scrollTop = y;
  firstRender = false;
  if (selected) markSelected(selected.start);
  if (pendingOpenAt !== null) {
    const el = elementForOffset(pendingOpenAt, true);
    pendingOpenAt = null;
    if (el) openEditor(el);
  } else if (caret !== null) {
    setCaret(caret);
  }
  updateTableUi();
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
    regions: root.querySelectorAll('.ed').length,
    textLength: text.length,
  };
}

function postRender(el: HTMLElement) {
  el.querySelectorAll<HTMLImageElement>('img[data-pdf]').forEach((img) => loadPdfInto(img));
}

const pdfCache = new Map<string, Promise<string>>();
const pdfDone = new Map<string, string>();
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
  // Synchronous when already rasterised, so re-renders don't flicker.
  const done = pdfDone.get(url);
  if (done) {
    img.src = done;
    return;
  }
  let p = pdfCache.get(url);
  if (!p) {
    p = setupPdf().then(async () => {
      const pdf = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
      const pg = await pdf.getPage(1);
      const viewport = pg.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      // 'print' intent renders without requestAnimationFrame, so it also works in background tabs.
      await pg.render({ canvasContext: canvas.getContext('2d')!, viewport, intent: 'print' }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      pdfDone.set(url, dataUrl);
      return dataUrl;
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
// Caret ↔ source mapping

const num = (v: string | undefined) => (v === undefined ? null : Number(v));

function runTokens(run: HTMLElement) {
  return scanRun(text, Number(run.dataset.s), Number(run.dataset.e), ctx!);
}

/** Source offset of rendered character index `idx` inside a run. */
function runIndexToSource(run: HTMLElement, idx: number): number {
  let acc = 0;
  for (const tok of runTokens(run)) {
    const len = tok.out.length;
    if (len === 0) continue;
    if (idx <= acc) return tok.s;
    if (idx < acc + len) return tok.e; // inside a multi-character piece: snap after it
    acc += len;
  }
  return Number(run.dataset.e);
}

/** Rendered character index inside a run for a source offset. */
function sourceToRunIndex(run: HTMLElement, offset: number): number {
  let acc = 0;
  for (const tok of runTokens(run)) {
    if (offset <= tok.s) return acc;
    if (offset < tok.e) return acc + tok.out.length;
    acc += tok.out.length;
  }
  return acc;
}

function startOf(n: Node): number | null {
  if (n.nodeType !== 1) return null;
  const el = n as HTMLElement;
  const v = num(el.dataset.s) ?? num(el.dataset.start);
  if (v !== null) return el.classList.contains('ed') ? null : v;
  for (const c of el.childNodes) {
    const s = startOf(c);
    if (s !== null) return s;
  }
  return null;
}

function endOf(n: Node): number | null {
  if (n.nodeType !== 1) return null;
  const el = n as HTMLElement;
  const v = num(el.dataset.e) ?? num(el.dataset.end);
  if (v !== null) return el.classList.contains('ed') ? null : v;
  for (let k = el.childNodes.length - 1; k >= 0; k--) {
    const e = endOf(el.childNodes[k]);
    if (e !== null) return e;
  }
  return null;
}

/** Maps a DOM position to a source offset (null when it is not inside editable text). */
function domToSource(node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  if (node.nodeType === 3) {
    const run = node.parentElement?.closest<HTMLElement>('.r');
    if (run) {
      let idx = offset;
      // Account for preceding text nodes inside the same run (normally there is one).
      for (let p = node.previousSibling; p; p = p.previousSibling) idx += p.textContent?.length ?? 0;
      return runIndexToSource(run, idx);
    }
    const parent = node.parentElement!;
    const k = [...parent.childNodes].indexOf(node as ChildNode);
    return domToSource(parent, offset > 0 ? k + 1 : k);
  }
  const el = node as HTMLElement;
  const isl = el.closest<HTMLElement>('.isl');
  if (isl && isl !== el) return Number(isl.dataset.end);
  for (let k = offset - 1; k >= 0; k--) {
    const e = endOf(el.childNodes[k]);
    if (e !== null) return e;
  }
  for (let k = offset; k < el.childNodes.length; k++) {
    const s = startOf(el.childNodes[k]);
    if (s !== null) return s;
  }
  if (el.classList.contains('ed')) return Number(el.dataset.s);
  if (el.parentElement && el !== root) {
    const k = [...el.parentElement.childNodes].indexOf(el);
    return domToSource(el.parentElement, k);
  }
  return null;
}

function regionOf(node: Node | null): HTMLElement | null {
  const el = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  return el?.closest<HTMLElement>('.ed') ?? null;
}

function caretSource(): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.focusNode)) return null;
  if (!regionOf(sel.focusNode)) return null;
  return domToSource(sel.focusNode!, sel.focusOffset);
}

/** Places the caret at a source offset, preferring editable text runs. */
function setCaret(offset: number, focus = true): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  const range = document.createRange();
  const runs = [...root.querySelectorAll<HTMLElement>('.r')];
  let run = runs.find((r) => Number(r.dataset.s) <= offset && offset <= Number(r.dataset.e) && Number(r.dataset.s) !== offset);
  run ??= runs.find((r) => Number(r.dataset.s) <= offset && offset <= Number(r.dataset.e));
  if (run && run.firstChild) {
    range.setStart(run.firstChild, Math.min(sourceToRunIndex(run, offset), run.firstChild.textContent!.length));
  } else {
    const empty = root.querySelector<HTMLElement>(`.ed[data-s="${offset}"][data-e="${offset}"]`);
    const islEnd = root.querySelector<HTMLElement>(`.ed .isl[data-end="${offset}"], .ed br[data-e="${offset}"]`);
    const islStart = root.querySelector<HTMLElement>(`.ed .isl[data-start="${offset}"]`);
    if (empty) range.setStart(empty, 0);
    else if (islEnd) range.setStartAfter(islEnd);
    else if (islStart) range.setStartBefore(islStart);
    else {
      // Nearest following run (e.g. after whitespace that is not rendered).
      const next = runs.find((r) => Number(r.dataset.s) >= offset);
      if (!next?.firstChild) return false;
      range.setStart(next.firstChild, 0);
    }
  }
  range.collapse(true);
  if (focus && document.activeElement !== root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(range);
  const rect = range.getBoundingClientRect();
  if (rect.height && (rect.top < 50 || rect.bottom > window.innerHeight)) {
    (range.startContainer.parentElement ?? root).scrollIntoView({ block: 'nearest' });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inline editing

const isSourceUi = (n: EventTarget | null) => n instanceof Element && !!n.closest('.editor, .popover, .picker');

/** Escapes typed/pasted text so it reads literally in LaTeX. */
function escapeLatex(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\u0000')
    .replace(/([%&$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\u0000/g, '\\textbackslash{}')
    .replace(/\u00a0/g, '~');
}

/** True when deleting `src` cannot break the document structure. */
function isBalanced(src: string): boolean {
  if (/\\(begin|end)\b/.test(src)) return false;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '%') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

interface Mapped {
  a: number;
  b: number;
  regA: HTMLElement;
  regB: HTMLElement;
}

function mapRange(r: AbstractRange): Mapped | null {
  const regA = regionOf(r.startContainer);
  const regB = regionOf(r.endContainer);
  if (!regA || !regB) return null;
  const a = domToSource(r.startContainer, r.startOffset);
  const b = domToSource(r.endContainer, r.endOffset);
  if (a === null || b === null) return null;
  return { a: Math.min(a, b), b: Math.max(a, b), regA, regB };
}

function toLiveRange(r: AbstractRange): Range {
  if (r instanceof Range) return r;
  const lr = document.createRange();
  lr.setStart(r.startContainer, r.startOffset);
  lr.setEnd(r.endContainer, r.endOffset);
  return lr;
}

/** Source pieces of text runs and islands covered by a selection (used when a plain delete would unbalance braces). */
function coveredPieces(r: AbstractRange): [number, number][] {
  const live = toLiveRange(r);
  const pieces: [number, number][] = [];
  root.querySelectorAll<HTMLElement>('.r, .ed .isl').forEach((el) => {
    if (el.classList.contains('isl') && el.parentElement?.closest('.isl')) return;
    if (!live.intersectsNode(el)) return;
    if (el.classList.contains('isl')) {
      const elRange = document.createRange();
      elRange.selectNode(el);
      if (live.compareBoundaryPoints(Range.START_TO_START, elRange) <= 0 && live.compareBoundaryPoints(Range.END_TO_END, elRange) >= 0) {
        pieces.push([Number(el.dataset.start), Number(el.dataset.end)]);
      }
      return;
    }
    const s = el.contains(live.startContainer) ? domToSource(live.startContainer, live.startOffset)! : Number(el.dataset.s);
    const e = el.contains(live.endContainer) ? domToSource(live.endContainer, live.endOffset)! : Number(el.dataset.e);
    if (e > s) pieces.push([s, e]);
  });
  return pieces.sort((x, y) => x[0] - y[0]);
}

const EMPTY_FORMAT = /\\(textbf|textit|emph|texttt|underline|textsc|textsf|textrm|textsl|textup|uline|sout)\{\}/g;

/**
 * Replaces the selected content with `ins` (already LaTeX). Handles typing,
 * deletion (including across paragraphs) and pasting.
 */
function replaceRange(r: AbstractRange, ins: string): boolean {
  const m = mapRange(r);
  if (!m) return false;
  const sameRegion = m.regA === m.regB;
  const bothParas = m.regA.dataset.region === 'p' && m.regB.dataset.region === 'p';
  let pieces: [number, number][];
  if (m.a === m.b) pieces = [[m.a, m.a]];
  else if ((sameRegion || bothParas) && isBalanced(text.slice(m.a, m.b))) pieces = [[m.a, m.b]];
  else {
    pieces = coveredPieces(r);
    if (!pieces.length) return false;
  }
  const emptyRegion = m.regA.dataset.s === m.regA.dataset.e;
  const prefix = emptyRegion && m.a === Number(m.regA.dataset.s) ? m.regA.dataset.prefix ?? '' : '';
  const suffix = emptyRegion && m.a === Number(m.regA.dataset.s) && ins ? m.regA.dataset.suffix ?? '' : '';
  const first = pieces[0][0];
  const last = pieces[pieces.length - 1][1];
  // Rebuild [first, last) with the pieces removed and the insertion at the front.
  let mid = prefix + ins + suffix;
  let cursor = pieces[0][1];
  for (const [s, e] of pieces.slice(1)) {
    mid += text.slice(cursor, s);
    cursor = e;
  }
  mid += text.slice(cursor, last);
  let caret = first + prefix.length + ins.length;
  if (!ins) {
    // Drop formatting commands left empty by the deletion.
    mid = mid.replace(EMPTY_FORMAT, (whole, _n, at: number) => {
      if (first + at < caret) caret -= whole.length;
      return '';
    });
  }
  const structural = !sameRegion || ins.includes('\n\n') || prefix.includes('\n') || !!m.regA.closest('.phantom') || pieces.length > 1;
  applyEdit(first, last, mid, caret, structural ? null : m.regA);
  return true;
}

/**
 * Applies a source edit made from the rendered view. When the edit stays inside
 * one block, only that block is re-rendered; otherwise the whole document is.
 */
function applyEdit(a: number, b: number, ins: string, caret: number, regionEl: HTMLElement | null) {
  const blkEl = regionEl?.closest<HTMLElement>('.blk') ?? null;
  const before = ctx ? numberingSignature(ctx) : '';
  localEdit(a, b, ins);
  ctx = buildContext(text, host);
  // Citations, labels or footnotes changing affects other blocks (numbers, reference list).
  const renumbered = numberingSignature(ctx) !== before;
  if (blkEl && !blkEl.classList.contains('phantom') && !renumbered) {
    const oldStart = Number(blkEl.dataset.start);
    const oldEnd = Number(blkEl.dataset.end);
    const delta = ins.length - (b - a);
    const kind = [...blkEl.classList].find((c) => c.startsWith('blk-'))!.slice(4);
    const nb = a >= oldStart && b <= oldEnd ? findBlockByStart(ctx, oldStart, kind) : undefined;
    if (nb && nb.end === oldEnd + delta) {
      ctx.footnote = footnotesBefore(blkEl);
      const tpl = document.createElement('template');
      tpl.innerHTML = renderBlock(nb, ctx);
      const fresh = tpl.content.firstElementChild as HTMLElement | null;
      if (fresh) {
        shiftOffsets(blkEl, a, b, delta);
        blkEl.replaceWith(fresh);
        postRender(fresh);
        drawDiagnostics();
        setCaret(caret);
        updateTableUi();
        updateToolbarState();
        return;
      }
    }
  }
  renderAll(caret);
}

/** Everything cross-block numbering depends on; if it changes, the whole document is re-rendered. */
function numberingSignature(c: Ctx): string {
  const labels = [...c.labels.entries()].map(([k, l]) => `${k}=${l.num}`).join(',');
  const footnotes = (c.text.match(/\\(footnote|thanks)\b/g) ?? []).length;
  return `${c.citeOrder.join(',')}|${labels}|${footnotes}|${c.headings.length}`;
}

function findBlockByStart(c: Ctx, start: number, kind: string): Block | undefined {
  const visit = (blocks: Block[]): Block | undefined => {
    for (const b of blocks) {
      if (b.start === start && b.kind === kind) return b;
      if (b.start <= start && start <= b.end) {
        const inner = visit([...(b.children ?? []), ...(b.items ?? []).flatMap((it) => it.children)]);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  if (c.doc.preamble && c.doc.preamble.start === start && kind === 'preamble') return c.doc.preamble;
  return visit(c.doc.blocks);
}

function footnotesBefore(el: HTMLElement): number {
  let n = 0;
  root.querySelectorAll('sup.fn').forEach((f) => {
    if (!el.contains(f) && el.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_PRECEDING) n++;
  });
  return n;
}

/** After replacing source [a, b) by delta characters, fixes the offsets stored on elements outside `except`. */
function shiftOffsets(except: HTMLElement, a: number, b: number, delta: number) {
  if (!delta) return;
  root.querySelectorAll<HTMLElement>('[data-start],[data-s],[data-goto]').forEach((el) => {
    if (except.contains(el)) return;
    const d = el.dataset;
    for (const k of ['start', 's', 'goto'] as const) {
      const v = d[k];
      if (v !== undefined && Number(v) >= b && Number(v) > a) d[k] = String(Number(v) + delta);
    }
    for (const k of ['end', 'e'] as const) {
      const v = d[k];
      if (v !== undefined && Number(v) >= b) d[k] = String(Number(v) + delta);
    }
  });
  if (selected && selected.start >= b) selected = { start: selected.start + delta, end: selected.end + delta };
}

/** Enter key: split the paragraph, start a new list item, or open a new paragraph after the block. */
function handleEnter(r: AbstractRange) {
  const m = mapRange(r);
  if (!m || m.regA !== m.regB) return;
  const reg = m.regA;
  const kind = reg.dataset.region;
  const regStart = Number(reg.dataset.s);
  const regEnd = Number(reg.dataset.e);
  const atEnd = text.slice(m.b, regEnd).trim() === '';
  const atStart = text.slice(regStart, m.a).trim() === '';
  const blkEl = reg.closest<HTMLElement>('.blk')!;
  const item = reg.closest<HTMLElement>('li.item, .item');
  if (kind === 'cell') {
    moveInTable('down');
    return;
  }

  if (kind === 'p' && item && atEnd) {
    const itemStart = Number(item.dataset.start);
    const itemEnd = Number(item.dataset.end);
    if (regStart === regEnd) {
      // Enter in an empty item leaves the list: drop the item, continue after the list.
      const list = item.closest<HTMLElement>('.blk-list');
      if (!list) return;
      let a = itemStart;
      while (a > 0 && /[ \t]/.test(text[a - 1])) a--;
      if (text[a - 1] === '\n') a--;
      const listEnd = Number(list.dataset.end) - (itemEnd - a);
      localEdit(a, itemEnd, '');
      renderAll(null);
      const listEl = elementForOffset(Number(list.dataset.start), true);
      if (listEl) addPhantomAfter(listEl, listEnd);
      return;
    }
    const lineStart = text.lastIndexOf('\n', itemStart - 1) + 1;
    const indent = text.slice(lineStart, itemStart).match(/^[ \t]*/)![0];
    // No trailing space: the empty item's region adds one when the user starts typing.
    const ins = `\n${indent}\\item`;
    localEdit(itemEnd, itemEnd, ins);
    renderAll(itemEnd + ins.length);
    return;
  }
  if ((kind === 'p' || kind === 'h') && atEnd) {
    if (m.a !== m.b) replaceRange(r, '');
    addPhantomAfter(blkEl, Number(blkEl.dataset.end));
    return;
  }
  if (kind === 'p' && !atStart) {
    replaceRange(r, '\n\n');
  }
}

/** An empty paragraph placeholder; typing into it inserts a real paragraph at `at`. */
function addPhantomAfter(el: HTMLElement, at: number) {
  root.querySelectorAll('.phantom').forEach((p) => p.remove());
  const ph = document.createElement('div');
  ph.className = 'blk blk-paragraph phantom';
  ph.dataset.start = ph.dataset.end = String(at);
  const p = document.createElement('p');
  p.className = 'ed';
  p.contentEditable = 'true';
  p.dataset.region = 'p';
  p.dataset.s = p.dataset.e = String(at);
  p.dataset.prefix = '\n\n';
  p.appendChild(document.createElement('br'));
  ph.appendChild(p);
  el.after(ph);
  const range = document.createRange();
  range.setStart(p, 0);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Wraps the selection in a formatting command, or unwraps it if already formatted. */
function toggleFormat(cmd: string) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const m = mapRange(r);
  if (!m || m.regA !== m.regB || m.a === m.b) return;
  const src = text.slice(m.a, m.b);
  const fmt = (r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentElement : (r.commonAncestorContainer as HTMLElement))
    ?.closest<HTMLElement>(cmd === 'textbf' ? 'strong[data-s]' : 'em[data-s]');
  if (fmt && m.regA.contains(fmt)) {
    const s = Number(fmt.dataset.s);
    const e = Number(fmt.dataset.e);
    const open = text.indexOf('{', s);
    if (open !== -1 && open < e && m.a <= open + 1 && m.b >= e - 1) {
      const inner = text.slice(open + 1, e - 1);
      applyEdit(s, e, inner, s + inner.length, m.regA);
      return;
    }
  }
  if (!isBalanced(src)) return;
  const wrapped = `\\${cmd}{${src}}`;
  applyEdit(m.a, m.b, wrapped, m.a + wrapped.length, m.regA);
}

document.addEventListener('beforeinput', (e) => {
  if (!root.contains(e.target as Node) || isSourceUi(e.target)) return;
  if (e.inputType === 'insertCompositionText') return; // handled at compositionend
  e.preventDefault();
  const sel = window.getSelection();
  const ranges = e.getTargetRanges();
  const target: AbstractRange | undefined = ranges[0] ?? (sel && sel.rangeCount ? sel.getRangeAt(0) : undefined);
  if (!target) return;
  switch (e.inputType) {
    case 'insertText':
    case 'insertReplacementText': {
      const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      if (e.inputType === 'insertText' && (data === '$' || data === '\\')) {
        // In an empty paragraph, \ starts a block written in LaTeX (a figure, a table…).
        const reg = regionOf(target.startContainer);
        const blk = reg?.closest<HTMLElement>('.blk');
        if (data === '\\' && reg?.dataset.region === 'p' && blk && isEmptyParagraph(blk)) {
          openEditor(blk, '\\');
          return;
        }
        openInsertPopover(target, data === '$' ? '$$' : '\\', 1);
        return;
      }
      replaceRange(target, escapeLatex(data));
      return;
    }
    case 'insertFromPaste':
      pastePlain(target, e.dataTransfer?.getData('text/plain') ?? '');
      return;
    case 'insertParagraph':
      handleEnter(target);
      return;
    case 'insertLineBreak': {
      const reg = regionOf(target.startContainer);
      if (reg?.dataset.region === 'p') replaceRange(target, '\\\\\n');
      return;
    }
    case 'deleteContentBackward':
    case 'deleteContentForward':
    case 'deleteWordBackward':
    case 'deleteWordForward':
    case 'deleteSoftLineBackward':
    case 'deleteSoftLineForward':
    case 'deleteHardLineBackward':
    case 'deleteHardLineForward':
    case 'deleteByCut':
    case 'deleteContent':
      if (!target.collapsed) replaceRange(target, '');
      return;
    case 'formatBold':
      toggleFormat('textbf');
      return;
    case 'formatItalic':
      toggleFormat('emph');
      return;
    case 'historyUndo':
      requestHistory('undo');
      return;
    case 'historyRedo':
      requestHistory('redo');
      return;
  }
});

/** Pastes clipboard text as literal text; cells copied from a spreadsheet fill the table from the current cell. */
function pastePlain(target: AbstractRange, raw: string) {
  const data = raw.replace(/\r\n?/g, '\n');
  if (regionOf(target.startContainer)?.dataset.region === 'cell') {
    const grid = parseTsv(data.replace(/\n+$/, ''));
    if (grid.length > 1 || (grid[0]?.length ?? 0) > 1) {
      tableCaret = mapRange(target)?.a ?? tableCaret;
      tableOp((m, pos) => ({ focus: fillCells(m, pos, grid.map((row) => row.map(escapeLatex))) }));
      return;
    }
  }
  // LaTeX code pasted into an empty paragraph is kept as LaTeX (a figure, a table…).
  const reg = regionOf(target.startContainer);
  if (reg?.dataset.region === 'p' && reg.dataset.s === reg.dataset.e && /\\(begin\s*\{|[A-Za-z]{2,})/.test(data)) {
    replaceRange(target, data.trim().replace(/\n{3,}/g, '\n\n'));
    showToast('Pasted as LaTeX code.');
    return;
  }
  if (looksLikeLatex(data)) {
    pasteLatex(target, data);
    return;
  }
  const ins = escapeLatex(data).replace(/\n{3,}/g, '\n\n');
  replaceRange(target, ins);
  flashPasted(ins.length);
}

// VS Code pastes and cuts in webviews with document.execCommand, which fires
// paste / cut events but no beforeinput, and would edit the DOM directly
// (pasting HTML) without touching the source. Handle both here.
// Copy and cut put the selection's LaTeX source on the clipboard, so math,
// citations, references and formatting survive pasting.
const LATEX_MIME = 'text/x-latex-source';
/** The last LaTeX this editor copied, in case the private clipboard type doesn't survive the round trip. */
let lastCopied = '';

document.addEventListener('paste', (e) => {
  if (!root.contains(e.target as Node) || isSourceUi(e.target)) return;
  e.preventDefault();
  const sel = window.getSelection();
  if (!sel?.rangeCount || !regionOf(sel.getRangeAt(0).startContainer)) return;
  const plain = e.clipboardData?.getData('text/plain') ?? '';
  const latex = e.clipboardData?.getData(LATEX_MIME) || (plain && plain === lastCopied ? plain : '');
  if (latex) pasteLatex(sel.getRangeAt(0), latex);
  else pastePlain(sel.getRangeAt(0), plain);
});
document.addEventListener('copy', (e) => {
  if (!root.contains(e.target as Node) || isSourceUi(e.target)) return;
  if (putSelectionOnClipboard(e)) e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (!root.contains(e.target as Node) || isSourceUi(e.target)) return;
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return;
  e.preventDefault();
  if (!putSelectionOnClipboard(e)) e.clipboardData?.setData('text/plain', sel.toString());
  replaceRange(sel.getRangeAt(0), '');
});

function pasteLatex(target: AbstractRange, latex: string) {
  const ins = latex.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  replaceRange(target, ins);
  flashPasted(ins.length);
}

/**
 * Puts the selection's LaTeX source on the clipboard (as plain text, so it also
 * pastes into the source editor, and under a private type), plus readable HTML
 * for rich-text apps. False when it doesn't map to source (the browser's copy is used).
 */
function putSelectionOnClipboard(e: ClipboardEvent): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed || !e.clipboardData) return false;
  const range = sel.getRangeAt(0);
  const src = selectionLatex(range);
  if (!src) return false;
  lastCopied = src;
  e.clipboardData.setData('text/plain', src);
  e.clipboardData.setData(LATEX_MIME, src);
  e.clipboardData.setData('text/html', richHtml(range));
  return true;
}

/** Source offset of a selection end: citations, refs and math count whole, and a non-editable block counts whole. */
function boundarySource(node: Node, offset: number, side: 'start' | 'end'): number | null {
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  let isl: HTMLElement | null = el?.closest<HTMLElement>('.isl') ?? null;
  for (let up = isl?.parentElement?.closest<HTMLElement>('.isl'); up; up = up.parentElement?.closest<HTMLElement>('.isl')) isl = up;
  if (isl && root.contains(isl)) return Number(side === 'start' ? isl.dataset.start : isl.dataset.end);
  if (regionOf(node)) return domToSource(node, offset);
  const blk = el?.closest<HTMLElement>('.blk');
  if (blk && root.contains(blk)) return Number(side === 'start' ? blk.dataset.start : blk.dataset.end);
  return domToSource(node, offset);
}

/** The selection as complete LaTeX: commands and environments cut by its ends are reopened or closed. */
function selectionLatex(range: Range): string {
  let a = boundarySource(range.startContainer, range.startOffset, 'start');
  let b = boundarySource(range.endContainer, range.endOffset, 'end');
  if (a === null || b === null) return '';
  if (a > b) [a, b] = [b, a];
  if (a === b) return '';
  const blkEl = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : (range.startContainer as HTMLElement))?.closest<HTMLElement>('.blk');
  const from = blkEl && Number(blkEl.dataset.start) <= a ? Number(blkEl.dataset.start) : 0;
  return completeLatex(text, from, a, b);
}

/**
 * Returns src[a, b) made self-contained: groups open at `a` (scanning from
 * `from`) are reopened with their command (`\textbf{`, `\href{url}{`), groups
 * left open at `b` are closed, and unmatched \begin / \end get their partners.
 */
function completeLatex(src: string, from: number, a: number, b: number): string {
  const openers = scanOpeners(src, from, a);
  let body = src.slice(a, b);
  // Close groups opened before or inside the selection that it leaves open.
  let depth = openers.length;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') i++;
    else if (c === '%') {
      const nl = body.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
    } else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  body = openers.join('') + body + (body.match(/%[^\n]*$/) ? '\n' : '') + '}'.repeat(depth);
  // Environments.
  const stack: string[] = [];
  const begins: string[] = [];
  for (const m of body.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else if (stack.length && stack[stack.length - 1] === m[2]) stack.pop();
    else begins.unshift(m[2]);
  }
  const list = (env: string) => /^(itemize|enumerate|description)$/.test(env);
  const head = begins.map((env) => `\\begin{${env}}\n${list(env) && !/^\s*\\item\b/.test(body) ? '\\item ' : ''}`).join('');
  const tail = stack.reverse().map((env) => `\n\\end{${env}}`).join('');
  return head + body + tail;
}

/** The commands whose brace groups are open at `at`, e.g. ['\\textbf{', '\\href{url}{']. */
function scanOpeners(src: string, from: number, at: number): string[] {
  const stack: { opener: string; chain: number }[] = [];
  let chain = -1;
  for (let i = from; i < at; i++) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z@]+\*?)/.exec(src.slice(i, i + 40));
      if (m) {
        chain = i;
        i += m[0].length - 1;
      } else {
        chain = -1;
        i++;
      }
    } else if (c === '%') {
      const nl = src.indexOf('\n', i);
      if (nl === -1 || nl >= at) break;
      i = nl;
      chain = -1;
    } else if (c === '[' && chain >= 0) {
      const close = src.indexOf(']', i);
      if (close === -1 || close >= at) break;
      i = close;
    } else if (c === '{') {
      stack.push({ opener: chain >= 0 ? src.slice(chain, i + 1) : '{', chain });
      chain = -1;
    } else if (c === '}') {
      chain = stack.pop()?.chain ?? -1;
    } else if (!(chain >= 0 && /\s/.test(c) && src[i + 1] === '{')) chain = -1;
  }
  return stack.map((s) => s.opener);
}

/** True when pasted plain text is LaTeX code (commands, escapes or environments), so it should be kept rather than escaped. */
function looksLikeLatex(s: string): boolean {
  if (!/\\(begin|end)\s*\{|\\[A-Za-z]+\*?(\[[^\]\n]*\])?\{|\\[%&$#_{}]|\\(item|centering|hline|toprule|midrule|bottomrule|noindent|par|LaTeX|TeX)\b/.test(s)) return false;
  return isBalanced(s) || balancedEnvironments(s);
}

/** True when every \\begin{x} in `src` has its \\end{x} and braces balance (isBalanced rejects environments). */
function balancedEnvironments(src: string): boolean {
  const stack: string[] = [];
  for (const m of src.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0 && isBalanced(src.replace(/\\(begin|end)\s*\{[^}]*\}/g, ''));
}

/** The selection as HTML for rich-text apps: rendered text, with math as its LaTeX, and no editor chrome. */
function richHtml(range: Range): string {
  const box = document.createElement('div');
  box.appendChild(range.cloneContents());
  box.querySelectorAll('.anchor, button, .secnum + .ed:empty').forEach((n) => n.remove());
  box.querySelectorAll<HTMLElement>('.isl[data-start]').forEach((isl) => {
    if (isl.querySelector('.katex')) isl.replaceWith(text.slice(Number(isl.dataset.start), Number(isl.dataset.end)));
  });
  box.querySelectorAll('.katex').forEach((k) => k.replaceWith(k.textContent ?? ''));
  box.querySelectorAll('*').forEach((n) => {
    for (const at of [...n.attributes]) if (at.name !== 'href' && at.name !== 'src') n.removeAttribute(at.name);
  });
  return box.innerHTML.replace(/\u200b/g, '');
}

/** The selection's text as it reads, without KaTeX's hidden MathML or caret anchors. */
function readableText(range: Range): string {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;white-space:pre-wrap;';
  box.appendChild(range.cloneContents());
  box.querySelectorAll('.katex-mathml, .anchor, .secnum + .ed:empty').forEach((n) => n.remove());
  document.body.appendChild(box);
  const out = box.innerText.replace(/​/g, '');
  box.remove();
  return out.trim() ? out : range.toString();
}

/** Briefly highlights the `length` characters before the caret (just pasted), so it is clear where they went. */
function flashPasted(length: number) {
  const end = caretSource();
  if (end === null || !highlightsSupported) return;
  const start = Math.max(0, end - length);
  const ranges: Range[] = [];
  root.querySelectorAll<HTMLElement>('.r[data-s]').forEach((el) => {
    const s0 = Number(el.dataset.s);
    const e0 = Number(el.dataset.e);
    const node = el.firstChild;
    if (e0 <= start || s0 >= end || !node || node.nodeType !== 3) return;
    const len = node.textContent!.length;
    const r = document.createRange();
    r.setStart(node, Math.min(sourceToRunIndex(el, Math.max(start, s0)), len));
    r.setEnd(node, Math.min(sourceToRunIndex(el, Math.min(end, e0)), len));
    if (!r.collapsed) ranges.push(r);
  });
  if (!ranges.length) return;
  CSS.highlights.set('pasted', new Highlight(...ranges));
  const rect = ranges[0].getBoundingClientRect();
  if (rect.top < 60 || rect.bottom > window.innerHeight) ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center' });
  clearTimeout(pasteFlashTimer);
  pasteFlashTimer = window.setTimeout(() => CSS.highlights.delete('pasted'), 1500);
}
let pasteFlashTimer: number | undefined;

// IME composition can't be cancelled: let the browser draw it, then commit it as an edit.
let compositionAt: { pos: number; reg: HTMLElement } | null = null;
root.addEventListener('compositionstart', () => {
  const pos = caretSource();
  const sel = window.getSelection();
  const reg = sel ? regionOf(sel.focusNode) : null;
  compositionAt = pos !== null && reg ? { pos, reg } : null;
});
root.addEventListener('compositionend', (e) => {
  const at = compositionAt;
  compositionAt = null;
  if (!at || !e.data) {
    renderAll(caretSource());
    return;
  }
  const ins = escapeLatex(e.data);
  applyEdit(at.pos, at.pos, ins, at.pos + ins.length, root.contains(at.reg) ? at.reg : null);
});

function requestHistory(kind: 'undo' | 'redo') {
  flushWin();
  expectUndoCaret = true;
  vscode.postMessage({ type: kind });
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') flushWin(); // make sure a save includes the latest keystrokes
  if (isSourceUi(e.target) || !root.contains(e.target as Node)) return;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    requestHistory('undo');
  } else if (mod && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y')) {
    e.preventDefault();
    requestHistory('redo');
  } else if (mod && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleFormat('textbf');
  } else if (mod && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    toggleFormat('emph');
  } else if (mod && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const r = sel.getRangeAt(0);
    const m = mapRange(r);
    const inner = m ? text.slice(m.a, m.b) : '';
    openInsertPopover(r, `$${inner}$`, inner ? inner.length + 1 : 1);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel?.rangeCount && regionOf(sel.focusNode)?.dataset.region === 'cell') moveInTable(e.shiftKey ? 'prev' : 'next');
  }
});

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.focusNode)) return;
  const node = sel.focusNode!;
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  // Leaving an untouched placeholder paragraph removes it.
  root.querySelectorAll('.phantom').forEach((p) => {
    if (!p.contains(node)) p.remove();
  });
  const blk = el?.closest<HTMLElement>('.blk');
  if (blk && !blk.classList.contains('phantom')) {
    selected = { start: Number(blk.dataset.start), end: Number(blk.dataset.end) };
    markSelected(selected.start);
  }
  updateToolbarState();
});

// ---------------------------------------------------------------------------
// Insert popover: typing $ or \ (or ⌘M) opens a small LaTeX editor at the caret.

function openInsertPopover(r: AbstractRange, initial: string, caretIdx: number) {
  const m = mapRange(r);
  if (!m || m.regA !== m.regB) return;
  if (m.a !== m.b && !isBalanced(text.slice(m.a, m.b))) return;
  closePopover();
  const reg = m.regA;
  const rect = caretRect(r, reg);
  const box = document.createElement('div');
  box.className = 'popover';
  box.contentEditable = 'false';
  box.innerHTML = `<textarea spellcheck="false" rows="1"></textarea><div class="popover-preview"></div><div class="popover-hint">↵ insert · Esc cancel · ⇧↵ new line</div>`;
  const ta = box.querySelector('textarea')!;
  const preview = box.querySelector<HTMLElement>('.popover-preview')!;
  ta.value = initial;
  const detach = attachCompletion(
    ta,
    (mode) => {
      if (mode === 'enter') finish(true);
    },
    { textMode: true },
  );
  const draw = () => {
    preview.innerHTML = ta.value.trim() ? renderInline(ta.value, ctx!) : '';
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  };
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    box.remove();
    detach();
    let v = ta.value;
    // Tie a citation or reference to the preceding word, as is conventional.
    if (/^\\(cite|citep|ref|eqref|cref|autoref)\b/.test(v) && m.a === m.b && /[A-Za-z0-9.,;:)]/.test(text[m.a - 1] ?? '')) v = '~' + v;
    if (commit && v.trim() && v !== '$$' && v !== '\\' && !/^~?\\(cite\w*|ref|eqref)\{\}?$/.test(v)) applyEdit(m.a, m.b, v, m.a + v.length, reg);
    else setCaret(m.b);
  };
  ta.addEventListener('input', draw);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  ta.addEventListener('blur', () => setTimeout(() => finish(true), 0));
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340))}px`;
  box.style.top = `${rect.bottom + 6}px`;
  document.body.appendChild(box);
  draw();
  ta.focus();
  ta.setSelectionRange(caretIdx, caretIdx);
}

/**
 * Screen box of a caret position. A caret in an empty region (just a <br>) or
 * at some element boundaries has an all-zero box, so measure a temporary
 * marker there instead (and fall back to the region itself).
 */
function caretRect(r: AbstractRange, region: HTMLElement): DOMRect {
  const live = toLiveRange(r);
  const rect = live.getClientRects()[0] ?? live.getBoundingClientRect();
  if (rect.height || rect.top || rect.left) return rect;
  const parent = live.startContainer.nodeType === 3 ? live.startContainer.parentNode : live.startContainer;
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  try {
    live.cloneRange().insertNode(mark);
    const m = mark.getBoundingClientRect();
    if (m.height) return m;
  } finally {
    mark.remove();
    parent?.normalize();
  }
  return region.getBoundingClientRect();
}

function closePopover() {
  document.querySelector('.popover')?.remove();
}

// ---------------------------------------------------------------------------
// Offsets ↔ elements

/** Maps an offset from the last full render to the current text (accounts for an open source editor). */
function remap(offset: number): number {
  if (!sourceEd) return offset;
  const delta = sourceEd.hostLen + sourceEd.added - (sourceEd.origEnd - sourceEd.origStart);
  return offset >= sourceEd.origEnd ? offset + delta : offset;
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
  const blk = el.closest('.blk') ?? el;
  blk.classList.add('synced');
  const r = blk.getBoundingClientRect();
  if (r.bottom < 40 || r.top > window.innerHeight) blk.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function markSelected(start: number) {
  root.querySelectorAll('.selected').forEach((e) => e.classList.remove('selected'));
  root.querySelector(`.blk[data-start="${start}"]`)?.classList.add('selected');
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
  if (sourceEd && sourceEd.container.contains(target)) return;

  const link = target.closest('a');
  // A citation in editable text opens its \cite{…} for editing (with key completion); other links navigate.
  const editableCite = !!link?.dataset.cite && !!link.closest('.ed .isl');
  if (editableCite) hideCitePopup();
  if (link && !e.altKey && !editableCite) {
    e.preventDefault();
    handleLink(link as HTMLAnchorElement);
    return;
  }
  if (target.closest('.include-body')) {
    // Read-only content of an included file (double-click opens it).
    if (sourceEd) closeEditor();
    return;
  }
  if (target.closest('.add-block')) {
    if (sourceEd) closeEditor();
    const c = ctx ?? buildContext(text, host);
    const last = c.doc.blocks[c.doc.blocks.length - 1];
    const lastEl = last ? elementForOffset(last.start, true) : undefined;
    if (lastEl) addPhantomAfter(lastEl.closest('.blk') ?? lastEl, last.end);
    return;
  }

  if (sourceEd) {
    // Clicking elsewhere finishes the source edit, then continues the click.
    const { clientX, clientY } = e;
    const inTable = !target.closest('.isl') && !!tableBlockOf(target);
    const isl = inTable ? null : target.closest<HTMLElement>('.isl, .blk[contenteditable="false"]');
    const start = isl ? remap(Number(isl.dataset.start)) : null;
    closeEditor();
    if (inTable) {
      // The table was re-rendered: find it again under the pointer.
      const again = document.elementFromPoint(clientX, clientY);
      const tbl = again && tableBlockOf(again as HTMLElement);
      if (tbl) focusNearestRegion(tbl, clientX, clientY);
    } else if (start !== null) {
      const el = elementForOffset(start, true);
      if (el) openEditor(el);
    } else {
      const pos = document.caretRangeFromPoint?.(clientX, clientY);
      if (pos && regionOf(pos.startContainer)) {
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(pos);
      }
    }
    return;
  }

  // Atomic pieces (math, citations with ⌥, graphics) and non-text blocks open the source editor.
  const isl = target.closest<HTMLElement>('.isl');
  if (isl && root.contains(isl)) {
    openEditor(isl);
    return;
  }
  if (target.closest('.ed')) {
    fixCaretAfterClick(e.clientX, e.clientY);
    return;
  }
  // Anywhere else in a table (cell padding, rules, caption label) goes to the nearest cell, not the source.
  const tbl = tableBlockOf(target);
  if (tbl) {
    focusNearestRegion(tbl, e.clientX, e.clientY);
    return;
  }
  const blk = target.closest<HTMLElement>('.blk[contenteditable="false"]');
  if (blk) {
    openEditor(blk);
    return;
  }
  fixCaretAfterClick(e.clientX, e.clientY);
});

root.addEventListener('dblclick', (e) => {
  const body = (e.target as HTMLElement).closest('.include-body');
  const open = body?.parentElement?.querySelector<HTMLElement>(':scope > .include-bar > .open-file');
  if (open) vscode.postMessage({ type: 'openFile', file: open.dataset.file });
});

/** The table block (float or bare tabular) containing `el`, when it has editable cells. */
function tableBlockOf(el: HTMLElement): HTMLElement | null {
  const blk = el.closest<HTMLElement>('.blk-table, .blk-tabular');
  return blk && root.contains(blk) && blk.querySelector('.ed[data-region="cell"]') ? blk : null;
}

/** Puts the caret in the text region (cell or caption) of `blk` nearest to a point. */
function focusNearestRegion(blk: HTMLElement, x: number, y: number) {
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  blk.querySelectorAll<HTMLElement>('.ed').forEach((reg) => {
    const r = (reg.closest('td') ?? reg).getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = reg;
    }
  });
  const reg = best as HTMLElement | null;
  if (!reg) return;
  const pos = document.caretRangeFromPoint?.(x, y);
  if (pos && regionOf(pos.startContainer) === reg) {
    root.focus({ preventScroll: true });
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(pos);
  } else setCaret(Number(reg.dataset.e));
}

/**
 * Browsers sometimes resolve a click beside non-editable content to a caret
 * position outside any text region (often the very start of the document).
 * Put it at the nearest position in the region under the pointer instead.
 */
function fixCaretAfterClick(x: number, y: number) {
  const sel = window.getSelection();
  if (!sel || (sel.rangeCount && !sel.isCollapsed)) return;
  if (sel.rangeCount && regionOf(sel.focusNode) && root.contains(sel.focusNode)) return;
  const reg = document.elementsFromPoint(x, y).find((el) => el.classList.contains('ed') && root.contains(el)) as HTMLElement | undefined;
  if (!reg) return;
  const pos = document.caretRangeFromPoint?.(x, y);
  if (pos && regionOf(pos.startContainer) === reg) {
    sel.removeAllRanges();
    sel.addRange(pos);
    return;
  }
  // Left of the region's first line → its start; otherwise its end.
  const first = reg.getClientRects()[0];
  setCaret(first && y < first.bottom && x < first.left + 4 ? Number(reg.dataset.s) : Number(reg.dataset.e));
}

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

// Hover buttons: edit any block's source (left), delete the block (upper right).
let gutterTarget: HTMLElement | null = null;
const delBtn = document.createElement('button');
delBtn.id = 'del-block';
delBtn.textContent = '×';
delBtn.title = 'Delete this block (⌘Z / Ctrl+Z to undo)';
page.appendChild(delBtn);
const hideHoverButtons = () => {
  gutter.style.display = 'none';
  delBtn.style.display = 'none';
};
page.addEventListener('mousemove', (e) => {
  if (sourceEd) return hideHoverButtons();
  const t = e.target as HTMLElement;
  if (t === gutter || t === delBtn) return;
  const blk = t.closest<HTMLElement>('#doc > .blk, .blk');
  if (!blk) return;
  gutterTarget = blk;
  const pr = page.getBoundingClientRect();
  const br = blk.getBoundingClientRect();
  gutter.style.display = 'block';
  gutter.style.top = `${br.top - pr.top}px`;
  gutter.style.left = `${Math.max(2, br.left - pr.left - 34)}px`;
  const deletable = !blk.classList.contains('blk-preamble') && !blk.classList.contains('phantom');
  delBtn.style.display = deletable ? 'block' : 'none';
  delBtn.style.top = `${br.top - pr.top + 2}px`;
  delBtn.style.left = `${br.right - pr.left - 22}px`;
});
page.addEventListener('mouseleave', hideHoverButtons);
gutter.addEventListener('mousedown', (e) => e.preventDefault());
gutter.addEventListener('click', () => {
  gutter.style.display = 'none';
  if (gutterTarget && root.contains(gutterTarget)) openEditor(gutterTarget);
});
delBtn.addEventListener('mousedown', (e) => e.preventDefault());
delBtn.addEventListener('click', () => {
  hideHoverButtons();
  if (gutterTarget && root.contains(gutterTarget)) deleteBlock(gutterTarget);
});

/** The source range a deletion of `blk` removes: its own line(s), or its list item when it is the item's only block. */
function deletionRange(blk: HTMLElement): { a: number; b: number; what: string } {
  let el: HTMLElement = blk;
  const item = blk.parentElement?.closest<HTMLElement>('.item');
  if (item && root.contains(item) && item.querySelectorAll('.blk').length === 1) el = item;
  let a = Number(el.dataset.start);
  let b = Number(el.dataset.end);
  // Take the whole line when the block stands alone on it.
  const lineStart = text.lastIndexOf('\n', a - 1) + 1;
  let lineEnd = text.indexOf('\n', b);
  if (lineEnd === -1) lineEnd = text.length;
  if (/^[ \t]*$/.test(text.slice(lineStart, a)) && /^[ \t]*$/.test(text.slice(b, lineEnd))) {
    a = lineStart;
    b = Math.min(text.length, lineEnd + 1);
    // Don't leave more than one blank line where the block was.
    const blankBefore = /\n[ \t]*\n$/.test(text.slice(0, a)) || a === 0;
    while (blankBefore && b < text.length && /^[ \t]*\n/.test(text.slice(b))) b = text.indexOf('\n', b) + 1;
  }
  const kind = el === item ? 'list item' : ([...blk.classList].find((c) => c.startsWith('blk-'))?.slice(4) ?? 'block');
  return { a, b, what: kind };
}

function deleteBlock(blk: HTMLElement) {
  if (sourceEd) closeEditor();
  flushWin();
  const { a, b, what } = deletionRange(blk);
  if (b <= a) return;
  selected = null;
  applyEdit(a, b, '', a, null);
  flushWin();
  showToast(`Deleted ${what}.`, 'Undo', () => requestHistory('undo'));
}

let toastTimer: number | undefined;
function showToast(message: string, action?: string, onAction?: () => void) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${esc(message)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  t.querySelector('button')?.addEventListener('mousedown', (e) => e.preventDefault());
  t.querySelector('button')?.addEventListener('click', () => {
    t.remove();
    onAction?.();
  });
  document.body.appendChild(t);
  toastTimer = window.setTimeout(() => t.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Source editor (for math, figures, tables, islands and "</>")

/** An empty paragraph (new or in an empty list item): its LaTeX editor writes a new block. */
const isEmptyParagraph = (el: HTMLElement) => el.classList.contains('blk-paragraph') && el.dataset.start === el.dataset.end;

/** Opens the LaTeX source editor for a block or island; `initial` pre-fills an empty paragraph's editor. */
function openEditor(el: HTMLElement, initial?: string) {
  flushWin();
  closePopover();
  hideDiagPopup();
  const start = Number(el.dataset.start);
  const end = Number(el.dataset.end);
  selected = { start, end };
  const newBlock = isEmptyParagraph(el);
  const kind = newBlock ? 'new block' : el.classList.contains('isl')
    ? el.classList.contains('math') ? 'math' : el.classList.contains('refisl') ? 'reference' : 'inline'
    : el.classList.contains('item') ? 'item' : ([...el.classList].find((c) => c.startsWith('blk-'))?.slice(4) ?? 'block');

  const container = document.createElement(el.classList.contains('isl') ? 'span' : 'div');
  container.className = 'editor' + (el.classList.contains('isl') ? ' inline-editor' : '');
  container.contentEditable = 'false';
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
  ta.value = newBlock ? initial ?? '' : text.slice(start, end);
  el.replaceWith(container);

  sourceEd = {
    start,
    hostLen: end - start,
    origStart: start,
    origEnd: end,
    container,
    ta,
    preview,
    parentStart: parentEl ? Number(parentEl.dataset.start) : undefined,
    prefix: newBlock ? el.querySelector<HTMLElement>('.ed')?.dataset.prefix ?? '' : undefined,
    added: 0,
  };
  sourceEd.cleanup = attachCompletion(ta);
  autosize(ta);
  updatePreview(true);
  ta.focus();
  if (kind === 'paragraph' || kind === 'heading' || newBlock) ta.setSelectionRange(ta.value.length, ta.value.length);
  else if (kind === 'math' && /^\$.*\$$/s.test(ta.value)) ta.setSelectionRange(ta.value.length - 1, ta.value.length - 1);
  else if (/^~?\\[A-Za-z]*cite[A-Za-z]*\*?(\[[^\]]*\])*\{[^}]*\}$/.test(ta.value)) {
    // A citation: caret after its keys, with the bibliography list open.
    ta.setSelectionRange(ta.value.length - 1, ta.value.length - 1);
    ta.dispatchEvent(new Event('click'));
  } else ta.setSelectionRange(0, 0);
  updateToolbarState();

  ta.addEventListener('input', () => {
    autosize(ta);
    schedulePreview();
    scheduleSend();
  });
  ta.addEventListener('keydown', onEditorKey);
  container.querySelector('.btn-done')!.addEventListener('click', () => closeEditor());
  container.querySelector('.btn-source')!.addEventListener('click', () => {
    if (!sourceEd) return;
    flushSend();
    vscode.postMessage({ type: 'reveal', start: sourceEd.start, end: sourceEd.start + sourceEd.hostLen });
  });
  container.querySelector('.btn-parent')?.addEventListener('click', () => {
    if (sourceEd?.parentStart === undefined) return;
    // The parent starts before the edited region, so its offset is unaffected.
    const parentStart = sourceEd.parentStart;
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
  if (!sourceEd) return text;
  return text.slice(0, sourceEd.start) + sourceEd.ta.value + text.slice(sourceEd.start + sourceEd.hostLen);
}

function schedulePreview() {
  if (!sourceEd) return;
  clearTimeout(sourceEd.previewTimer);
  sourceEd.previewTimer = window.setTimeout(() => updatePreview(), text.length > 100000 ? 250 : 40);
}

function updatePreview(initial = false) {
  if (!sourceEd) return;
  const c = buildContext(localText(), host);
  const isInline = sourceEd.container.classList.contains('inline-editor');
  const html = isInline ? renderInline(sourceEd.ta.value, c) : renderRange(c, sourceEd.start, sourceEd.start + sourceEd.ta.value.length);
  sourceEd.preview.innerHTML = html || '<span class="chip">empty — this will be removed</span>';
  // The preview is display-only.
  sourceEd.preview.querySelectorAll('[contenteditable]').forEach((n) => n.setAttribute('contenteditable', 'false'));
  postRender(sourceEd.preview);
  if (initial) ctx = c;
}

function scheduleSend() {
  if (!sourceEd) return;
  clearTimeout(sourceEd.sendTimer);
  sourceEd.sendTimer = window.setTimeout(flushSend, 300);
}

function flushSend() {
  if (!sourceEd) return;
  clearTimeout(sourceEd.sendTimer);
  const value = sourceEd.ta.value;
  const old = text.slice(sourceEd.start, sourceEd.start + sourceEd.hostLen);
  if (value === old) return;
  if (sourceEd.prefix && !sourceEd.added) {
    // A new block: write its separator together with the first content.
    const ins = sourceEd.prefix + value;
    sendEdit(sourceEd.start, sourceEd.start, ins);
    shiftDiagnostics(sourceEd.start, sourceEd.start, ins.length);
    text = text.slice(0, sourceEd.start) + ins + text.slice(sourceEd.start);
    sourceEd.start += sourceEd.prefix.length;
    sourceEd.added = sourceEd.prefix.length;
    sourceEd.hostLen = value.length;
    return;
  }
  sendEdit(sourceEd.start, sourceEd.start + sourceEd.hostLen, value);
  shiftDiagnostics(sourceEd.start, sourceEd.start + sourceEd.hostLen, value.length);
  text = text.slice(0, sourceEd.start) + value + text.slice(sourceEd.start + sourceEd.hostLen);
  sourceEd.hostLen = value.length;
}

function closeEditor(send = true) {
  if (!sourceEd) return;
  // A new block left with just the backslash that opened it is dropped.
  if (sourceEd.prefix !== undefined && /^\s*\\?\s*$/.test(sourceEd.ta.value)) sourceEd.ta.value = '';
  if (send) flushSend();
  clearTimeout(sourceEd.previewTimer);
  sourceEd.cleanup?.();
  const { start, hostLen } = sourceEd;
  sourceEd = null;
  selected = { start, end: start + hostLen };
  updateToolbarState();
  renderAll(null);
}

// ---------------------------------------------------------------------------
// Inserting blocks

const TEMPLATES: Record<string, string> = {
  section: '\\section{New section}',
  equation: '\\begin{equation}\n  f(x) = \\int_{-\\infty}^{\\infty} \\hat f(\\xi)\\, e^{2\\pi i \\xi x} \\, d\\xi\n  \\label{eq:new}\n\\end{equation}',
  table:
    '\\begin{table}[htbp]\n  \\centering\n  \\begin{tabular}{lcc}\n    \\toprule\n    Item & A & B \\\\\n    \\midrule\n    First & 1 & 2 \\\\\n    Second & 3 & 4 \\\\\n    \\bottomrule\n  \\end{tabular}\n  \\caption{New table.}\n  \\label{tab:new}\n\\end{table}',
  list: '\\begin{itemize}\n  \\item First item\n  \\item Second item\n\\end{itemize}',
};

/** Where new blocks go: after the block holding the caret, or at the end of the body. */
function insertionPoint(): number {
  const c = ctx ?? buildContext(text, host);
  if (selected && c.doc.preamble && selected.start === c.doc.preamble.start) return c.doc.bodyStart;
  return selected ? selected.end : c.doc.insertPoint;
}

/** Inserts a new block and opens it in the source editor. Text-like blocks are edited inline instead. */
function insertBlock(src: string, at?: number, inline = false) {
  if (sourceEd) closeEditor();
  flushWin();
  if (!ctx) ctx = buildContext(text, host);
  const pos = at ?? insertionPoint();
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const lead = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const insert = lead + src + trail;
  sendEdit(pos, pos, insert);
  shiftDiagnostics(pos, pos, insert.length);
  text = before + insert + after;
  const start = pos + lead.length;
  if (inline) {
    renderAll(null);
    // Select the placeholder text so typing replaces it.
    const runs = [...root.querySelectorAll<HTMLElement>('.r')].filter((r) => Number(r.dataset.s) >= start && Number(r.dataset.e) <= start + src.length);
    if (runs.length) {
      const range = document.createRange();
      range.selectNodeContents(runs[runs.length - 1]);
      root.focus({ preventScroll: true });
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      runs[runs.length - 1].scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  pendingOpenAt = start;
  renderAll(null);
}

function buildToolbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'toolbar';
  bar.innerHTML = `
    <span class="tb-group">
      <button data-action="text" title="New paragraph after the current block (or press Enter at the end of a paragraph)">¶ Text</button>
      <button data-action="section" title="Insert section heading">§ Section</button>
      <button data-insert="equation" title="Insert numbered equation">∑ Equation</button>
      <button data-insert="table" title="Insert table">▦ Table</button>
      <button data-action="figure" title="Insert figure from an image file">▣ Figure</button>
      <button data-insert="list" title="Insert bulleted list">• List</button>
    </span>
    <span class="tb-group">
      <button data-action="bold" class="needs-text" title="Bold (⌘B)"><b>B</b></button>
      <button data-action="italic" class="needs-text" title="Italic (⌘I)"><i>I</i></button>
      <button data-action="math" class="needs-text" title="Inline math (type $ or ⌘M)">$x$</button>
      <button data-action="ref" class="needs-edit" title="Insert a cross-reference at the cursor">→ Ref</button>
      <button data-action="cite" class="needs-edit" title="Insert a citation at the cursor">❝ Cite</button>
    </span>
    <span class="spacer"></span>
    <span class="tb-group">
      <button data-action="paper" title="Toggle paper / theme colors">◐ Paper</button>
      <button data-action="source" title="Open the LaTeX source to the side">{ } Source</button>
    </span>`;
  bar.addEventListener('mousedown', (e) => {
    // Keep focus (and the caret) where it is.
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.disabled) return;
    const ins = btn.dataset.insert;
    if (ins === 'table') return insertTable();
    if (ins) return insertBlock(TEMPLATES[ins]);
    switch (btn.dataset.action) {
      case 'text': {
        if (sourceEd) closeEditor();
        const pos = insertionPoint();
        const el = selected ? root.querySelector<HTMLElement>(`.blk[data-start="${selected.start}"]`) : null;
        const anchor = el ?? (root.querySelector<HTMLElement>('#doc > .blk:last-of-type') as HTMLElement | null);
        if (anchor) addPhantomAfter(anchor, el ? pos : Number(anchor.dataset.end));
        break;
      }
      case 'section':
        insertBlock('\\section{New section}', undefined, true);
        break;
      case 'figure': {
        if (sourceEd) closeEditor();
        vscode.postMessage({ type: 'pickImage', at: insertionPoint() });
        break;
      }
      case 'bold':
        toggleFormat('textbf');
        break;
      case 'italic':
        toggleFormat('emph');
        break;
      case 'math': {
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        const r = sel.getRangeAt(0);
        const m = mapRange(r);
        const inner = m ? text.slice(m.a, m.b) : '';
        openInsertPopover(r, `$${inner}$`, inner ? inner.length + 1 : 1);
        break;
      }
      case 'ref':
        startKeyCompletion('\\ref{');
        break;
      case 'cite':
        startKeyCompletion('\\cite{');
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

/** Starts a \\cite{ or \\ref{ at the caret (inline or in the source editor) with key completion open. */
function startKeyCompletion(open: string) {
  if (sourceEd) {
    sourceEd.ta.focus();
    insertAtCursor(sourceEd.ta, open);
    return;
  }
  const sel = window.getSelection();
  if (!sel?.rangeCount || !regionOf(sel.focusNode)) return;
  openInsertPopover(sel.getRangeAt(0), open, open.length);
}

function applyPaperMode(on: boolean) {
  document.body.classList.toggle('paper', on);
  saveState({ paper: on });
}

function updateToolbarState() {
  const sel = window.getSelection();
  const inText = !!sel?.rangeCount && !!regionOf(sel.focusNode) && root.contains(sel.focusNode);
  toolbar.querySelectorAll<HTMLButtonElement>('.needs-edit').forEach((b) => (b.disabled = !sourceEd && !inText));
  toolbar.querySelectorAll<HTMLButtonElement>('.needs-text').forEach((b) => (b.disabled = !!sourceEd || !inText));
}
updateToolbarState();

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Key completion for \cite{…} and \ref{…} in any LaTeX textarea

/** Screen position just below the caret of a textarea (via a mirror element). */
function caretCoords(ta: HTMLTextAreaElement): { left: number; top: number } {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontSize', 'lineHeight', 'fontFamily', 'letterSpacing', 'wordSpacing', 'tabSize'] as const) {
    (div.style as any)[p] = (cs as any)[p];
  }
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '0' });
  div.textContent = ta.value.slice(0, ta.selectionStart);
  const span = document.createElement('span');
  span.textContent = ta.value.slice(ta.selectionStart) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const r = ta.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  const pos = { left: r.left + span.offsetLeft - ta.scrollLeft, top: r.top + span.offsetTop - ta.scrollTop + lh };
  div.remove();
  return pos;
}

/** Files next to the document (paths relative to its folder), fetched from the host and kept briefly. */
let fileList: { files: string[]; at: number } | null = null;
const fileWaiters: (() => void)[] = [];

/** The file list, or null while it loads (`onReady` runs when a fresh list arrives). */
function documentFiles(onReady: () => void): string[] | null {
  if (fileList && Date.now() - fileList.at < 10000) return fileList.files;
  if (!fileWaiters.length) vscode.postMessage({ type: 'listFiles' });
  fileWaiters.push(onReady);
  return fileList?.files ?? null;
}

function graphicsPaths(src: string): string[] {
  const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})*)\s*\}/.exec(src);
  return gp ? [...gp[1].matchAll(/\{([^}]*)\}/g)].map((m) => m[1]) : [];
}

/**
 * Shows bibliography entries while a citation key is being typed (labels
 * for \ref-like commands, files for \input, \includegraphics and the like). ↑/↓ choose, Enter inserts the key and closes the
 * brace, Tab inserts it followed by ", " for another key, Esc dismisses.
 */
function attachCompletion(ta: HTMLTextAreaElement, onAccept?: (mode: 'enter' | 'tab') => void, opts: { textMode?: boolean } = {}): () => void {
  const list = document.createElement('div');
  list.className = 'complete';
  list.style.display = 'none';
  document.body.appendChild(list);
  let items: CompletionItem[] = [];
  let active = 0;
  let cc: CompletionContext | null = null;
  let dismissedAt = -1;
  let loading = false;

  const hide = () => {
    list.style.display = 'none';
    cc = null;
  };
  const draw = () => {
    if (!cc) return;
    const hint = cc.kind === 'cite' ? '↵ insert · Tab add another · Esc close' : '↵ insert · Esc close';
    const empty =
      cc.kind === 'cite'
        ? ctx?.bib.size || ctx?.bibitemText.size ? 'No matching bibliography entries' : 'No bibliography found (\\bibliography{…} or \\addbibresource{…})'
        : cc.kind === 'file' ? (loading ? 'Looking for files…' : 'No matching files in this folder')
        : cc.kind === 'command' ? 'No matching commands' : cc.kind === 'env' ? 'No matching environments' : 'No matching labels';
    const c = ctx ?? buildContext(text, host);
    const label = (it: CompletionItem) =>
      cc!.kind === 'command' ? `\\${(it.snippet ?? it.key).replace('$', '')}` : cc!.kind === 'env' && it.snippet ? it.snippet.replace('}', '} ') : it.key;
    const preview = (it: CompletionItem) =>
      it.math ? renderKatex(it.preview ?? `\\${it.key}`, false, c) : it.preview ? renderInline(it.preview, c) : '';
    list.innerHTML = items.length
      ? items
          .map((it, k) => {
            const pv = cc!.kind === 'command' ? preview(it) : '';
            return `<div class="cmp${k === active ? ' active' : ''}" data-k="${k}"><div class="cmp-main"><b>${esc(label(it))}</b>${pv ? ` <span class="cmp-prev">${pv}</span>` : ''} <span>${esc(it.detail)}</span></div>${
              it.info ? `<div class="cmp-info">${esc(it.info)}</div>` : ''
            }</div>`;
          })
          .join('') + `<div class="cmp-hint">${hint}</div>`
      : `<div class="cmp empty">${empty}</div>`;
    list.querySelector('.cmp.active')?.scrollIntoView({ block: 'nearest' });
  };
  const update = () => {
    const caret = ta.selectionStart;
    cc = ta.selectionStart === ta.selectionEnd ? completionAt(ta.value, caret) : null;
    if (!cc || dismissedAt === cc.from) {
      if (!cc) dismissedAt = -1;
      return hide();
    }
    const c = ctx ?? buildContext(text, host);
    let source: CompletionItem[];
    if (cc.kind === 'file') {
      const files = documentFiles(() => list.isConnected && document.activeElement === ta && update());
      loading = !files;
      source = fileItems(files ?? [], cc.command, graphicsPaths(c.text));
    } else if (cc.kind === 'command') {
      source = commandItems(c);
      // In math, math commands come first.
      if (inMath(ta.value, cc.from - 1)) source = source.map((it) => (it.math ? { ...it, rank: it.rank - 5000 } : it));
    } else if (cc.kind === 'env') {
      source = environmentItems();
    } else source = cc.kind === 'cite' ? citationItems(c) : labelItems(c);
    items = filterCompletions(source, cc.query, cc.kind === 'file' ? 10 : 8);
    active = 0;
    draw();
    const pos = caretCoords(ta);
    list.style.display = 'block';
    list.style.left = `${Math.max(4, Math.min(pos.left, window.innerWidth - list.offsetWidth - 8))}px`;
    const below = pos.top + 2;
    list.style.top = `${below + list.offsetHeight > window.innerHeight ? Math.max(4, pos.top - list.offsetHeight - 24) : below}px`;
  };
  const accept = (k: number, mode: 'enter' | 'tab') => {
    const it = items[k];
    if (!it || !cc) return;
    let from = cc.from;
    let to = cc.to;
    // From the toolbar's \ref{, equations read better as \eqref.
    if (cc.kind === 'ref' && it.kind === 'equation' && cc.command === 'ref' && ta.value.slice(0, from).endsWith('\\ref{')) {
      ta.setRangeText('\\eqref{', from - '\\ref{'.length, from, 'preserve');
      from += 2;
      to += 2;
    }
    const after = ta.value.slice(to);
    if (cc.kind === 'command' || cc.kind === 'env') {
      const caret = cc.kind === 'command' ? insertCommand(it, from, to) : insertEnvironment(it, cc.command, from, to);
      ta.setSelectionRange(caret.at, caret.at);
      hide();
      ta.dispatchEvent(new Event('input'));
      if (caret.done) onAccept?.(mode);
      return;
    }
    let ins: string;
    if (mode === 'tab' && cc.kind === 'cite') {
      // Insert the key and a separator, ready for the next key.
      ins = `${it.key}, `;
      if (after.startsWith(',')) to += after.startsWith(', ') ? 2 : 1;
    } else {
      ins = `${it.key}}`;
      if (after.startsWith('}')) to += 1;
    }
    ta.setRangeText(ins, from, to, 'end');
    hide();
    ta.dispatchEvent(new Event('input'));
    onAccept?.(mode);
  };

  /** Math symbols typed into running text are wrapped in $…$. */
  const wrapsInMath = (it: CompletionItem, from: number) => !!it.math && !!opts.textMode && !inMath(ta.value, from - 1);
  /** Writes a command (its name, after the backslash at from - 1). `done`: nothing left to fill in. */
  const insertCommand = (it: CompletionItem, from: number, to: number): { at: number; done: boolean } => {
    const snip = it.snippet ?? it.key;
    const hole = snip.indexOf('$');
    const body = snip.replace('$', '');
    if (wrapsInMath(it, from)) {
      ta.setRangeText(`$\\${body}$`, from - 1, to, 'end');
      return hole === -1 ? { at: from + body.length + 2, done: true } : { at: from + 1 + hole, done: false };
    }
    ta.setRangeText(body, from, to, 'end');
    return hole === -1 ? { at: from + body.length, done: true } : { at: from + hole, done: false };
  };
  /** Writes an environment name; after \begin{ it also adds arguments and the matching \end. */
  const insertEnvironment = (it: CompletionItem, command: string, from: number, to: number): { at: number; done: boolean } => {
    if (ta.value[to] === '}') to++;
    let ins = `${it.key}}`;
    let at = from + ins.length;
    if (command === 'begin') {
      ins += it.snippet ? it.snippet.slice(it.key.length + 1) : '';
      at = from + ins.length;
      if (!ta.value.slice(to).includes(`\\end{${it.key}}`)) {
        const lineStart = ta.value.lastIndexOf('\n', from - 1) + 1;
        const indent = /^[ \t]*/.exec(ta.value.slice(lineStart))![0];
        at = from + ins.length + 3 + indent.length;
        ins += `\n${indent}  \n${indent}\\end{${it.key}}`;
      }
    }
    ta.setRangeText(ins, from, to, 'end');
    return { at, done: false };
  };

  ta.addEventListener(
    'keydown',
    (e) => {
      if (list.style.display === 'none' || !cc) return;
      // Enter after a complete command name (\item, \beta in math) keeps its usual meaning.
      const exact = items[active];
      if (e.key === 'Enter' && cc.kind === 'command' && exact && exact.key === cc.query && !exact.snippet && !wrapsInMath(exact, cc.from)) {
        hide();
        return;
      }
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        if (items.length) active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        draw();
      } else if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        if (!items.length) return;
        stop();
        accept(active, e.key === 'Tab' ? 'tab' : 'enter');
      } else if (e.key === 'Escape') {
        stop();
        dismissedAt = cc.from;
        hide();
      }
    },
    { capture: true },
  );
  ta.addEventListener('input', update);
  ta.addEventListener('focus', update);
  ta.addEventListener('click', update);
  ta.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) update();
  });
  ta.addEventListener('blur', () => setTimeout(() => document.activeElement !== ta && hide(), 120));
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>('.cmp[data-k]');
    if (row) accept(Number(row.dataset.k), 'enter');
  });
  return () => list.remove();
}

// ---------------------------------------------------------------------------
// Table editing. While the caret is in a table cell, a table bar offers
// structural edits; each rewrites the table environment from a parsed model
// (cell contents are kept as written) in one undoable edit.

const tableBar = buildTableBar();
toolbar.appendChild(tableBar);
const resizeLayer = document.createElement('div');
resizeLayer.id = 'col-resizers';
page.appendChild(resizeLayer);
/** Source offset of the caret in the active table's cell (kept while the table bar has focus). */
let tableCaret: number | null = null;

interface TableOpResult {
  focus?: CellPos | null;
  packages?: string[];
}

function currentTable(): { m: TableModel; pos: CellPos & { index: number } } | null {
  if (tableCaret === null) return null;
  const m = findTableAt(text, tableCaret);
  const pos = m && cellPosAt(m, tableCaret);
  return m && pos ? { m, pos } : null;
}

/** Applies a structural change to the table at the caret and puts the caret in the cell it returns. */
function tableOp(fn: (m: TableModel, pos: CellPos & { index: number }) => TableOpResult | null) {
  flushWin();
  if (tableCaret === null) {
    const c = caretSource();
    if (c !== null) tableCaret = c;
  }
  const cur = currentTable();
  if (!cur) return;
  const res = fn(cur.m, cur.pos);
  if (!res) return;
  const out = serializeTable(cur.m);
  const focus = res.focus ?? cur.pos;
  const row = cur.m.rows[Math.min(focus.row, cur.m.rows.length - 1)];
  const c = row && isDataRow(row) ? cellAt(row, Math.min(focus.col, Math.max(0, row.cells.reduce((n, x) => n + x.span, 0) - 1))) : null;
  const off = c ? out.cells[cur.m.rows.indexOf(row)][c.index] : undefined;
  const caret = cur.m.start + (off !== undefined ? off + row.cells[c!.index].src.length : 0);
  commitTableEdit({ start: cur.m.start, end: cur.m.end, text: out.src }, caret, res.packages);
}

/** Applies `main`, then adds any missing packages to the preamble (before it), keeping the caret in place. */
function commitTableEdit(main: TextEdit, caret: number, packages: string[] = []) {
  if (sourceEd) closeEditor();
  localEdit(main.start, main.end, main.text);
  flushWin();
  for (const pkg of packages) {
    const e = ensurePackage(text, pkg);
    if (!e || e.start > main.start) continue;
    localEdit(e.start, e.end, e.text);
    flushWin();
    caret += e.text.length - (e.end - e.start);
  }
  tableCaret = caret;
  renderAll(caret);
}

/** Tab / Shift+Tab / Enter navigation between cells. Tab in the last cell adds a row. */
function moveInTable(dir: 'next' | 'prev' | 'down') {
  flushWin();
  tableCaret = caretSource();
  const cur = currentTable();
  if (!cur) return;
  const { m, pos } = cur;
  const go = (row: number, index: number) => {
    const cell = m.rows[row].cells[index];
    tableCaret = cell.end;
    setCaret(cell.end);
  };
  if (dir === 'down') {
    for (let r = pos.row + 1; r < m.rows.length; r++) {
      const c = isDataRow(m.rows[r]) ? cellAt(m.rows[r], pos.col) : null;
      if (c) return go(r, c.index);
    }
    return;
  }
  const order: [number, number][] = [];
  m.rows.forEach((r, k) => isDataRow(r) && r.cells.forEach((_c, i) => order.push([k, i])));
  const at = order.findIndex(([r, i]) => r === pos.row && i === pos.index);
  const next = order[at + (dir === 'next' ? 1 : -1)];
  if (next) go(next[0], next[1]);
  else if (dir === 'next') tableOp((mm, p) => ({ focus: insertRow(mm, p.row, true) }));
}

/** Logical columns covered by the current selection, when it spans cells of one row. */
function selectedCells(m: TableModel): { row: number; from: number; to: number } | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const a = regionOf(r.startContainer);
  const b = regionOf(r.endContainer);
  if (a?.dataset.region !== 'cell' || b?.dataset.region !== 'cell' || a === b) return null;
  const pa = cellPosAt(m, Number(a.dataset.s));
  const pb = cellPosAt(m, Number(b.dataset.s));
  if (!pa || !pb || pa.row !== pb.row) return null;
  return { row: pa.row, from: Math.min(pa.col, pb.col), to: Math.max(pa.col, pb.col) };
}

const INITIAL_TABLE = [
  '\\begin{table}[htbp]',
  '  \\centering',
  '  \\begin{tabular}{lll}',
  '    \\toprule',
  '    Column 1 & Column 2 & Column 3 \\\\',
  '    \\midrule',
  '    & & \\\\',
  '    & & \\\\',
  '    \\bottomrule',
  '  \\end{tabular}',
  '  \\caption{Caption.}',
  '  \\label{tab:new}',
  '\\end{table}',
].join('\n');

/** Inserts a booktabs table after the current block and selects its first header cell. */
function insertTable() {
  if (sourceEd) closeEditor();
  flushWin();
  if (!ctx) ctx = buildContext(text, host);
  const pos = insertionPoint();
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const lead = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const cell = pos + lead.length + INITIAL_TABLE.indexOf('Column 1');
  commitTableEdit({ start: pos, end: pos, text: lead + INITIAL_TABLE + trail }, cell + 'Column 1'.length, ['booktabs']);
  const region = root.querySelector<HTMLElement>(`.ed[data-region="cell"][data-e="${tableCaret}"]`);
  if (region) {
    const range = document.createRange();
    range.selectNodeContents(region);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function alignIcon(d: string): string {
  return `<svg class="icon" viewBox="0 0 14 12" width="14" height="12"><path d="${d}" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
}

function buildTableBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'table-bar';
  bar.hidden = true;
  const opt = (pairs: [string, string][]) => pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  bar.innerHTML = `
    <span class="tb-title">Table</span>
    <span class="tb-group">
      <button data-t="row-above" title="Insert a row above">+ Row ↑</button>
      <button data-t="row-below" title="Insert a row below (Tab in the last cell also adds one)">+ Row ↓</button>
      <button data-t="row-del" title="Delete this row">− Row</button>
    </span>
    <span class="tb-group">
      <button data-t="col-left" title="Insert a column to the left">+ Col ←</button>
      <button data-t="col-right" title="Insert a column to the right">+ Col →</button>
      <button data-t="col-del" title="Delete this column">− Col</button>
    </span>
    <span class="tb-group">
      <button data-t="align-l" title="Align column left">${alignIcon('M1 2h12M1 6h8M1 10h10')}</button>
      <button data-t="align-c" title="Center column">${alignIcon('M1 2h12M3 6h8M2 10h10')}</button>
      <button data-t="align-r" title="Align column right">${alignIcon('M1 2h12M5 6h8M3 10h10')}</button>
      <button data-t="wrap" title="Wrap text in this column at a fixed width (drag the column's right edge to resize)">↵ Wrap</button>
    </span>
    <span class="tb-group">
      <button data-t="rule-above" title="Line above this row">▔ Line</button>
      <button data-t="rule-below" title="Line below this row">▁ Line</button>
    </span>
    <span class="tb-group">
      <button data-t="merge" title="Merge the selected cells of this row">Merge</button>
      <button data-t="split" title="Split this merged cell">Split</button>
    </span>
    <span class="tb-group tb-settings">
      <label title="Professional rules (\\toprule, \\midrule, \\bottomrule; booktabs package), no vertical lines"><input type="checkbox" data-t="booktabs"> booktabs</label>
      <label title="longtable: the table can break across pages (not a float)"><input type="checkbox" data-t="longtable"> long</label>
      <select data-t="size" title="Font size">${opt([['', 'Font: normal'], ['small', 'small'], ['footnotesize', 'footnotesize'], ['scriptsize', 'scriptsize'], ['tiny', 'tiny']])}</select>
      <select data-t="stretch" title="Row spacing (\\arraystretch)">${opt([['', 'Rows: 1'], ['1.15', '1.15'], ['1.3', '1.3'], ['1.5', '1.5'], ['2', '2']])}</select>
      <select data-t="colsep" title="Space between columns (\\tabcolsep)">${opt([['', 'Columns: 6pt'], ['2pt', '2pt'], ['4pt', '4pt'], ['8pt', '8pt'], ['12pt', '12pt']])}</select>
    </span>
    <button data-t="source" title="Edit the table's LaTeX">&lt;/&gt;</button>`;
  bar.addEventListener('mousedown', (e) => {
    // Keep the caret in the cell (selects still need focus to open).
    if (!(e.target as HTMLElement).closest('select')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button[data-t], input[data-t]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    if (el instanceof HTMLInputElement) {
      if (el.dataset.t === 'booktabs') tableOp((m) => (setBooktabs(m, el.checked), { packages: el.checked ? ['booktabs'] : [] }));
      else toggleLongtable(el.checked);
      return;
    }
    runTableButton(el.dataset.t!);
  });
  bar.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.tagName === 'SELECT') setTableSetting(el.dataset.t as SettingKey, el.value || null);
  });
  return bar;
}

function runTableButton(action: string) {
  if (action === 'source') {
    const cur = currentTable();
    const el = cur && root.querySelector<HTMLElement>(`.blk[data-start="${(ctx && tableContainer(ctx.doc.blocks, cur.m)?.start) ?? -1}"]`);
    const blk = el ?? (tableCaret !== null ? elementForOffset(tableCaret)?.closest<HTMLElement>('.blk') : null);
    if (blk) openEditor(blk);
    return;
  }
  tableOp((m, pos): TableOpResult | null => {
    switch (action) {
      case 'row-above':
        return { focus: insertRow(m, pos.row, false) };
      case 'row-below':
        return { focus: insertRow(m, pos.row, true) };
      case 'row-del':
        return deleteRow(m, pos.row) && { focus: { row: Math.min(pos.row, m.rows.length - 1), col: pos.col } };
      case 'col-left':
        return { focus: { row: pos.row, col: insertCol(m, pos.col, false).col } };
      case 'col-right':
        return { focus: { row: pos.row, col: insertCol(m, pos.col, true).col } };
      case 'col-del':
        return deleteCol(m, pos.col) && { focus: { row: pos.row, col: Math.min(pos.col, m.cols.length - 1) } };
      case 'align-l':
      case 'align-c':
      case 'align-r':
        return { packages: setColAlign(m, pos.col, action.slice(-1) as Align) ? ['array'] : [] };
      case 'wrap': {
        if (colInfo(m.cols[pos.col] ?? { pre: '', core: 'l' }).width) return { packages: setColWidth(m, pos.col, null) ? ['array'] : [] };
        // Start from the column's current rendered width.
        const td = root.querySelector<HTMLElement>(`.ed[data-region="cell"][data-s="${m.rows[pos.row].cells[pos.index].start}"]`)?.closest('td');
        const frac = td ? Math.min(0.9, Math.max(0.1, Math.round((td.getBoundingClientRect().width / root.clientWidth) * 20) / 20)) : 0.3;
        return { packages: setColWidth(m, pos.col, `${frac}\\linewidth`) ? ['array'] : [] };
      }
      case 'rule-above':
        return { packages: toggleRule(m, pos.row) ? ['booktabs'] : [] };
      case 'rule-below':
        return { packages: toggleRule(m, pos.row + 1) ? ['booktabs'] : [] };
      case 'merge': {
        const s = selectedCells(m);
        return s && mergeCells(m, s.row, s.from, s.to) && { focus: { row: s.row, col: s.from } };
      }
      case 'split':
        return splitCell(m, pos.row, pos.col) && {};
    }
    return null;
  });
}

function setTableSetting(key: SettingKey, value: string | null) {
  flushWin();
  const cur = currentTable();
  const float = cur && ctx ? tableContainer(ctx.doc.blocks, cur.m) : undefined;
  if (!cur || float?.kind !== 'table') return;
  const edit = setFloatSetting(text, float, key, value);
  if (!edit) return;
  // Settings sit above the tabular, so the caret moves by the edit's length.
  commitTableEdit(edit, tableCaret! + edit.text.length - (edit.end - edit.start));
}

/** Converts between a table float and a longtable, keeping the caret in the same cell. */
function toggleLongtable(on: boolean) {
  flushWin();
  const cur = currentTable();
  if (!cur || !ctx) return;
  const { m, pos } = cur;
  const dataRow = m.rows.slice(0, pos.row).filter(isDataRow).length;
  let edit: TextEdit | null;
  if (on) {
    const float = tableContainer(ctx.doc.blocks, m);
    edit = float?.kind === 'table' ? floatToLongtable(text, float, m) : null;
  } else edit = m.env === 'longtable' ? longtableToFloat(text, m) : null;
  if (!edit) return;
  const newText = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const begin = newText.slice(edit.start).search(/\\begin\{(longtable|tabular)\}/);
  const nm = begin === -1 ? null : parseTable(newText, edit.start + begin);
  const row = nm?.rows.filter(isDataRow)[dataRow];
  const cell = row?.cells[Math.min(pos.index, row.cells.length - 1)];
  commitTableEdit(edit, cell ? cell.end : edit.start, on ? ['longtable'] : []);
}

/** Shows the table bar, grid and column handles for the table holding the caret. */
function updateTableUi() {
  const sel = window.getSelection();
  const reg = sel?.rangeCount && root.contains(sel.focusNode) ? regionOf(sel.focusNode) : null;
  if (reg?.dataset.region === 'cell' && !sourceEd) {
    tableCaret = caretSource() ?? Number(reg.dataset.s);
  } else if (!tableBar.contains(document.activeElement)) {
    tableCaret = null;
  }
  const cur = currentTable();
  root.querySelectorAll('.tab-active, .tab-cur').forEach((el) => el.classList.remove('tab-active', 'tab-cur'));
  resizeLayer.innerHTML = '';
  tableBar.hidden = !cur;
  if (!cur) return;
  const { m, pos } = cur;
  const td = root.querySelector<HTMLElement>(`.ed[data-region="cell"][data-s="${m.rows[pos.row].cells[pos.index].start}"]`)?.closest('td');
  const table = td?.closest<HTMLElement>('table.tabular');
  table?.classList.add('tab-active');
  td?.classList.add('tab-cur');

  const info = colInfo(m.cols[pos.col] ?? { pre: '', core: 'l' });
  const set = (t: string, on: boolean, disabled = false) => {
    const el = tableBar.querySelector<HTMLButtonElement | HTMLInputElement>(`[data-t="${t}"]`)!;
    if (el instanceof HTMLInputElement) el.checked = on;
    else el.classList.toggle('on', on);
    el.disabled = disabled;
  };
  const cell = m.rows[pos.row].cells[pos.index];
  const dataRows = m.rows.filter(isDataRow).length;
  for (const a of ['l', 'c', 'r']) set(`align-${a}`, info.align === a, !m.cols[pos.col]);
  set('wrap', !!info.width, !m.cols[pos.col] || m.cols[pos.col].core === 'X');
  set('rule-above', hasRule(m, pos.row));
  set('rule-below', hasRule(m, pos.row + 1));
  set('row-del', false, dataRows <= 1);
  set('col-del', false, m.cols.length <= 1);
  set('merge', false, !selectedCells(m));
  set('split', false, cell.span <= 1 && cell.mcSpec === undefined);
  set('booktabs', usesBooktabs(m));
  const container = ctx ? tableContainer(ctx.doc.blocks, m) : undefined;
  const inFloat = container?.kind === 'table';
  set('longtable', m.env === 'longtable', !(m.env === 'longtable' || (inFloat && m.env === 'tabular')));
  const settings = inFloat ? floatSettings(text, container!.innerStart!, container!.innerEnd!) : {};
  for (const key of ['size', 'stretch', 'colsep'] as const) {
    const sel = tableBar.querySelector<HTMLSelectElement>(`select[data-t="${key}"]`)!;
    const v = settings[key]?.value ?? '';
    if (v && ![...sel.options].some((o) => o.value === v)) sel.add(new Option(v, v));
    sel.value = v;
    sel.disabled = !inFloat;
    sel.title = inFloat ? sel.title.replace(/ —.*$/, '') : `${sel.title.replace(/ —.*$/, '')} — only for tables in a table float`;
  }
  if (table) drawResizers(m, table);
}

/** Drag handles on column edges; dragging gives the column a wrapping width. */
function drawResizers(m: TableModel, table: HTMLElement) {
  // Use a row of single cells so each td is one column.
  const tr = [...table.querySelectorAll('tr')].find((r) => r.children.length === m.cols.length && ![...r.children].some((c) => (c as HTMLTableCellElement).colSpan > 1));
  if (!tr) return;
  const pr = page.getBoundingClientRect();
  const tr0 = table.getBoundingClientRect();
  [...tr.children].forEach((cell, col) => {
    const r = cell.getBoundingClientRect();
    const h = document.createElement('div');
    h.className = 'col-resizer';
    h.title = 'Drag to set the column width (text wraps); double-click for natural width';
    Object.assign(h.style, { left: `${r.right - pr.left - 3}px`, top: `${tr0.top - pr.top}px`, height: `${tr0.height}px` });
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const tds = [...table.querySelectorAll('tr')].map((row) => row.children[col] as HTMLElement | undefined).filter((x): x is HTMLElement => !!x && (x as HTMLTableCellElement).colSpan === 1);
      const startX = e.clientX;
      const startW = r.width;
      let w = startW;
      const move = (ev: MouseEvent) => {
        w = Math.max(24, startW + ev.clientX - startX);
        tds.forEach((td) => (td.style.width = `${w}px`));
        h.style.left = `${r.left - pr.left + w - 3}px`;
        h.dataset.width = `${(w / root.clientWidth).toFixed(2)}\\linewidth`;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (Math.abs(w - startW) < 2) return;
        const frac = Math.min(1, Math.max(0.03, w / root.clientWidth)).toFixed(2);
        tableOp((mm) => ({ packages: setColWidth(mm, col, `${frac}\\linewidth`) ? ['array'] : [] }));
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    h.addEventListener('dblclick', () => tableOp((mm) => ({ packages: setColWidth(mm, col, null) ? ['array'] : [] })));
    resizeLayer.appendChild(h);
  });
}

document.addEventListener('selectionchange', () => updateTableUi());
window.addEventListener('resize', () => updateTableUi());

// ---------------------------------------------------------------------------
// Diagnostics from language servers (LTeX, cSpell…), drawn as underlines with
// the CSS Custom Highlight API so the editable DOM is never touched. Hovering
// one shows its message and the server's quick fixes.

type Severity = 'error' | 'warning' | 'info' | 'hint';
interface Diag {
  start: number;
  end: number;
  /** Source text the diagnostic covered when it was published (used to re-anchor it). */
  text: string;
  severity: Severity;
  message: string;
  source?: string;
  code?: string;
  /** Position in the host's list, for requesting quick fixes. */
  index: number;
}
interface Fix {
  title: string;
  preferred: boolean;
}

const SEVERITIES: Severity[] = ['error', 'warning', 'info', 'hint'];
const highlightsSupported = typeof CSS !== 'undefined' && 'highlights' in CSS;
let diags: Diag[] = [];
let diagBatch = 0;
/** DOM ranges of the drawn diagnostics, for hover hit-testing. */
let diagRanges: { d: Diag; range: Range }[] = [];

function onDiagnostics(batch: number, items: Omit<Diag, 'index'>[]) {
  diagBatch = batch;
  hideDiagPopup();
  diags = [];
  items.forEach((item, index) => {
    let { start, end } = item;
    // Offsets refer to the host's text: map them past keystrokes not yet sent.
    if (win) {
      const winEnd = win.start + win.hostLen;
      if (start >= winEnd) {
        start += win.len - win.hostLen;
        end += win.len - win.hostLen;
      } else if (end >= win.start) return;
    }
    // The server may have checked a slightly older text; look for the flagged words nearby.
    if (text.slice(start, end) !== item.text) {
      const k = text.indexOf(item.text, Math.max(0, start - 200));
      if (!item.text || k === -1 || Math.abs(k - start) > 200) return;
      end = k + item.text.length;
      start = k;
    }
    diags.push({ ...item, start, end, index });
  });
  drawDiagnostics();
}

/** Keeps diagnostics aligned with local edits (source [a, b) replaced by `inserted` characters); touched ones are dropped. */
function shiftDiagnostics(a: number, b: number, inserted: number) {
  if (!diags.length) return;
  const delta = inserted - (b - a);
  diags = diags.flatMap((d) => (d.end < a ? [d] : d.start > b ? [{ ...d, start: d.start + delta, end: d.end + delta }] : []));
}

function drawDiagnostics() {
  diagRanges = [];
  if (!highlightsSupported) return;
  const groups: Record<Severity, Range[]> = { error: [], warning: [], info: [], hint: [] };
  if (diags.length && ctx) {
    // Text runs never overlap, so sorted by start they are sorted by end too.
    const runs = [...root.querySelectorAll<HTMLElement>('.r[data-s]')]
      .map((el) => ({ el, s: Number(el.dataset.s), e: Number(el.dataset.e) }))
      .filter((r) => r.e > r.s && !r.el.closest('.editor'))
      .sort((x, y) => x.s - y.s);
    for (const d of diags) {
      let lo = 0;
      let hi = runs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (runs[mid].e <= d.start) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < runs.length && runs[k].s < d.end; k++) {
        const { el, s, e } = runs[k];
        const node = el.firstChild;
        if (!node || node.nodeType !== 3) continue;
        const len = node.textContent!.length;
        const from = Math.min(sourceToRunIndex(el, Math.max(d.start, s)), len);
        const to = Math.min(sourceToRunIndex(el, Math.min(d.end, e)), len);
        if (to <= from) continue;
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        groups[d.severity].push(range);
        diagRanges.push({ d, range });
      }
    }
  }
  for (const sev of SEVERITIES) CSS.highlights.set(`diag-${sev}`, new Highlight(...groups[sev]));
}

let fixSeq = 0;
const fixWaiters = new Map<number, (items: Fix[]) => void>();

function requestFixes(d: Diag): Promise<Fix[]> {
  flushWin();
  const id = ++fixSeq;
  return new Promise((resolve) => {
    fixWaiters.set(id, resolve);
    vscode.postMessage({ type: 'codeActions', id, batch: diagBatch, index: d.index });
  });
}

function diagAt(x: number, y: number): Diag | undefined {
  for (const { d, range } of diagRanges) {
    for (const r of range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom + 3) return d;
  }
  return undefined;
}

let diagPop: HTMLElement | null = null;
let popFor: Diag | null = null;
let hoverTimer: number | undefined;
let hoverFrame = 0;

root.addEventListener('mousemove', (e) => {
  if (!diagRanges.length || sourceEd || hoverFrame) return;
  const { clientX, clientY } = e;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const d = diagAt(clientX, clientY);
    if (d && d === popFor) return clearTimeout(hoverTimer);
    clearTimeout(hoverTimer);
    if (d) hoverTimer = window.setTimeout(() => showDiagPopup(d), popFor ? 80 : 350);
    else if (popFor) hoverTimer = window.setTimeout(hideDiagPopup, 300);
  });
});
root.addEventListener('mouseleave', () => {
  clearTimeout(hoverTimer);
  if (popFor) hoverTimer = window.setTimeout(hideDiagPopup, 300);
});
document.addEventListener('keydown', () => hideDiagPopup(), true);
window.addEventListener('scroll', () => hideDiagPopup(), true);

function showDiagPopup(d: Diag) {
  hideDiagPopup();
  const entry = diagRanges.find((r) => r.d === d);
  if (!entry) return;
  popFor = d;
  const pop = document.createElement('div');
  pop.className = `diag-pop sev-${d.severity}`;
  const origin = [d.source, d.code].filter(Boolean).join(' · ');
  pop.innerHTML = `<div class="diag-msg">${esc(d.message)}</div>${origin ? `<div class="diag-src">${esc(origin)}</div>` : ''}<div class="diag-fixes"><span class="diag-none">Looking for fixes…</span></div>`;
  pop.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  pop.addEventListener('mouseleave', () => (hoverTimer = window.setTimeout(hideDiagPopup, 300)));
  // Keep the caret in the text while clicking a fix.
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(pop);
  diagPop = pop;
  const rect = entry.range.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${rect.bottom + 4 + pop.offsetHeight > window.innerHeight ? Math.max(4, rect.top - pop.offsetHeight - 4) : rect.bottom + 4}px`;
  void requestFixes(d).then((fixes) => {
    if (popFor !== d) return;
    const box = pop.querySelector<HTMLElement>('.diag-fixes')!;
    box.innerHTML = fixes.length
      ? fixes.map((f, k) => `<button class="diag-fix${f.preferred ? ' preferred' : ''}" data-k="${k}">${esc(f.title)}</button>`).join('')
      : '<span class="diag-none">No quick fixes</span>';
    box.querySelectorAll<HTMLButtonElement>('.diag-fix').forEach((btn) =>
      btn.addEventListener('click', () => {
        hideDiagPopup();
        vscode.postMessage({ type: 'applyCodeAction', index: Number(btn.dataset.k) });
      }),
    );
  });
}

function hideDiagPopup() {
  clearTimeout(hoverTimer);
  diagPop?.remove();
  diagPop = null;
  popFor = null;
}

// ---------------------------------------------------------------------------
// Citation hover cards

let citePop: HTMLElement | null = null;
let citeFor: HTMLElement | null = null;
let citeTimer: number | undefined;

root.addEventListener('mouseover', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('a.cite[data-cite]');
  if (a === citeFor) return clearTimeout(citeTimer);
  clearTimeout(citeTimer);
  if (a && !sourceEd) citeTimer = window.setTimeout(() => showCitePopup(a), citeFor ? 80 : 300);
  else if (citeFor) citeTimer = window.setTimeout(hideCitePopup, 250);
});
root.addEventListener('mouseleave', () => {
  clearTimeout(citeTimer);
  if (citeFor) citeTimer = window.setTimeout(hideCitePopup, 250);
});
document.addEventListener('keydown', () => hideCitePopup(), true);
window.addEventListener('scroll', () => hideCitePopup(), true);

function showCitePopup(a: HTMLElement) {
  hideCitePopup();
  if (!root.contains(a)) return;
  const key = a.dataset.cite!;
  const entry = ctx?.bib.get(key);
  const pop = document.createElement('div');
  pop.className = `cite-pop${a.classList.contains('undef') ? ' undef' : ''}`;
  pop.innerHTML = entry && ctx ? bibCard(entry, ctx) : `<div class="bc-title">${esc(a.dataset.tip ?? key)}</div><div class="bc-key">${esc(key)}</div>`;
  pop.addEventListener('mouseenter', () => clearTimeout(citeTimer));
  pop.addEventListener('mouseleave', () => (citeTimer = window.setTimeout(hideCitePopup, 250)));
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(pop);
  citePop = pop;
  citeFor = a;
  const rect = a.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${rect.bottom + 4 + pop.offsetHeight > window.innerHeight ? Math.max(4, rect.top - pop.offsetHeight - 4) : rect.bottom + 4}px`;
}

function hideCitePopup() {
  clearTimeout(citeTimer);
  citePop?.remove();
  citePop = null;
  citeFor = null;
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
async function runTest(msg: any) {
  const reply = (data: unknown) => vscode.postMessage({ type: '__testResult', id: msg.id, data });
  try {
    if (msg.action === 'stats') return reply(collectStats(0));
    if (msg.action === 'html') return reply(root.innerHTML);
    if (msg.action === 'editBlock') {
      const els = [...root.querySelectorAll<HTMLElement>('.blk')].filter((el) => el.matches(msg.selector ?? '.blk'));
      const el = els[msg.index];
      if (!el) return reply({ error: 'no such block' });
      openEditor(el);
      const ed = sourceEd as SourceEditor | null;
      if (!ed) return reply({ error: 'editor did not open' });
      ed.ta.value = msg.replace ? msg.text : ed.ta.value + msg.text;
      ed.ta.dispatchEvent(new Event('input'));
      const preview = ed.preview.innerHTML;
      closeEditor();
      return reply({ ok: true, preview: stripTags(preview).slice(0, 200) });
    }
    if (msg.action === 'select') {
      // Selects from the start of `from` to the end of `to` in rendered text.
      const runs = [...root.querySelectorAll<HTMLElement>('.r')];
      const a = runs.find((r) => r.textContent!.includes(msg.from));
      const z = runs.find((r) => r.textContent!.includes(msg.to));
      if (!a || !z) return reply({ error: 'text not found' });
      const range = document.createRange();
      range.setStart(a.firstChild!, a.textContent!.indexOf(msg.from));
      range.setEnd(z.firstChild!, z.textContent!.indexOf(msg.to) + msg.to.length);
      (a.closest<HTMLElement>('[contenteditable="true"]') ?? root).focus();
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return reply({ ok: true, text: sel.toString() });
    }
    if (msg.action === 'caretAfter') {
      // Puts the caret after the first occurrence of `after` in rendered text (like a click there).
      const run = [...root.querySelectorAll<HTMLElement>('.r')].find((r) => r.textContent!.includes(msg.after));
      if (!run) return reply({ error: 'text not found' });
      const range = document.createRange();
      range.setStart(run.firstChild!, run.textContent!.indexOf(msg.after) + msg.after.length);
      range.collapse(true);
      (run.closest<HTMLElement>('[contenteditable="true"]') ?? root).focus();
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return reply({ ok: true, caret: caretSource() });
    }
    if (msg.action === 'typeAt') {
      // Puts the caret after the first occurrence of `after` in rendered text and types `text`.
      const run = [...root.querySelectorAll<HTMLElement>('.r')].find((r) => r.textContent!.includes(msg.after));
      if (!run) return reply({ error: 'text not found' });
      const range = document.createRange();
      range.setStart(run.firstChild!, run.textContent!.indexOf(msg.after) + msg.after.length);
      range.collapse(true);
      root.focus();
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      for (const ch of msg.text as string) {
        const r = sel.getRangeAt(0);
        const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true, targetRanges: [new StaticRange({ startContainer: r.startContainer, startOffset: r.startOffset, endContainer: r.endContainer, endOffset: r.endOffset })] });
        r.startContainer.parentElement!.dispatchEvent(ev);
      }
      flushWin();
      return reply({ ok: true, caret: caretSource() });
    }
    if (msg.action === 'diagnostics') {
      return reply({ supported: highlightsSupported, drawn: diagRanges.map((r) => ({ text: r.range.toString(), severity: r.d.severity, message: r.d.message })) });
    }
    if (msg.action === 'diagFixes') {
      const d = diagRanges[msg.index ?? 0]?.d;
      if (!d) return reply({ error: 'no such diagnostic' });
      const fixes = await requestFixes(d);
      if (msg.apply !== undefined) vscode.postMessage({ type: 'applyCodeAction', index: msg.apply });
      return reply({ fixes });
    }
    if (msg.action === 'files') {
      fileList = null;
      return reply(await new Promise<string[]>((resolve) => documentFiles(() => resolve(fileList!.files))));
    }
    if (msg.action === 'insert') {
      insertBlock(TEMPLATES[msg.template]);
      const open = !!sourceEd;
      closeEditor();
      return reply({ ok: open });
    }
  } catch (e) {
    reply({ error: String(e) });
  }
}

vscode.postMessage({ type: 'ready' });
