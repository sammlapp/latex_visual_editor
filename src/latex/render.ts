// Turns parsed blocks into HTML. Every block element carries data-start /
// data-end attributes with its source range so the webview can map clicks
// back to source text.

import katex from 'katex';
import { BibEntry, shortAuthors, splitAuthors } from './bib';
import { CITE_COMMANDS, Ctx, findSubfigures } from './context';
import { Block, ListItem, MATH_ENVS, parseBlocks } from './parser';
import {
  escapeHtml,
  findEnvEnd,
  isLetter,
  readArgs,
  readCommandName,
  readGroup,
  readOptional,
  skipComment,
  skipInlineSpace,
  splitTopLevel,
  stripComments,
  trimRange,
} from './util';

// ---------------------------------------------------------------------------
// Math

const mathCache = new Map<string, string>();

export function resolveMathRefs(src: string, ctx: Ctx): string {
  return src.replace(/\\(eqref|ref|autoref|cref|Cref)\s*\{([^}]*)\}/g, (_m, cmd, key) => {
    const l = ctx.labels.get(key.trim());
    const n = l ? l.num : '??';
    return `\\text{${cmd === 'eqref' ? `(${n})` : n}}`;
  });
}

export function renderKatex(src: string, display: boolean, ctx: Ctx): string {
  src = resolveMathRefs(src, ctx);
  const macrosKey = JSON.stringify(ctx.katexMacros);
  const key = `${display ? 'D' : 'I'}\u0000${macrosKey}\u0000${src}`;
  const hit = mathCache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(src, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'html',
      macros: { ...ctx.katexMacros },
    });
  } catch (e) {
    html = `<span class="math-error" title="${escapeHtml(String(e))}">${escapeHtml(src)}</span>`;
  }
  if (mathCache.size > 5000) mathCache.clear();
  mathCache.set(key, html);
  return html;
}

// ---------------------------------------------------------------------------
// Inline text

const SYMBOLS: Record<string, string> = {
  ldots: '…', dots: '…', textellipsis: '…', LaTeX: 'L<span class="tex-a">a</span>T<span class="tex-e">e</span>X',
  TeX: 'T<span class="tex-e">e</span>X', LaTeXe: 'L<span class="tex-a">a</span>T<span class="tex-e">e</span>X 2ε', S: '§', P: '¶',
  dag: '†', ddag: '‡', textdagger: '†', textdaggerdbl: '‡', copyright: '©', textcopyright: '©', textregistered: '®',
  texttrademark: '™', pounds: '£', textsterling: '£', euro: '€', texteuro: '€', textbackslash: '\\', textasciitilde: '~',
  textasciicircum: '^', textbar: '|', textless: '&lt;', textgreater: '&gt;', textendash: '–', textemdash: '—',
  textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”', textbullet: '•',
  textdegree: '°', textperiodcentered: '·', textunderscore: '_', quad: '\u2003', qquad: '\u2003\u2003', ss: 'ß',
  ae: 'æ', AE: 'Æ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', aa: 'å', AA: 'Å', i: 'ı', j: 'ȷ', oe: 'œ', OE: 'Œ',
  checkmark: '✓', textasciigrave: '`', slash: '/', enspace: '\u2002', thinspace: '\u2009', textvisiblespace: '␣',
  textsection: '§', textparagraph: '¶', ell: 'ℓ', textmu: 'µ', times: '×', textpm: '±', textminus: '−',
  newline: '<br>', linebreak: '<br>', par: '<br>', hfill: '<span class="hfill"></span>', dotfill: ' … ',
  space: ' ', textcompwordmark: '', nobreakspace: '&nbsp;',
};

/** No-op layout commands that take no arguments. */
const IGNORED = new Set([
  'noindent', 'indent', 'centering', 'raggedright', 'raggedleft', 'protect', 'relax', 'null', 'smallskip', 'medskip',
  'bigskip', 'nopagebreak', 'pagebreak', 'newpage', 'clearpage', 'vfill', 'hline', 'toprule', 'midrule', 'bottomrule',
  'maketitle', 'leavevmode', 'sloppy', 'fussy', 'strut', 'xspace', 'unskip', 'ignorespaces', 'nolinebreak', 'allowbreak',
  'frenchspacing', 'nonfrenchspacing', 'normalsize', 'selectfont', 'onecolumn', 'twocolumn', 'item', 'tightlist', 'and',
  'phantomsection', 'FloatBarrier', 'appendix', 'endinput',
]);

/** Commands whose arguments are swallowed without output. */
const SWALLOW: Record<string, number> = {
  vspace: 1, label: 1, hypertarget: 1, phantom: 1, hphantom: 1, vphantom: 1, index: 1, glossary: 1, nocite: 1,
  bibliographystyle: 1, addcontentsline: 3, setlength: 2, addtolength: 2, setcounter: 2, addtocounter: 2,
  pagestyle: 1, thispagestyle: 1, graphicspath: 1, usepackage: 1, documentclass: 1, newcommand: 2, renewcommand: 2,
  providecommand: 2, DeclareMathOperator: 2, newtheorem: 2, captionsetup: 1, setstretch: 1, marginpar: 1,
  input: 1, include: 1, bibliography: 1, addbibresource: 1, title: 1, author: 1, date: 1,
};

const STYLE_SWITCH: Record<string, string> = {
  bfseries: 'font-weight:bold', bf: 'font-weight:bold', itshape: 'font-style:italic', it: 'font-style:italic',
  em: 'font-style:italic', slshape: 'font-style:oblique', sl: 'font-style:oblique', ttfamily: 'font-family:var(--mono)',
  tt: 'font-family:var(--mono)', scshape: 'font-variant:small-caps', sc: 'font-variant:small-caps',
  sffamily: 'font-family:var(--sans)', sf: 'font-family:var(--sans)', rmfamily: 'font-family:var(--serif)', rm: 'font-family:var(--serif)',
  upshape: 'font-style:normal', mdseries: 'font-weight:normal', normalfont: 'font-weight:normal;font-style:normal',
  tiny: 'font-size:0.5em', scriptsize: 'font-size:0.7em', footnotesize: 'font-size:0.8em', small: 'font-size:0.9em',
  large: 'font-size:1.2em', Large: 'font-size:1.44em', LARGE: 'font-size:1.73em', huge: 'font-size:2.07em', Huge: 'font-size:2.49em',
};

const TEXT_STYLE: Record<string, [string, string]> = {
  textbf: ['<strong>', '</strong>'],
  textit: ['<em>', '</em>'],
  emph: ['<em>', '</em>'],
  textsl: ['<em class="sl">', '</em>'],
  texttt: ['<code>', '</code>'],
  underline: ['<u>', '</u>'],
  uline: ['<u>', '</u>'],
  sout: ['<s>', '</s>'],
  st: ['<s>', '</s>'],
  textsc: ['<span class="sc">', '</span>'],
  textsf: ['<span class="sf">', '</span>'],
  textrm: ['<span class="rm">', '</span>'],
  textup: ['<span class="up">', '</span>'],
  textmd: ['<span class="md">', '</span>'],
  textnormal: ['<span class="rm">', '</span>'],
  textsuperscript: ['<sup>', '</sup>'],
  textsubscript: ['<sub>', '</sub>'],
  mbox: ['<span class="nowrap">', '</span>'],
  hbox: ['<span class="nowrap">', '</span>'],
  makebox: ['<span class="nowrap">', '</span>'],
  text: ['', ''],
  enquote: ['“', '”'],
  fbox: ['<span class="fbox">', '</span>'],
  framebox: ['<span class="fbox">', '</span>'],
  caption: ['', ''],
  centerline: ['<span class="centerline">', '</span>'],
  footnotetext: ['', ''],
  textnhtt: ['<code>', '</code>'],
};

const SYMBOL_ACCENTS: Record<string, string> = {
  "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307',
};
const LETTER_ACCENTS: Record<string, string> = {
  u: '\u0306', v: '\u030C', H: '\u030B', c: '\u0327', k: '\u0328', r: '\u030A', b: '\u0331', d: '\u0323',
};

const REF_NAMES: Record<string, [string, string]> = {
  // kind → [cref, Cref/autoref]
  equation: ['eq.', 'Equation'],
  figure: ['fig.', 'Figure'],
  table: ['tab.', 'Table'],
  section: ['section', 'Section'],
  theorem: ['theorem', 'Theorem'],
  item: ['item', 'Item'],
  other: ['', ''],
};

interface InlineState {
  ctx: Ctx;
  depth: number;
  footnotes: string[];
  /**
   * True when `t` is the document text itself. Output then carries source
   * offsets (data-s/data-e on text runs and formatting, data-start/data-end on
   * atomic "islands") so the webview can map the caret back to the source.
   */
  mapped: boolean;
}

interface CmdResult {
  html: string;
  end: number;
  /** A style switch (\bfseries): html is an open <span> covering the rest of the group. */
  switchOpen?: boolean;
}

/** One rendered piece of a plain-text run and the source range it came from. */
export interface RunToken {
  out: string;
  s: number;
  e: number;
}

const RUN_ESCAPES = '%&$#_{}';

const deeper = (st: InlineState): InlineState => ({ ...st, depth: st.depth + 1 });

/**
 * Scans a maximal run of "plain" text starting at i: characters, escapes like
 * \%, dashes, quotes, ties, accents and simple symbol commands. Runs are
 * rendered as editable text; the same function maps caret positions back to
 * source offsets in the webview, so both always agree.
 */
export function scanRun(t: string, i: number, e: number, ctx: Ctx): RunToken[] {
  const tokens: RunToken[] = [];
  while (i < e) {
    const c = t[i];
    let out: string | null = null;
    let j = i + 1;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      while (j < e && (t[j] === ' ' || t[j] === '\t' || t[j] === '\r' || t[j] === '\n')) j++;
      out = ' ';
    } else if (c === '-') {
      if (i + 3 <= e && t.startsWith('---', i)) {
        out = '—';
        j = i + 3;
      } else if (i + 2 <= e && t.startsWith('--', i)) {
        out = '–';
        j = i + 2;
      } else out = '-';
    } else if (c === '`') {
      if (i + 2 <= e && t[i + 1] === '`') {
        out = '“';
        j = i + 2;
      } else out = '‘';
    } else if (c === "'") {
      if (i + 2 <= e && t[i + 1] === "'") {
        out = '”';
        j = i + 2;
      } else out = '’';
    } else if (c === '~') {
      out = ' ';
    } else if (c === '\\') {
      const r = runCommand(t, i, e, ctx);
      if (r) {
        out = r.out;
        j = r.end;
      }
    } else if (c !== '$' && c !== '{' && c !== '}' && c !== '%') {
      out = c;
    }
    if (out === null) break;
    tokens.push({ out, s: i, e: j });
    i = j;
  }
  return tokens;
}

function runCommand(t: string, i: number, e: number, ctx: Ctx): { out: string; end: number } | null {
  if (i + 1 >= e) return null;
  const nx = t[i + 1];
  if (RUN_ESCAPES.includes(nx)) return { out: nx, end: i + 2 };
  if (nx === ' ' || nx === '\n') return { out: ' ', end: i + 2 };
  if (nx === ',') return { out: ' ', end: i + 2 };
  if (nx === ';' || nx === ':' || nx === '>') return { out: ' ', end: i + 2 };
  if (nx === '@' || nx === '/' || nx === '-' || nx === '!') return { out: '', end: i + 2 };
  if (nx in SYMBOL_ACCENTS) return accentAt(t, i + 2, e, SYMBOL_ACCENTS[nx]);
  if (!isLetter(nx)) return null;
  const name = readCommandName(t, i);
  const after = i + 1 + name.length;
  if (after > e || ctx.textMacros.has(name)) return null;
  if (name in LETTER_ACCENTS && t[after] === '{') return accentAt(t, after, e, LETTER_ACCENTS[name]);
  const sym = SYMBOLS[name];
  if (sym !== undefined && !/[<&]/.test(sym)) {
    let j = after;
    if (j + 2 <= e && t[j] === '{' && t[j + 1] === '}') j += 2;
    else j = skipInlineSpace(t, j, e);
    return { out: sym, end: j };
  }
  if (IGNORED.has(name)) return { out: '', end: skipInlineSpace(t, after, e) };
  return null;
}

function accentAt(t: string, j: number, e: number, mark: string): { out: string; end: number } | null {
  let base = '';
  if (t[j] === '{') {
    const g = readGroup(t, j, e);
    if (!g) return null;
    base = t.slice(g.innerStart, g.innerEnd).trim();
    j = g.end;
  } else if (t[j] === '\\') {
    const nm = readCommandName(t, j);
    base = '\\' + nm;
    j += 1 + nm.length;
  } else if (j < e && /\S/.test(t[j])) {
    base = t[j];
    j++;
  } else return null;
  if (base === '\\i' || base === 'ı') base = 'i';
  else if (base === '\\j' || base === 'ȷ') base = 'j';
  else if (base.startsWith('\\')) base = SYMBOLS[base.slice(1)] ?? '';
  return { out: (base + mark).normalize('NFC'), end: j };
}

/** Unmapped rendering of a LaTeX snippet (bib fields, labels, previews). */
export function renderInline(src: string, ctx: Ctx, footnotes: string[] = []): string {
  return inline(src, 0, src.length, { ctx, depth: 0, footnotes, mapped: false });
}

/** Trims a region like trimRange, but keeps spaces typed at the end of a line. */
export function regionTrim(t: string, s: number, e: number): { start: number; end: number } {
  const r = trimRange(t, s, e);
  let end = r.end;
  while (end < e && (t[end] === ' ' || t[end] === '\t')) end++;
  return { start: r.start, end: r.start === r.end ? r.start : end };
}

/**
 * An editable text region (paragraph, heading title, caption, table cell...)
 * whose content maps to source [s, e). `prefix` is inserted before text typed
 * into an empty region (e.g. a space after \item).
 */
function region(t: string, s: number, e: number, ctx: Ctx, footnotes: string[], kind: string, tag = 'span', cls = '', prefix = ''): string {
  const r = regionTrim(t, s, e);
  const inner = inline(t, r.start, r.end, { ctx, depth: 0, footnotes, mapped: true });
  const pre = prefix ? ` data-prefix="${escapeHtml(prefix)}"` : '';
  return `<${tag} class="ed${cls ? ' ' + cls : ''}" contenteditable="true" data-region="${kind}" data-s="${r.start}" data-e="${r.end}"${pre}>${inner || '<br>'}</${tag}>`;
}

function islandHtml(st: InlineState, html: string, a: number, b: number, cls = ''): string {
  if (!st.mapped) return html;
  return `<span class="isl${cls ? ' ' + cls : ''}" contenteditable="false" data-start="${a}" data-end="${b}">${html}</span>`;
}

/**
 * A zero-width text anchor mapped to source offset `at`. Browsers cannot put
 * the caret next to a non-editable island unless there is a text node there,
 * so anchors go before/after islands that have no neighbouring text run.
 */
const anchor = (at: number) => `<span class="r anchor" data-s="${at}" data-e="${at}">\u200b</span>`;

function inline(t: string, s: number, e: number, st: InlineState): string {
  if (st.depth > 40) return escapeHtml(t.slice(s, e));
  let out = '';
  let i = s;
  /** Kind of the last emitted piece: plain text run, island, or other markup (formatting, groups). */
  let prev: 'none' | 'run' | 'island' | 'other' = 'none';
  while (i < e) {
    const run = scanRun(t, i, e, st.ctx);
    if (run.length) {
      const end = run[run.length - 1].e;
      const text = escapeHtml(run.map((r) => r.out).join(''));
      out += st.mapped ? `<span class="r" data-s="${i}" data-e="${end}">${text}</span>` : text;
      i = end;
      prev = 'run';
      continue;
    }
    const [html, next, stop] = inlineStep(t, i, e, st);
    if (html) {
      const kind = st.mapped && html.startsWith('<span class="isl') ? 'island' : 'other';
      // Islands need a text position beside them for the caret wherever no text run is adjacent.
      if (st.mapped && ((kind === 'island' && prev !== 'run') || (kind === 'other' && prev === 'island'))) out += anchor(i);
      out += html;
      prev = kind;
    }
    i = next;
    if (stop) break;
  }
  if (prev === 'island') out += anchor(e);
  return out;
}

/** Renders one non-run construct at i. Returns [html, nextIndex, stop] (stop: a style switch consumed the rest). */
function inlineStep(t: string, i: number, e: number, st: InlineState): [string, number, boolean] {
  {
    const c = t[i];
    if (c === '%') {
      // TeX drops the comment, its newline and the next line's indentation.
      let j = skipComment(t, i, e);
      if (j < e) {
        j++;
        while (j < e && (t[j] === ' ' || t[j] === '\t')) j++;
      }
      return ['', j, false];
    }
    if (c === '$') {
      if (t[i + 1] === '$') {
        const close = t.indexOf('$$', i + 2);
        const end = close === -1 || close > e ? e : close;
        return [islandHtml(st, renderKatex(t.slice(i + 2, end), true, st.ctx), i, Math.min(end + 2, e), 'math'), end + 2, false];
      }
      let j = i + 1;
      for (; j < e; j++) {
        if (t[j] === '\\') {
          j++;
          continue;
        }
        if (t[j] === '$') break;
      }
      return [islandHtml(st, renderKatex(t.slice(i + 1, Math.min(j, e)), false, st.ctx), i, Math.min(j + 1, e), 'math'), j + 1, false];
    }
    if (c === '{') {
      const g = readGroup(t, i, e);
      if (!g) return ['', i + 1, false];
      const inner = inline(t, g.innerStart, g.innerEnd, deeper(st));
      return [st.mapped ? `<span data-s="${g.start}" data-e="${g.end}">${inner}</span>` : inner, g.end, false];
    }
    if (c === '}') return ['', i + 1, false];
    // A backslash that did not start a plain-text run.
    const name = readCommandName(t, i);
    if (name === '') return ['', i + 1, false];
    const after = i + 1 + name.length;
    const r = isLetter(name[0]) ? wordCommand(t, i, name, after, e, st) : symbolCommand(t, i, name, after, e, st);
    if (r.switchOpen) return [r.html + inline(t, r.end, e, deeper(st)) + '</span>', e, true];
    return [r.html, Math.max(r.end, i + 1), false];
  }
}

function symbolCommand(t: string, start: number, name: string, after: number, e: number, st: InlineState): CmdResult {
  switch (name) {
    case '\\': {
      let j = after;
      if (t[j] === '*') j++;
      const k = skipInlineSpace(t, j, e);
      if (t[k] === '[') {
        const g = readOptional(t, k, e);
        if (g) j = g.end;
      }
      j = skipInlineSpace(t, j, e);
      return { html: st.mapped ? `<br data-s="${start}" data-e="${j}">` : '<br>', end: j };
    }
    case '(': {
      const close = t.indexOf('\\)', after);
      const end = close === -1 || close > e ? e : close;
      return { html: islandHtml(st, renderKatex(t.slice(after, end), false, st.ctx), start, Math.min(end + 2, e), 'math'), end: end + 2 };
    }
    case '[': {
      const close = t.indexOf('\\]', after);
      const end = close === -1 || close > e ? e : close;
      return { html: islandHtml(st, renderKatex(t.slice(after, end), true, st.ctx), start, Math.min(end + 2, e), 'math'), end: end + 2 };
    }
  }
  return { html: islandHtml(st, escapeHtml(name), start, after), end: after };
}

function wordCommand(t: string, start: number, name: string, after: number, e: number, st: InlineState): CmdResult {
  const ctx = st.ctx;
  const sub = (g: { innerStart: number; innerEnd: number }) => inline(t, g.innerStart, g.innerEnd, deeper(st));
  const arg = (g: { innerStart: number; innerEnd: number }) => t.slice(g.innerStart, g.innerEnd);
  const island = (html: string, end: number, cls = ''): CmdResult => ({ html: islandHtml(st, html, start, end, cls), end });
  /** Editable formatting: the element carries the command's full source range. */
  const fmt = (open: string, close: string, inner: string, end: number): CmdResult => {
    if (!st.mapped) return { html: open + inner + close, end };
    const attr = ` data-s="${start}" data-e="${end}"`;
    if (open.startsWith('<')) return { html: open.replace(/^<([a-z0-9]+)/, `<$1${attr}`) + inner + close, end };
    return { html: `<span${attr}>${open}${inner}${close}</span>`, end };
  };

  // User-defined macros take precedence over built-ins; their expansion has no
  // source offsets, so it is rendered as an island.
  const macro = ctx.textMacros.get(name);
  if (macro && st.depth < 30) {
    let j = after;
    const vals: string[] = [];
    let nargs = macro.nargs;
    if (macro.optDefault !== undefined) {
      const k = skipInlineSpace(t, j, e);
      const o = t[k] === '[' ? readOptional(t, k, e) : null;
      vals.push(o ? arg(o) : macro.optDefault);
      if (o) j = o.end;
      nargs--;
    }
    for (let a = 0; a < nargs; a++) {
      const k = skipInlineSpace(t, j, e);
      const g = readGroup(t, k, e);
      if (g) {
        vals.push(arg(g));
        j = g.end;
      } else if (k < e) {
        vals.push(t[k]);
        j = k + 1;
      }
    }
    const body = macro.body.replace(/#(\d)/g, (_m, d) => vals[Number(d) - 1] ?? '');
    if (nargs === 0 && macro.optDefault === undefined) j = skipInlineSpace(t, j, e);
    return island(inline(body, 0, body.length, { ...deeper(st), mapped: false }), j, 'macro');
  }

  if (name in STYLE_SWITCH) {
    const end = skipInlineSpace(t, after, e);
    return { html: `<span style="${STYLE_SWITCH[name]}"${st.mapped ? ` data-s="${start}" data-e="${e}"` : ''}>`, end, switchOpen: true };
  }

  if (name === 'color') {
    const a = readArgs(t, after, 1, e, 1);
    const col = a.required[0] ? arg(a.required[0]) : '';
    return { html: `<span style="color:${cssColor(col)}"${st.mapped ? ` data-s="${start}" data-e="${e}"` : ''}>`, end: a.end, switchOpen: true };
  }

  if (name in TEXT_STYLE) {
    const a = readArgs(t, after, 1, e, 1);
    if (!a.required[0]) return { html: '', end: a.end };
    const [open, close] = TEXT_STYLE[name];
    return fmt(open || '<span>', close || '</span>', sub(a.required[0]), a.end);
  }

  if (name in LETTER_ACCENTS) {
    const r = accentAt(t, skipInlineSpace(t, after, e), e, LETTER_ACCENTS[name]);
    if (r) return island(escapeHtml(r.out), r.end);
  }

  if (name in SYMBOLS) {
    let j = after;
    if (t[j] === '{' && t[j + 1] === '}') j += 2;
    else j = skipInlineSpace(t, j, e);
    const sym = SYMBOLS[name];
    if (sym === '<br>') return { html: st.mapped ? `<br data-s="${start}" data-e="${j}">` : sym, end: j };
    return island(sym, j);
  }

  if (name === 'today') {
    const d = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    return island(d, skipInlineSpace(t, after, e));
  }

  if (IGNORED.has(name)) return { html: '', end: skipInlineSpace(t, after, e) };

  if (name in SWALLOW) {
    if (name === 'newcommand' || name === 'renewcommand' || name === 'providecommand') {
      let j = skipInlineSpace(t, after, e);
      if (t[j] === '\\') j += 1 + readCommandName(t, j).length;
      return { html: '', end: readArgs(t, j, 2, e).end };
    }
    return { html: '', end: readArgs(t, after, SWALLOW[name], e).end };
  }

  if (name === 'hspace' || name === 'hskip' || name === 'kern') {
    const a = readArgs(t, after, 1, e);
    return island(' ', a.end);
  }

  if (name === 'textcolor') {
    const a = readArgs(t, after, 2, e, 1);
    if (a.required.length < 2) return { html: '', end: a.end };
    return fmt(`<span style="color:${cssColor(arg(a.required[0]))}">`, '</span>', sub(a.required[1]), a.end);
  }
  if (name === 'colorbox' || name === 'highlight' || name === 'hl') {
    const a = readArgs(t, after, name === 'colorbox' ? 2 : 1, e, 1);
    const content = a.required[a.required.length - 1];
    const col = name === 'colorbox' && a.required[0] ? cssColor(arg(a.required[0])) : 'rgba(255,230,0,.45)';
    return content ? fmt(`<span style="background:${col}">`, '</span>', sub(content), a.end) : { html: '', end: a.end };
  }

  if (name === 'ensuremath') {
    const a = readArgs(t, after, 1, e);
    return island(a.required[0] ? renderKatex(arg(a.required[0]), false, ctx) : '', a.end, 'math');
  }

  if (name === 'url' || name === 'nolinkurl' || name === 'path') {
    const g = readGroup(t, skipInlineSpace(t, after, e), e);
    if (!g) return { html: '', end: after };
    const u = arg(g);
    return island(`<a class="url" href="${escapeHtml(u)}" data-external="1">${escapeHtml(u)}</a>`, g.end);
  }
  if (name === 'href') {
    const a = readArgs(t, after, 2, e);
    if (a.required.length < 2) return { html: '', end: a.end };
    const txt = renderInline(arg(a.required[1]), ctx);
    return island(`<a class="url" href="${escapeHtml(arg(a.required[0]))}" data-external="1">${txt}</a>`, a.end);
  }

  if (name === 'footnote' || name === 'thanks') {
    const a = readArgs(t, after, 1, e, 1);
    if (!a.required[0]) return { html: '', end: a.end };
    const num = ++ctx.footnote;
    const g = a.required[0];
    const body = st.mapped ? region(t, g.innerStart, g.innerEnd, ctx, st.footnotes, 'fn') : sub(g);
    st.footnotes.push(`<div class="footnote"><sup contenteditable="false">${num}</sup> ${body}</div>`);
    return island(`<sup class="fn" title="${escapeHtml(stripTags(body))}">${num}</sup>`, a.end, 'fnmark');
  }

  if (name === 'verb' || name === 'verb*') {
    const delim = t[after];
    const close = t.indexOf(delim, after + 1);
    const end = close === -1 || close >= e ? e : close;
    return island(`<code>${escapeHtml(t.slice(after + 1, end))}</code>`, end + 1);
  }

  if (name === 'ref' || name === 'eqref' || name === 'autoref' || name === 'cref' || name === 'Cref' || name === 'pageref' ||
      name === 'nameref' || name === 'vref' || name === 'Autoref' || name === 'cpageref') {
    const a = readArgs(t, after, 1, e, 0);
    if (!a.required[0]) return { html: '', end: a.end };
    return island(renderRef(name, arg(a.required[0]), ctx), a.end, 'refisl');
  }

  if (CITE_COMMANDS.has(name)) {
    const a = readArgs(t, after, 1, e, 2);
    if (!a.required[0]) return { html: '', end: a.end };
    const opts = a.optional.map((g) => renderInline(arg(g), ctx));
    return island(renderCite(name, arg(a.required[0]), opts, ctx), a.end, 'refisl');
  }

  if (name === 'includegraphics') {
    const a = readArgs(t, after, 1, e, 1);
    if (!a.required[0]) return { html: '', end: a.end };
    return island(renderGraphic(arg(a.required[0]).trim(), a.optional[0] ? arg(a.optional[0]) : '', ctx), a.end);
  }

  if (name === 'begin') {
    // Inline environments inside paragraphs/cells (e.g. a tabular in a cell).
    const g = readGroup(t, after, e);
    if (g) {
      const env = arg(g).trim();
      const f = findEnvEnd(t, g.end, env, e);
      const innerEnd = f ? f.innerEnd : e;
      const end = f ? f.end : e;
      if (MATH_ENVS.has(env)) {
        const base = env.replace('*', '');
        const body = t.slice(g.end, innerEnd);
        const src = ['align', 'gather', 'alignat'].includes(base) ? `\\begin{${base}*}${body}\\end{${base}*}` : body;
        return island(renderKatex(src, true, ctx), end, 'math');
      }
      if (env === 'tabular' || env === 'tabular*' || env === 'tabularx' || env === 'array') {
        return island(renderTabular(t, g.end, innerEnd, env, ctx, st.footnotes, false), end);
      }
      const inner = inline(t, g.end, innerEnd, { ...deeper(st), mapped: false });
      return island(env === 'center' ? `<span class="centerline">${inner}</span>` : inner, end);
    }
  }
  if (name === 'end') {
    const g = readGroup(t, after, e);
    return { html: '', end: g ? g.end : after };
  }

  if (name === 'multicolumn' || name === 'multirow') {
    const a = readArgs(t, after, 3, e);
    const content = a.required[2];
    return content ? fmt('<span>', '</span>', sub(content), a.end) : { html: '', end: a.end };
  }

  if (name === 'item') return island('• ', skipInlineSpace(t, after, e));

  // Unknown command: keep its argument text visible (and editable), dimmed.
  const a = readArgs(t, after, 4, e, 1);
  if (a.required.length === 0) {
    return island(`<span class="unknown-cmd" title="Unrendered command">\\${escapeHtml(name)}</span>`, skipInlineSpace(t, a.end, e));
  }
  const inner = a.required.map((g) => sub(g)).join(' ');
  return fmt(`<span class="unknown-cmd-args" title="\\${escapeHtml(name)}">`, '</span>', inner, a.end);
}

function cssColor(c: string): string {
  c = c.trim();
  if (/^[a-zA-Z]+$/.test(c)) return c;
  const m = /^([a-zA-Z]+)!(\d+)/.exec(c);
  if (m) return `color-mix(in srgb, ${m[1]} ${m[2]}%, transparent)`;
  return 'inherit';
}

export function stripTags(html: string): string {
  return html
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u200b/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderRef(cmd: string, keys: string, ctx: Ctx): string {
  const parts = keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((key) => {
      const l = ctx.labels.get(key);
      if (!l) return `<a class="ref undef" title="Undefined reference: ${escapeHtml(key)}">??</a>`;
      let txt = l.num;
      if (cmd === 'eqref') txt = `(${txt})`;
      else if (cmd === 'cref' || cmd === 'Cref' || cmd === 'autoref' || cmd === 'Autoref') {
        const names = REF_NAMES[l.kind] ?? ['', ''];
        const word = cmd === 'cref' ? names[0] : names[1];
        if (word) txt = `${word}&nbsp;${l.kind === 'equation' && cmd !== 'autoref' ? `(${txt})` : txt}`;
      }
      return `<a class="ref" data-goto="${l.target}" title="${escapeHtml(key)}">${txt}</a>`;
    });
  return parts.join(', ');
}

function renderCite(cmd: string, keysSrc: string, opts: string[], ctx: Ctx): string {
  if (cmd === 'nocite') return '';
  const keys = keysSrc.split(',').map((k) => k.trim()).filter(Boolean);
  const link = (key: string, text: string) => {
    const entry = ctx.bib.get(key);
    const known = entry || ctx.bibitemText.has(key);
    const tip = entry ? bibPlain(entry) : ctx.bibitemText.has(key) ? stripTags(renderInline(ctx.text.slice(ctx.bibitemText.get(key)!.start, ctx.bibitemText.get(key)!.end), ctx)) : `Citation key not found: ${key}`;
    return `<a class="cite${known ? '' : ' undef'}" data-cite="${escapeHtml(key)}" title="${escapeHtml(tip)}">${text}</a>`;
  };
  const num = (key: string) => String(ctx.cites.get(key) ?? '?');
  // natbib: \citep[pre][post]{k}; a single optional arg is the postnote.
  const pre = opts.length >= 2 ? opts[0] : '';
  const post = opts.length >= 2 ? opts[1] : opts[0] ?? '';
  const wrap = (inner: string) => `[${pre ? pre + ' ' : ''}${inner}${post ? ', ' + post : ''}]`;

  switch (cmd) {
    case 'citet':
    case 'Citet':
    case 'textcite':
      return keys
        .map((k) => {
          const e = ctx.bib.get(k);
          const who = e ? escapeHtml(stripBraces(shortAuthors(e))) : escapeHtml(k);
          return `${who} ${link(k, wrap(num(k)))}`;
        })
        .join(', ');
    case 'citeauthor':
      return keys.map((k) => link(k, ctx.bib.get(k) ? escapeHtml(stripBraces(shortAuthors(ctx.bib.get(k)!))) : escapeHtml(k))).join(', ');
    case 'citeyear':
      return keys.map((k) => link(k, escapeHtml(ctx.bib.get(k)?.fields.year ?? '?'))).join(', ');
    case 'citenum':
      return keys.map((k) => link(k, num(k))).join(', ');
    default:
      return `<span class="cite-group">${wrap(keys.map((k) => link(k, num(k))).join(', '))}</span>`;
  }
}

function stripBraces(s: string): string {
  return s.replace(/[{}]/g, '');
}

function bibPlain(e: BibEntry): string {
  const f = e.fields;
  const authors = splitAuthors(f.author ?? f.editor ?? '').join(', ');
  return stripBraces([authors, f.title, f.journal ?? f.booktitle ?? f.publisher, f.year].filter(Boolean).join('. '));
}

// ---------------------------------------------------------------------------
// Graphics

const UNIT_PX: Record<string, number> = { pt: 1.333, bp: 1.333, cm: 37.8, mm: 3.78, in: 96, em: 16, ex: 8, px: 1, pc: 16 };

/** Converts a TeX length to CSS (relative widths become percentages). */
export function texLengthToCss(v: string): string | undefined {
  v = v.trim();
  const m = /^([\d.]*)\s*\\(textwidth|linewidth|columnwidth|hsize|paperwidth|textheight)$/.exec(v);
  if (m) {
    const f = m[1] === '' ? 1 : parseFloat(m[1]);
    return m[2] === 'textheight' ? `${Math.round(f * 900)}px` : `${+(f * 100).toFixed(2)}%`;
  }
  const u = /^([\d.]+)\s*([a-z]{2})$/.exec(v);
  if (u && UNIT_PX[u[2]]) return `${Math.round(parseFloat(u[1]) * UNIT_PX[u[2]])}px`;
  return undefined;
}

function parseKeyVals(opts: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of opts.split(',')) {
    const [k, ...v] = part.split('=');
    if (k.trim()) out[k.trim()] = v.join('=').trim();
  }
  return out;
}

/** A graphic inside a float: clicking it edits the \includegraphics command. */
function graphicIsland(path: string, opts: string, ctx: Ctx): string {
  return renderGraphic(path, opts, ctx);
}

export function renderGraphic(path: string, opts: string, ctx: Ctx): string {
  const kv = parseKeyVals(opts);
  const styles: string[] = [];
  if (kv.width) {
    const w = texLengthToCss(kv.width);
    if (w) styles.push(`width:${w}`);
  } else if (kv.scale) {
    styles.push(`width:${Math.min(100, parseFloat(kv.scale) * 100)}%`);
  }
  if (kv.height) {
    const h = texLengthToCss(kv.height);
    if (h && !h.endsWith('%')) styles.push(`height:${h}`);
  }
  if (kv.angle) styles.push(`transform:rotate(${-parseFloat(kv.angle)}deg)`);
  const style = styles.length ? ` style="${styles.join(';')}"` : '';
  const info = ctx.host.images[path];
  const p = escapeHtml(path);
  if (!info) return `<span class="graphic placeholder"${style} data-graphic="${p}">${p}</span>`;
  switch (info.kind) {
    case 'image':
      return `<img class="graphic" src="${escapeHtml(info.uri!)}" alt="${p}"${style}>`;
    case 'pdf':
      return `<img class="graphic pdf-graphic" data-pdf="${escapeHtml(info.uri!)}" alt="${p}"${style}>`;
    case 'unsupported':
      return `<span class="graphic placeholder"${style} title="${escapeHtml(info.resolved ?? path)}">Preview not available for ${escapeHtml(info.resolved ?? path)}</span>`;
    default:
      return `<span class="graphic placeholder missing"${style} title="File not found">Image not found: ${p}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Tables

interface ColSpec {
  align: 'l' | 'c' | 'r' | 'j';
  width?: string;
  borderLeft: number;
  borderRight: number;
}

export function parseColSpec(spec: string): ColSpec[] {
  const cols: ColSpec[] = [];
  let pendingLeft = 0;
  let i = 0;
  // Expand *{n}{spec}
  spec = spec.replace(/\*\s*\{(\d+)\}\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_m, n, s) => s.repeat(Number(n)));
  while (i < spec.length) {
    const c = spec[i];
    if (c === '|') {
      if (cols.length) cols[cols.length - 1].borderRight++;
      else pendingLeft++;
      i++;
    } else if ('lcrX'.includes(c) || c === 'S') {
      cols.push({ align: c === 'X' ? 'j' : c === 'S' ? 'c' : (c as 'l' | 'c' | 'r'), borderLeft: cols.length ? 0 : pendingLeft, borderRight: 0 });
      pendingLeft = 0;
      i++;
    } else if (c === 'p' || c === 'm' || c === 'b') {
      const g = readGroup(spec, i + 1);
      cols.push({ align: 'j', width: g ? texLengthToCss(spec.slice(g.innerStart, g.innerEnd)) : undefined, borderLeft: cols.length ? 0 : pendingLeft, borderRight: 0 });
      pendingLeft = 0;
      i = g ? g.end : i + 1;
    } else if (c === '@' || c === '!' || c === '>' || c === '<') {
      const g = readGroup(spec, i + 1);
      i = g ? g.end : i + 1;
    } else if (c === '{') {
      const g = readGroup(spec, i);
      i = g ? g.end : i + 1;
    } else i++;
  }
  return cols;
}

const RULES = ['hline', 'toprule', 'midrule', 'bottomrule', 'cline', 'cmidrule', 'specialrule', 'addlinespace', 'hhline',
  'endhead', 'endfirsthead', 'endfoot', 'endlastfoot', 'rowcolor', 'noalign', 'morecmidrules', 'cdashline', 'hdashline'];

interface RowRules {
  top: number; // border width in px
  partial: { from: number; to: number; w: number }[];
  color?: string;
}

/** Consumes rule commands (\hline, \midrule...) at the start of a row. Returns where the cells begin. */
function takeRules(t: string, s: number, e: number): { restStart: number; rules: RowRules } {
  const rules: RowRules = { top: 0, partial: [] };
  let i = s;
  while (i < e) {
    while (i < e && /\s/.test(t[i])) i++;
    if (t[i] === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (t[i] !== '\\') break;
    const name = readCommandName(t, i);
    if (!RULES.includes(name)) break;
    let j = i + 1 + name.length;
    if (name === 'cline' || name === 'cmidrule' || name === 'cdashline') {
      const k = skipInlineSpace(t, j, e);
      if (t[k] === '(') {
        const close = t.indexOf(')', k);
        if (close !== -1 && close < e) j = close + 1;
      }
      const a = readArgs(t, j, 1, e, 1);
      const range = a.required[0] ? t.slice(a.required[0].innerStart, a.required[0].innerEnd) : '';
      const m = /(\d+)\s*-\s*(\d+)/.exec(range);
      if (m) rules.partial.push({ from: Number(m[1]) - 1, to: Number(m[2]) - 1, w: 1 });
      j = a.end;
    } else if (name === 'rowcolor') {
      const a = readArgs(t, j, 1, e, 1);
      if (a.required[0]) rules.color = cssColor(t.slice(a.required[0].innerStart, a.required[0].innerEnd));
      j = a.end;
    } else if (name === 'specialrule' || name === 'noalign' || name === 'hhline') {
      j = readArgs(t, j, name === 'specialrule' ? 3 : 1, e).end;
      rules.top = Math.max(rules.top, 1);
    } else if (name === 'addlinespace') {
      j = readArgs(t, j, 0, e, 1).end;
    } else if (name === 'midrule' || name === 'hline' || name === 'hdashline') {
      if (name === 'midrule') j = readArgs(t, j, 0, e, 1).end;
      rules.top += 1;
    } else if (name === 'toprule' || name === 'bottomrule') {
      j = readArgs(t, j, 0, e, 1).end;
      rules.top += 2;
    }
    i = j;
  }
  return { restStart: i, rules };
}

/**
 * Renders a tabular-like environment whose body (column spec included) is
 * t[s, e). When `mapped`, each cell is an editable region.
 */
export function renderTabular(t: string, s: number, e: number, env: string, ctx: Ctx, footnotes: string[] = [], mapped = true): string {
  let j = s;
  if (env === 'longtable') j = readArgs(t, j, 0, e, 1).end;
  if (env === 'tabular*' || env === 'tabularx') j = readArgs(t, j, 1, e, 0).end;
  j = skipInlineSpace(t, j, e);
  if (t[j] === '[') j = readOptional(t, j, e)?.end ?? j;
  const specGroup = readGroup(t, skipInlineSpace(t, j, e), e);
  const spec = specGroup ? t.slice(specGroup.innerStart, specGroup.innerEnd) : '';
  const contentStart = specGroup ? specGroup.end : s;
  const cols = parseColSpec(spec);
  const cellHtml = (a: number, b: number) =>
    mapped ? region(t, a, b, ctx, footnotes, 'cell') : inline(t, a, b, { ctx, depth: 1, footnotes, mapped: false });

  const rawRows = splitTopLevel(t.slice(contentStart, e), '\\\\').map((r) => ({ start: contentStart + r.start, end: contentStart + r.end }));
  const rows: { cells: { start: number; end: number }[]; rules: RowRules; bottom: number }[] = [];
  let caption = '';
  for (const raw of rawRows) {
    const { restStart, rules } = takeRules(t, raw.start, raw.end);
    const tr = trimRange(t, restStart, raw.end);
    if (t.startsWith('\\caption', tr.start) && !isLetter(t[tr.start + 8])) {
      const a = readArgs(t, tr.start + 8, 1, raw.end, 1);
      if (a.required[0]) caption = cellHtml(a.required[0].innerStart, a.required[0].innerEnd);
      continue;
    }
    if (tr.start >= tr.end) {
      // Rules after the last \\ form the bottom border of the table.
      if (rows.length) rows[rows.length - 1].bottom += rules.top;
      continue;
    }
    const cells = splitTopLevel(t.slice(restStart, raw.end), '&').map((c) => ({ start: restStart + c.start, end: restStart + c.end }));
    rows.push({ cells, rules, bottom: 0 });
  }

  const occupied: number[] = [];
  let html = '<table class="tabular">';
  for (const row of rows) {
    const startOccupied = occupied.slice();
    const top = row.rules.top;
    html += `<tr${row.rules.color ? ` style="background:${row.rules.color}"` : ''}>`;
    let col = 0;
    for (const cell of row.cells) {
      if (startOccupied[col] > 0) {
        // Placeholder cell under a \multirow from an earlier row.
        col++;
        continue;
      }
      let { start: a, end: b } = trimRange(t, cell.start, cell.end);
      let span = 1;
      let rowspan = 1;
      let spec: ColSpec | undefined = cols[col];
      const mc = /^\\multicolumn\s*\{\s*(\d+)\s*\}/.exec(t.slice(a, b));
      if (mc) {
        const args = readArgs(t, a + '\\multicolumn'.length, 3, b);
        span = Number(mc[1]);
        if (args.required.length === 3) {
          const cs = parseColSpec(t.slice(args.required[1].innerStart, args.required[1].innerEnd));
          if (cs[0]) spec = cs[0];
          a = args.required[2].innerStart;
          b = args.required[2].innerEnd;
        }
      }
      const mr = /^\\multirow\s*\{\s*(\d+)\s*\}/.exec(t.slice(a, b));
      if (mr) {
        const args = readArgs(t, a + '\\multirow'.length, 3, b, 2);
        rowspan = Number(mr[1]);
        if (args.required.length === 3) {
          a = args.required[2].innerStart;
          b = args.required[2].innerEnd;
        }
        for (let k = 0; k < span; k++) occupied[col + k] = rowspan;
      }
      const styles: string[] = [];
      const align = spec?.align ?? 'l';
      styles.push(`text-align:${align === 'r' ? 'right' : align === 'c' ? 'center' : 'left'}`);
      if (spec?.width) styles.push(`width:${spec.width}`);
      const bl = col === 0 ? cols[0]?.borderLeft ?? 0 : 0;
      const br = (mc ? spec?.borderRight : cols[col + span - 1]?.borderRight) ?? 0;
      if (mc && spec?.borderLeft) styles.push(`border-left:1px solid var(--rule)`);
      else if (bl) styles.push(`border-left:${bl}px solid var(--rule)`);
      if (br) styles.push(`border-right:${br === 1 ? 1 : 3}px ${br > 1 ? 'double' : 'solid'} var(--rule)`);
      let topW = top;
      for (const p of row.rules.partial) if (col >= p.from && col <= p.to) topW = Math.max(topW, p.w);
      if (topW) styles.push(`border-top:${topW}px solid var(--rule)`);
      if (row.bottom) styles.push(`border-bottom:${row.bottom}px solid var(--rule)`);
      html += `<td${span > 1 ? ` colspan="${span}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''} style="${styles.join(';')}">${mc || mr ? cellHtml(a, b) : cellHtml(cell.start, cell.end)}</td>`;
      col += span;
    }
    html += '</tr>';
    for (let k = 0; k < occupied.length; k++) if (startOccupied[k] > 0) occupied[k] = startOccupied[k] - 1;
  }
  html += '</table>';
  if (caption) html = `<div class="caption">${caption}</div>` + html;
  return html;
}

// ---------------------------------------------------------------------------
// Floats (figure / table)

function renderFloat(b: Block, ctx: Ctx, footnotes: string[]): string {
  const isFig = b.kind === 'figure';
  const num = ctx.floatNums.get(b.start) ?? '?';
  const prefix = isFig ? 'Figure' : 'Table';
  // Skip the placement specifier, e.g. [htbp].
  const bodyStart = readArgs(ctx.text, b.innerStart!, 0, b.innerEnd!, 1).end;
  const body = renderFloatBody(ctx.text, bodyStart, b.innerEnd!, ctx, footnotes, (cap) => `<figcaption><span class="cap-label">${prefix} ${num}:</span> ${cap}</figcaption>`);
  return `<figure class="float ${isFig ? 'fig' : 'tab'}">${body}</figure>`;
}

function renderFloatBody(t: string, s: number, e: number, ctx: Ctx, footnotes: string[], captionFn: (html: string) => string): string {
  const rows: string[][] = [[]];
  let text = '';
  const flushText = () => {
    if (text.trim()) rows[rows.length - 1].push(`<span class="float-text">${renderInline(text, ctx, footnotes)}</span>`);
    text = '';
  };
  const newRow = () => {
    flushText();
    if (rows[rows.length - 1].length) rows.push([]);
  };
  const subs = findSubfigures(t, s, e);
  let i = s;
  while (i < e) {
    const c = t[i];
    if (c === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (c === '\n') {
      let k = i + 1;
      while (k < e && /[ \t\r]/.test(t[k])) k++;
      if (t[k] === '\n') newRow();
      text += ' ';
      i = k;
      continue;
    }
    if (c !== '\\') {
      text += c;
      i++;
      continue;
    }
    const name = readCommandName(t, i);
    const after = i + 1 + name.length;
    const sub = subs.find((r) => r.start === i);
    if (sub) {
      flushText();
      const letter = ctx.subNums.get(sub.start) ?? '';
      let width: string | undefined;
      let innerS: number;
      let innerE: number;
      if (name === 'subfloat') {
        const a = readArgs(t, after, 1, e, 2);
        const cap = a.optional[0] ? region(t, a.optional[0].innerStart, a.optional[0].innerEnd, ctx, footnotes, 'cap') : '';
        const content = a.required[0];
        const inner = content ? renderFloatBody(t, content.innerStart, content.innerEnd, ctx, footnotes, (h) => h) : '';
        rows[rows.length - 1].push(`<div class="subfig">${inner}<div class="subcap">(${letter}) ${cap}</div></div>`);
        i = sub.end;
        continue;
      }
      const g = readGroup(t, after);
      const envName = g ? t.slice(g.innerStart, g.innerEnd) : 'subfigure';
      const a = readArgs(t, g ? g.end : after, 1, e, 1);
      if (a.required[0]) width = texLengthToCss(t.slice(a.required[0].innerStart, a.required[0].innerEnd));
      innerS = a.end;
      innerE = sub.end - `\\end{${envName}}`.length;
      const inner = renderFloatBody(t, innerS, innerE, ctx, footnotes, (h) => `<div class="subcap">(${letter}) ${h}</div>`);
      rows[rows.length - 1].push(`<div class="subfig"${width ? ` style="width:${width}"` : ''}>${inner}</div>`);
      i = sub.end;
      continue;
    }
    if (name === 'includegraphics') {
      flushText();
      const a = readArgs(t, after, 1, e, 1);
      if (a.required[0]) rows[rows.length - 1].push(graphicIsland(t.slice(a.required[0].innerStart, a.required[0].innerEnd).trim(), a.optional[0] ? t.slice(a.optional[0].innerStart, a.optional[0].innerEnd) : '', ctx));
      i = a.end;
      continue;
    }
    if (name === 'caption' || name === 'subcaption') {
      const a = readArgs(t, after, 1, e, 1);
      if (a.required[0]) {
        newRow();
        rows[rows.length - 1].push(captionFn(region(t, a.required[0].innerStart, a.required[0].innerEnd, ctx, footnotes, 'cap')));
        rows.push([]);
      }
      i = a.end;
      continue;
    }
    if (name === 'begin') {
      const g = readGroup(t, after, e);
      if (g) {
        const env = t.slice(g.innerStart, g.innerEnd).trim();
        const f = findEnvEnd(t, g.end, env, e);
        const innerEnd = f ? f.innerEnd : e;
        const end = f ? f.end : e;
        flushText();
        if (['tabular', 'tabular*', 'tabularx', 'longtable', 'array'].includes(env)) {
          rows[rows.length - 1].push(renderTabular(t, g.end, innerEnd, env, ctx, footnotes));
        } else if (env === 'minipage') {
          const a = readArgs(t, g.end, 1, innerEnd, 1);
          const w = a.required[0] ? texLengthToCss(t.slice(a.required[0].innerStart, a.required[0].innerEnd)) : undefined;
          rows[rows.length - 1].push(`<div class="minipage"${w ? ` style="width:${w}"` : ''}>${renderFloatBody(t, a.end, innerEnd, ctx, footnotes, captionFn)}</div>`);
        } else if (env === 'center' || env === 'adjustbox' || env === 'small' || env === 'footnotesize' || env === 'scriptsize' || env === 'resizebox') {
          rows[rows.length - 1].push(renderFloatBody(t, readArgs(t, g.end, env === 'adjustbox' ? 1 : 0, innerEnd).end, innerEnd, ctx, footnotes, captionFn));
        } else if (MATH_ENVS.has(env)) {
          rows[rows.length - 1].push(`<span class="isl math" contenteditable="false" data-start="${i}" data-end="${end}">${renderKatex(t.slice(g.end, innerEnd), true, ctx)}</span>`);
        } else {
          rows[rows.length - 1].push(renderFloatBody(t, g.end, innerEnd, ctx, footnotes, captionFn));
        }
        i = end;
        continue;
      }
    }
    if (name === 'resizebox' || name === 'scalebox') {
      // \resizebox{w}{h}{content}: render the content.
      const a = readArgs(t, after, name === 'resizebox' ? 3 : 2, e, 1);
      const content = a.required[a.required.length - 1];
      if (content) {
        flushText();
        rows[rows.length - 1].push(renderFloatBody(t, content.innerStart, content.innerEnd, ctx, footnotes, captionFn));
      }
      i = a.end;
      continue;
    }
    if (name === '\\' || name === 'newline' || name === 'par') {
      newRow();
      i = readArgs(t, after, 0, e, 1).end;
      continue;
    }
    if (name === 'label' || name === 'centering' || name === 'hfill' || name === 'vspace' || name === 'small' || name === 'footnotesize' ||
        name === 'qquad' || name === 'quad' || name === 'hspace' || name === 'medskip' || name === 'bigskip' || name === 'smallskip' ||
        name === 'captionsetup' || name === 'scriptsize' || name === 'setlength' || name === 'renewcommand' || name === 'arraystretch' ||
        name === 'tabcolsep' || name === 'raggedright') {
      const n = { label: 1, vspace: 1, hspace: 1, captionsetup: 1, setlength: 2, renewcommand: 2 }[name as string] ?? 0;
      i = readArgs(t, after, n, e, 1).end;
      if (name === 'renewcommand' || name === 'setlength') {
        // \renewcommand{\arraystretch}{1.2} etc.
      }
      continue;
    }
    // Anything else is inline text inside the float.
    let end = after;
    const a = readArgs(t, after, 4, e, 2);
    end = Math.max(end, a.end);
    text += t.slice(i, end);
    i = end;
  }
  flushText();
  return rows
    .filter((r) => r.length)
    .map((r) => (r.length === 1 && r[0].startsWith('<figcaption') ? r[0] : `<div class="float-row">${r.join('')}</div>`))
    .join('');
}

// ---------------------------------------------------------------------------
// Blocks

/** Wrapper attributes for a block. Blocks without editable text are marked contenteditable=false. */
function attrs(b: { start: number; end: number }, kind: string, extra = '', editable = true): string {
  return `class="blk blk-${kind}${extra ? ' ' + extra : ''}" data-start="${b.start}" data-end="${b.end}"${editable ? '' : ' contenteditable="false"'}`;
}

const NE = 'contenteditable="false"';

export function renderBlocks(blocks: Block[], ctx: Ctx): string {
  return blocks.map((b) => renderBlock(b, ctx)).join('');
}

export function renderBlock(b: Block, ctx: Ctx): string {
  const t = ctx.text;
  const footnotes: string[] = [];
  let html: string;
  try {
    html = renderBlockInner(b, ctx, footnotes);
  } catch (e) {
    html = `<div ${attrs(b, 'error')}><div class="render-error">Could not render this block: ${escapeHtml(String(e))}</div><pre>${escapeHtml(t.slice(b.start, b.end))}</pre></div>`;
  }
  if (footnotes.length) {
    // Insert footnotes inside the block wrapper so they share its click target.
    const close = html.lastIndexOf('</');
    html = html.slice(0, close) + `<div class="footnotes">${footnotes.join('')}</div>` + html.slice(close);
  }
  return html;
}

const HEADING_TAG: Record<number, string> = { [-1]: 'h1', 0: 'h1', 1: 'h2', 2: 'h3', 3: 'h4', 4: 'h5', 5: 'h6' };

function renderBlockInner(b: Block, ctx: Ctx, footnotes: string[]): string {
  const t = ctx.text;
  switch (b.kind) {
    case 'preamble':
      return `<div ${attrs(b, 'preamble', '', false)}>${renderPreambleSummary(ctx)}</div>`;
    case 'paragraph':
      return `<div ${attrs(b, 'paragraph')}>${region(t, b.start, b.end, ctx, footnotes, 'p', 'p', b.continuation ? 'cont' : '')}</div>`;
    case 'comment':
      return `<div ${attrs(b, 'comment', '', false)}><span class="comment">${escapeHtml(t.slice(b.start, b.end))}</span></div>`;
    case 'heading': {
      const num = ctx.headingNums.get(b.start);
      const tag = HEADING_TAG[b.level!] ?? 'h5';
      let prefix = '';
      if (num) prefix = b.level === 0 ? `<span class="secnum chapnum" ${NE}>Chapter ${num}</span>` : `<span class="secnum" ${NE}>${num}</span>`;
      return `<div ${attrs(b, 'heading')}><${tag}>${prefix}${region(t, b.arg!.start, b.arg!.end, ctx, footnotes, 'h')}</${tag}></div>`;
    }
    case 'math': {
      const src = ctx.mathSrc.get(b.start) ?? stripComments(t.slice(b.innerStart!, b.innerEnd!));
      return `<div ${attrs(b, 'math', '', false)}>${renderKatex(src, true, ctx)}</div>`;
    }
    case 'figure':
    case 'table':
      return `<div ${attrs(b, b.kind, '', false)}>${renderFloat(b, ctx, footnotes)}</div>`;
    case 'tabular':
      return `<div ${attrs(b, 'tabular', '', false)}><div class="float-row">${renderTabular(t, b.innerStart!, b.innerEnd!, b.name!, ctx, footnotes)}</div></div>`;
    case 'verbatim': {
      let s = b.innerStart!;
      if (b.name === 'lstlisting' || b.name === 'minted') s = readArgs(t, s, b.name === 'minted' ? 1 : 0, b.innerEnd!, 1).end;
      const code = t.slice(s, b.innerEnd!).replace(/^\n/, '');
      if (b.name === 'comment') return `<div ${attrs(b, 'comment', '', false)}><span class="comment">${escapeHtml(t.slice(b.start, b.end))}</span></div>`;
      return `<div ${attrs(b, 'verbatim', '', false)}><pre>${escapeHtml(code)}</pre></div>`;
    }
    case 'list':
      return `<div ${attrs(b, 'list')}>${renderList(b, ctx)}</div>`;
    case 'env':
      return renderEnv(b, ctx);
    case 'command':
      return renderCommand(b, ctx, footnotes);
  }
  return `<div ${attrs(b, 'unknown', '', false)}><pre>${escapeHtml(t.slice(b.start, b.end))}</pre></div>`;
}

let listDepth = 0;

/** An item's blocks, or an empty editable paragraph so the caret can go into a new item. */
function itemBody(it: ListItem, ctx: Ctx): string {
  if (it.children.length) return renderBlocks(it.children, ctx);
  const at = it.contentStart;
  const prefix = /\s/.test(ctx.text[at - 1] ?? '') ? '' : ' ';
  return `<div class="blk blk-paragraph" data-start="${at}" data-end="${at}"><p class="ed" contenteditable="true" data-region="p" data-s="${at}" data-e="${at}"${prefix ? ` data-prefix="${prefix}"` : ''}><br></p></div>`;
}
function renderList(b: Block, ctx: Ctx): string {
  const t = ctx.text;
  listDepth++;
  try {
    const items = b.items ?? [];
    if (b.name === 'description') {
      return `<dl class="description">${items
        .map((it) => `<div class="item" data-start="${it.start}" data-end="${it.end}"><dt ${NE}>${it.label ? renderInline(t.slice(it.label.start, it.label.end), ctx) : ''}</dt><dd>${itemBody(it, ctx)}</dd></div>`)
        .join('')}</dl>`;
    }
    const ordered = b.name === 'enumerate';
    const type = ['1', 'a', 'i', 'A'][(listDepth - 1) % 4];
    const tag = ordered ? 'ol' : 'ul';
    const lis = items
      .map((it) => {
        const custom = it.label ? `<span class="item-label" ${NE}>${renderInline(t.slice(it.label.start, it.label.end), ctx)}</span>` : '';
        return `<li class="item${custom ? ' custom' : ''}" data-start="${it.start}" data-end="${it.end}">${custom}${itemBody(it, ctx)}</li>`;
      })
      .join('');
    return `<${tag} class="${b.name}"${ordered ? ` type="${type}"` : ''}>${lis}</${tag}>`;
  } finally {
    listDepth--;
  }
}

function renderEnv(b: Block, ctx: Ctx): string {
  const t = ctx.text;
  const name = b.name!;
  const kids = () => renderBlocks(b.children ?? [], ctx);
  const opt = () => {
    const k = skipInlineSpace(t, b.innerStart!, b.innerEnd!);
    const g = t[k] === '[' ? readOptional(t, k, b.innerEnd!) : null;
    return g ? renderInline(t.slice(g.innerStart, g.innerEnd), ctx) : '';
  };
  if (name === 'abstract') {
    return `<div ${attrs(b, 'env', 'abstract')}><div class="abstract-title" ${NE}>Abstract</div>${kids()}</div>`;
  }
  if (name === 'thebibliography') {
    const items = (b.items ?? [])
      .map((it) => {
        const key = it.label ? t.slice(it.label.start, it.label.end).trim() : '';
        const num = ctx.cites.get(key) ?? '?';
        const range = ctx.bibitemText.get(key);
        const body = range ? renderInline(t.slice(range.start, range.end), ctx) : '';
        return `<li class="bib-item" id="bib-${escapeHtml(key)}" data-start="${it.start}" data-end="${it.end}"><span class="bib-num">[${num}]</span> ${body}</li>`;
      })
      .join('');
    return `<div ${attrs(b, 'env', 'bibliography', false)}><h2 class="bib-title">References</h2><ol class="bib-list">${items}</ol></div>`;
  }
  const th = ctx.theorems.get(name);
  if (th) {
    const num = ctx.theoremNums.get(b.start);
    const o = opt();
    return `<div ${attrs(b, 'env', 'theorem')}><span class="thm-head" ${NE}>${escapeHtml(th.title)}${num ? ' ' + num : ''}${o ? ` (${o})` : ''}.</span>${kids()}</div>`;
  }
  if (name === 'proof') {
    const o = opt();
    return `<div ${attrs(b, 'env', 'proof')}><span class="thm-head proof-head" ${NE}>${o || 'Proof'}.</span>${kids()}<span class="qed" ${NE}>∎</span></div>`;
  }
  if (name === 'center' || name === 'flushleft' || name === 'flushright') {
    return `<div ${attrs(b, 'env', name)}>${kids()}</div>`;
  }
  if (name === 'quote' || name === 'quotation' || name === 'verse') {
    return `<div ${attrs(b, 'env', 'quote')}>${kids()}</div>`;
  }
  if (name === 'minipage') return `<div ${attrs(b, 'env', 'minipage')}>${kids()}</div>`;
  return `<div ${attrs(b, 'env', 'generic')}><div class="env-name" ${NE}>${escapeHtml(name)}</div>${kids()}</div>`;
}

function renderCommand(b: Block, ctx: Ctx, footnotes: string[]): string {
  const t = ctx.text;
  const name = b.name!;
  const chip = (label: string, cls = '') => `<div ${attrs(b, 'command', cls, false)}><span class="chip">${label}</span></div>`;
  switch (name) {
    case 'maketitle':
      return `<div ${attrs(b, 'command', 'titleblock', false)}>${renderTitle(ctx, footnotes)}</div>`;
    case 'tableofcontents':
      return `<div ${attrs(b, 'command', 'toc', false)}><h2 class="toc-title">Contents</h2>${ctx.headings
        .filter((h) => h.level <= 2)
        .map((h) => `<div class="toc-entry toc-l${h.level}"><a class="ref" data-goto="${h.start}"><span class="toc-num">${h.num}</span> ${renderInline(t.slice(h.title.start, h.title.end), ctx)}</a></div>`)
        .join('')}</div>`;
    case 'bibliography':
    case 'printbibliography':
      return `<div ${attrs(b, 'command', 'bibliography', false)}>${renderBibList(ctx)}</div>`;
    case 'newpage':
    case 'clearpage':
    case 'cleardoublepage':
    case 'pagebreak':
      return `<div ${attrs(b, 'command', 'pagebreak', false)}><span class="chip">page break</span></div>`;
    case 'appendix':
      return chip('Appendix', 'appendix');
    case 'input':
    case 'include': {
      const file = b.arg ? t.slice(b.arg.start, b.arg.end).trim() : '';
      return `<div ${attrs(b, 'command', 'input', false)}><span class="chip">\\${name}{${escapeHtml(file)}} <a class="open-file" data-file="${escapeHtml(file)}">open</a></span></div>`;
    }
    case 'vspace':
    case 'vfill':
    case 'bigskip':
    case 'medskip':
    case 'smallskip':
      return `<div ${attrs(b, 'command', 'spacer', false)}></div>`;
    default: {
      const src = t.slice(b.start, b.end);
      const short = src.length > 80 ? src.slice(0, 77) + '…' : src;
      return chip(escapeHtml(short.replace(/\s+/g, ' ')), 'meta');
    }
  }
}

function renderPreambleSummary(ctx: Ctx): string {
  const pre = ctx.doc.preamble!;
  const src = ctx.text.slice(pre.start, pre.end);
  const pkgs = new Set<string>();
  for (const m of stripComments(src).matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) if (p.trim()) pkgs.add(p.trim());
  }
  const nMacros = Object.keys(ctx.katexMacros).length;
  const parts = [ctx.meta.documentclass ?? 'document', `${pkgs.size} package${pkgs.size === 1 ? '' : 's'}`];
  if (nMacros) parts.push(`${nMacros} macro${nMacros === 1 ? '' : 's'}`);
  return `<span class="chip preamble-chip" title="${escapeHtml([...pkgs].join(', '))}">Preamble · ${parts.map(escapeHtml).join(' · ')}</span>`;
}

function renderTitle(ctx: Ctx, footnotes: string[]): string {
  const t = ctx.text;
  const { title, author, date } = ctx.meta;
  const reg = (s: number, e: number) => region(t, s, e, ctx, footnotes, 'title');
  let html = '';
  if (title) html += `<div class="doc-title">${reg(title.start, title.end)}</div>`;
  if (author) {
    // One region per author, split at top-level \and.
    const parts: { start: number; end: number }[] = [];
    let last = author.start;
    for (const m of t.slice(author.start, author.end).matchAll(/\\and\b/g)) {
      parts.push({ start: last, end: author.start + m.index! });
      last = author.start + m.index! + m[0].length;
    }
    parts.push({ start: last, end: author.end });
    html += `<div class="doc-authors">${parts.map((p) => `<div class="doc-author">${reg(p.start, p.end)}</div>`).join('')}</div>`;
  }
  if (date) html += `<div class="doc-date">${reg(date.start, date.end)}</div>`;
  else html += `<div class="doc-date">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>`;
  return html || '<span class="chip">\\maketitle (no \\title set)</span>';
}

export function formatBibEntry(e: BibEntry, ctx: Ctx): string {
  const f = e.fields;
  const r = (s: string) => renderInline(s, ctx);
  const authors = splitAuthors(f.author ?? f.editor ?? '');
  const authorStr = authors.length > 2 ? authors.slice(0, -1).join(', ') + ', and ' + authors[authors.length - 1] : authors.join(' and ');
  const parts: string[] = [];
  if (authorStr) parts.push(r(authorStr) + (f.editor && !f.author ? ', editors' : ''));
  if (f.title) parts.push(`<span class="bib-title-field">${r(f.title)}</span>`);
  let venue = '';
  if (f.journal) venue = `<em>${r(f.journal)}</em>${f.volume ? `, ${r(f.volume)}` : ''}${f.number ? `(${r(f.number)})` : ''}${f.pages ? `:${r(f.pages)}` : ''}`;
  else if (f.booktitle) venue = `In <em>${r(f.booktitle)}</em>${f.pages ? `, pages ${r(f.pages)}` : ''}`;
  else if (f.school) venue = r(f.school);
  else if (f.institution) venue = r(f.institution);
  else if (f.howpublished) venue = r(f.howpublished);
  if (f.publisher && !f.journal) venue += (venue ? '. ' : '') + r(f.publisher);
  if (venue) parts.push(venue);
  if (f.year) parts.push(r(f.year));
  let html = parts.join('. ') + '.';
  const link = f.doi ? `https://doi.org/${f.doi}` : f.url;
  if (link) html += ` <a class="url" href="${escapeHtml(link)}" data-external="1">${escapeHtml(f.doi ? 'doi:' + f.doi : f.url!)}</a>`;
  return html;
}

function renderBibList(ctx: Ctx): string {
  if (ctx.citeOrder.length === 0) return '<h2 class="bib-title">References</h2><div class="chip">No citations yet</div>';
  const items = ctx.citeOrder
    .map((key) => {
      const e = ctx.bib.get(key);
      const body = e ? formatBibEntry(e, ctx) : `<span class="undef">Missing bibliography entry: ${escapeHtml(key)}</span>`;
      return `<li class="bib-item" id="bib-${escapeHtml(key)}"><span class="bib-num">[${ctx.cites.get(key)}]</span> ${body}</li>`;
    })
    .join('');
  return `<h2 class="bib-title">References</h2><ol class="bib-list">${items}</ol>`;
}

// ---------------------------------------------------------------------------
// Entry points

export function renderDocument(ctx: Ctx): string {
  ctx.footnote = 0;
  listDepth = 0;
  let html = '';
  if (ctx.doc.preamble) html += renderBlock(ctx.doc.preamble, ctx);
  html += renderBlocks(ctx.doc.blocks, ctx);
  return html;
}

/** Renders an arbitrary source range of the current document (used for live previews). */
export function renderRange(ctx: Ctx, start: number, end: number): string {
  if (ctx.doc.preamble && start === ctx.doc.preamble.start && start < ctx.doc.bodyStart) return renderBlock({ ...ctx.doc.preamble, end }, ctx);
  return renderBlocks(parseBlocks(ctx.text, start, end), ctx);
}

export { parseKeyVals };
