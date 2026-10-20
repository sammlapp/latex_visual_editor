// Document-wide pass that resolves everything LaTeX would compute across
// runs: section/equation/figure/table numbers, labels, citation order,
// user macros and title metadata.

import { BibEntry, parseBib } from './bib';
import { Block, ParsedDocument, parseDocument } from './parser';
import {
  Range,
  findEnvEnd,
  readArgs,
  readCommandName,
  readGroup,
  readOptional,
  skipComment,
  skipInlineSpace,
  splitTopLevel,
  stripComments,
} from './util';

export interface ImageInfo {
  /** Webview URI of the resolved file. */
  uri?: string;
  kind: 'image' | 'pdf' | 'unsupported' | 'missing';
  /** Resolved path relative to the document, for display. */
  resolved?: string;
}

/** Data the extension host supplies (things the webview cannot read itself). */
export interface HostResources {
  images: Record<string, ImageInfo>;
  bib: string;
  /** Text of files pulled in by \input / \include, keyed by the argument as written (null: not found). */
  includes?: Record<string, string | null>;
}

export interface LabelInfo {
  num: string;
  kind: 'section' | 'equation' | 'figure' | 'table' | 'theorem' | 'item' | 'other';
  /** Offset of the block the label lives in (scroll target). */
  target: number;
}

export interface TheoremDef {
  title: string;
  counter: string;
  numbered: boolean;
}

export interface TextMacro {
  nargs: number;
  optDefault?: string;
  body: string;
}

export interface HeadingInfo {
  start: number;
  level: number;
  num: string;
  title: Range;
  /** Text that `title` indexes (differs from the main document for headings in included files). */
  src: string;
  /** Offset in the main document to jump to. */
  target: number;
}

export interface Ctx {
  doc: ParsedDocument;
  text: string;
  host: HostResources;
  labels: Map<string, LabelInfo>;
  headingNums: Map<number, string>;
  headings: HeadingInfo[];
  /** KaTeX source (with numbering applied) per math block start. */
  mathSrc: Map<number, string>;
  floatNums: Map<number, string>;
  /** Subfigure letter per subfigure env start. */
  subNums: Map<number, string>;
  theoremNums: Map<number, string>;
  /** Citation key → number. */
  cites: Map<string, number>;
  /** Keys in numbering order (for the reference list). */
  citeOrder: string[];
  bib: Map<string, BibEntry>;
  /** True when a thebibliography environment defines the numbering. */
  hasBibitems: boolean;
  bibitemText: Map<string, Range>;
  katexMacros: Record<string, string>;
  textMacros: Map<string, TextMacro>;
  theorems: Map<string, TheoremDef>;
  meta: { title?: Range; author?: Range; date?: Range; documentclass?: string };
  /** Render-time footnote counter. */
  footnote: number;
  /** Contexts of \input / \include files, per command start offset. */
  includes: Map<number, Ctx>;
  /** Text of the main document (label targets and bibitem ranges refer to it). */
  rootText: string;
}

/** Nesting limit for \input files (also stops include cycles). */
const MAX_INCLUDE_DEPTH = 8;

const DEFAULT_THEOREMS: Record<string, string> = {
  theorem: 'Theorem',
  lemma: 'Lemma',
  proposition: 'Proposition',
  corollary: 'Corollary',
  definition: 'Definition',
  remark: 'Remark',
  example: 'Example',
  conjecture: 'Conjecture',
  claim: 'Claim',
  assumption: 'Assumption',
};

const CITE_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'parencite', 'textcite',
  'autocite', 'footcite', 'nocite', 'Cite', 'Citep', 'Citet', 'citenum', 'supercite',
]);
export { CITE_COMMANDS };

export function buildContext(text: string, host: HostResources): Ctx {
  const doc = parseDocument(text);
  const ctx: Ctx = {
    doc,
    text,
    host,
    labels: new Map(),
    headingNums: new Map(),
    headings: [],
    mathSrc: new Map(),
    floatNums: new Map(),
    subNums: new Map(),
    theoremNums: new Map(),
    cites: new Map(),
    citeOrder: [],
    bib: parseBib(host.bib || ''),
    hasBibitems: false,
    bibitemText: new Map(),
    katexMacros: {},
    textMacros: new Map(),
    theorems: new Map(),
    meta: {},
    footnote: 0,
    includes: new Map(),
    rootText: text,
  };
  for (const [env, title] of Object.entries(DEFAULT_THEOREMS)) ctx.theorems.set(env, { title, counter: env, numbered: true });
  scanDefinitions(ctx);
  new Numberer(ctx).walk(doc.blocks);
  if (!ctx.hasBibitems) scanCitations(ctx);
  return ctx;
}

/** Collects macro, theorem and metadata definitions from the whole document. */
function scanDefinitions(ctx: Ctx) {
  const t = ctx.text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '%') {
      i = skipComment(t, i);
      continue;
    }
    if (c !== '\\') continue;
    const name = readCommandName(t, i);
    const after = i + 1 + name.length;
    switch (name) {
      case 'newcommand':
      case 'renewcommand':
      case 'providecommand': {
        let j = skipInlineSpace(t, after);
        if (t[j] === '*') j++;
        j = skipInlineSpace(t, j);
        let macro = '';
        if (t[j] === '{') {
          const g = readGroup(t, j);
          if (!g) break;
          macro = t.slice(g.innerStart, g.innerEnd).trim();
          j = g.end;
        } else if (t[j] === '\\') {
          macro = '\\' + readCommandName(t, j);
          j += macro.length;
        }
        if (!macro.startsWith('\\')) break;
        let nargs = 0;
        let optDefault: string | undefined;
        j = skipInlineSpace(t, j);
        const n = readOptional(t, j);
        if (n) {
          nargs = parseInt(t.slice(n.innerStart, n.innerEnd), 10) || 0;
          j = skipInlineSpace(t, n.end);
          const d = readOptional(t, j);
          if (d) {
            optDefault = t.slice(d.innerStart, d.innerEnd);
            j = skipInlineSpace(t, d.end);
          }
        }
        const body = readGroup(t, j);
        if (!body) break;
        const src = t.slice(body.innerStart, body.innerEnd);
        ctx.katexMacros[macro] = src;
        ctx.textMacros.set(macro.slice(1), { nargs, optDefault, body: src });
        i = body.end - 1;
        break;
      }
      case 'DeclareMathOperator': {
        const args = readArgs(t, after, 2);
        if (args.required.length < 2) break;
        const macro = t.slice(args.required[0].innerStart, args.required[0].innerEnd).trim();
        const op = t.slice(args.required[1].innerStart, args.required[1].innerEnd);
        ctx.katexMacros[macro] = `\\operatorname${args.star ? '*' : ''}{${op}}`;
        i = args.end - 1;
        break;
      }
      case 'def': {
        const j = skipInlineSpace(t, after);
        if (t[j] !== '\\') break;
        const macro = '\\' + readCommandName(t, j);
        const open = t.indexOf('{', j);
        if (open === -1) break;
        const params = t.slice(j + macro.length, open);
        const g = readGroup(t, open);
        if (!g) break;
        const body = t.slice(g.innerStart, g.innerEnd);
        if (!/^(#\d)*$/.test(params.trim())) break; // delimited params unsupported
        ctx.katexMacros[macro] = body;
        ctx.textMacros.set(macro.slice(1), { nargs: (params.match(/#/g) || []).length, body });
        i = g.end - 1;
        break;
      }
      case 'newtheorem': {
        const args = readArgs(t, after, 2, t.length, 2);
        if (args.required.length < 2) break;
        const env = t.slice(args.required[0].innerStart, args.required[0].innerEnd).trim();
        const title = t.slice(args.required[1].innerStart, args.required[1].innerEnd).trim();
        // \newtheorem{lemma}[theorem]{Lemma}: the optional arg between the two shares a counter.
        const shared = args.all.length >= 2 && args.all[1].kind === 'opt' ? args.all[1].group : undefined;
        const counter = shared ? t.slice(shared.innerStart, shared.innerEnd).trim() : env;
        ctx.theorems.set(env, { title, counter, numbered: !args.star });
        i = args.end - 1;
        break;
      }
      case 'title':
      case 'author':
      case 'date': {
        const args = readArgs(t, after, 1, t.length, 1);
        if (args.required[0]) ctx.meta[name] = { start: args.required[0].innerStart, end: args.required[0].innerEnd };
        break;
      }
      case 'documentclass': {
        const args = readArgs(t, after, 1);
        if (args.required[0]) ctx.meta.documentclass = t.slice(args.required[0].innerStart, args.required[0].innerEnd).trim();
        break;
      }
      case 'begin': {
        // Don't read macro definitions out of verbatim blocks.
        const g = readGroup(t, after);
        if (g) {
          const env = t.slice(g.innerStart, g.innerEnd);
          if (env === 'verbatim' || env === 'lstlisting' || env === 'minted' || env === 'comment') {
            const e = findEnvEnd(t, g.end, env);
            if (e) i = e.end - 1;
          }
        }
        break;
      }
      default:
        if (name.length === 1) i++; // escaped char like \%
    }
  }
}

/** Numbers citations in order of first appearance in the body (descending into included files). */
function scanCitations(ctx: Ctx) {
  const t = ctx.text;
  const { bodyStart, bodyEnd } = ctx.doc;
  let nociteAll = false;
  for (let i = bodyStart; i < bodyEnd; i++) {
    const c = t[i];
    if (c === '%') {
      i = skipComment(t, i, bodyEnd);
      continue;
    }
    if (c !== '\\') continue;
    const name = readCommandName(t, i);
    const child = (name === 'input' || name === 'include') && ctx.includes.get(i);
    if (child) {
      scanCitations(child);
      i += name.length;
    } else if (CITE_COMMANDS.has(name)) {
      const args = readArgs(t, i + 1 + name.length, 1, bodyEnd, 2);
      const g = args.required[0];
      if (g) {
        for (const key of t.slice(g.innerStart, g.innerEnd).split(',').map((k) => k.trim()).filter(Boolean)) {
          if (key === '*') {
            nociteAll = true;
            continue;
          }
          if (!ctx.cites.has(key)) {
            ctx.citeOrder.push(key);
            ctx.cites.set(key, ctx.citeOrder.length);
          }
        }
        i = args.end - 1;
      }
    } else if (name.length === 1) i++;
  }
  if (nociteAll) {
    for (const key of ctx.bib.keys()) {
      if (!ctx.cites.has(key)) {
        ctx.citeOrder.push(key);
        ctx.cites.set(key, ctx.citeOrder.length);
      }
    }
  }
}

/** Finds `\label{key}` occurrences in [s, e). */
export function findLabels(t: string, s: number, e: number): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = [];
  for (let i = s; i < e; i++) {
    if (t[i] === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (t[i] === '\\') {
      if (t.startsWith('\\label', i) && !/[A-Za-z]/.test(t[i + 6] ?? '')) {
        const g = readGroup(t, skipInlineSpace(t, i + 6, e), e);
        if (g) {
          out.push({ key: t.slice(g.innerStart, g.innerEnd).trim(), at: i });
          i = g.end - 1;
          continue;
        }
      }
      i++;
    }
  }
  return out;
}

const LABEL_RE = /\\label\s*\{([^}]*)\}/g;

class Numberer {
  private sec: number[] = [0, 0, 0, 0, 0, 0, 0];
  private eq = 0;
  private fig = 0;
  private tab = 0;
  private thm = new Map<string, number>();
  private lastRef = '';
  private appendix = false;
  private topLevel: number;
  private listDepth = 0;
  /** While inside an included file: the main-document offset of the \input command (label target). */
  private anchor: number | undefined;
  /** Files currently being included (cycle check). */
  private stack: string[] = [];

  constructor(private ctx: Ctx) {
    const cls = ctx.meta.documentclass ?? '';
    const sources = [ctx.text, ...Object.values(ctx.host.includes ?? {})];
    this.topLevel = /book|report|thesis/.test(cls) || sources.some((s) => s && /\\chapter\b/.test(s)) ? 0 : 1;
  }

  walk(blocks: Block[]) {
    for (const b of blocks) this.visit(b);
  }

  private label(key: string, num: string, kind: LabelInfo['kind'], target: number) {
    if (!this.ctx.labels.has(key)) this.ctx.labels.set(key, { num, kind, target: this.anchor ?? target });
  }

  private labelsIn(s: number, e: number, kind: LabelInfo['kind'], target: number) {
    for (const l of findLabels(this.ctx.text, s, e)) this.label(l.key, this.lastRef, kind, target);
  }

  private visit(b: Block) {
    const t = this.ctx.text;
    switch (b.kind) {
      case 'heading': {
        const level = b.level!;
        if (b.starred || level > 3 || level < 0) {
          this.labelsIn(b.start, b.end, 'section', b.start);
          break;
        }
        const idx = level - this.topLevel;
        if (idx < 0) break;
        this.sec[idx]++;
        for (let k = idx + 1; k < this.sec.length; k++) this.sec[k] = 0;
        if (this.topLevel === 0 && level === 0) {
          // eq/fig/tab counters reset per chapter in book-like classes
          this.eq = this.fig = this.tab = 0;
        }
        const parts = this.sec.slice(0, idx + 1).map((n, k) => (k === 0 && this.appendix ? String.fromCharCode(64 + n) : String(n)));
        const num = parts.join('.');
        this.ctx.headingNums.set(b.start, num);
        this.ctx.headings.push({ start: b.start, level, num, title: b.arg!, src: t, target: this.anchor ?? b.start });
        this.lastRef = num;
        this.labelsIn(b.start, b.end, 'section', b.start);
        break;
      }
      case 'math':
        this.math(b);
        break;
      case 'figure':
      case 'table': {
        const isFig = b.kind === 'figure';
        const n = isFig ? ++this.fig : ++this.tab;
        const num = this.chapterPrefix() + n;
        this.ctx.floatNums.set(b.start, num);
        // Subfigures get letters; labels inside them resolve to e.g. "2a".
        const subs = findSubfigures(t, b.innerStart!, b.innerEnd!);
        subs.forEach((s, k) => {
          const letter = String.fromCharCode(97 + k);
          this.ctx.subNums.set(s.start, letter);
          for (const l of findLabels(t, s.start, s.end)) this.label(l.key, num + letter, isFig ? 'figure' : 'table', b.start);
        });
        this.lastRef = num;
        for (const l of findLabels(t, b.innerStart!, b.innerEnd!)) {
          if (!subs.some((s) => l.at >= s.start && l.at < s.end)) this.label(l.key, num, isFig ? 'figure' : 'table', b.start);
        }
        break;
      }
      case 'tabular':
        // A longtable with a caption is numbered like a table float.
        if (b.name === 'longtable' && /\\caption\b/.test(t.slice(b.innerStart!, b.innerEnd!))) {
          const num = this.chapterPrefix() + ++this.tab;
          this.ctx.floatNums.set(b.start, num);
          this.lastRef = num;
          for (const l of findLabels(t, b.innerStart!, b.innerEnd!)) this.label(l.key, num, 'table', b.start);
        }
        break;
      case 'list': {
        const enumerate = b.name === 'enumerate';
        this.listDepth++;
        b.items!.forEach((it, k) => {
          if (enumerate) this.lastRef = formatEnum(k + 1, this.listDepth);
          // Labels directly in the item (not in nested blocks) refer to the item.
          this.walk(it.children);
          if (enumerate) for (const l of findLabels(t, it.start, it.end)) this.label(l.key, formatEnum(k + 1, this.listDepth), 'item', it.start);
        });
        this.listDepth--;
        break;
      }
      case 'env': {
        if (b.name === 'thebibliography') {
          this.ctx.hasBibitems = true;
          b.items!.forEach((it) => {
            if (!it.label) return;
            const key = t.slice(it.label.start, it.label.end).trim();
            if (!this.ctx.cites.has(key)) {
              this.ctx.citeOrder.push(key);
              this.ctx.cites.set(key, this.ctx.citeOrder.length);
            }
            this.ctx.bibitemText.set(key, { start: it.label.end + 1, end: it.end });
          });
          break;
        }
        const th = this.ctx.theorems.get(b.name!);
        if (th && th.numbered) {
          const n = (this.thm.get(th.counter) ?? 0) + 1;
          this.thm.set(th.counter, n);
          const num = String(n);
          this.ctx.theoremNums.set(b.start, num);
          this.lastRef = num;
          // Labels at the top of the theorem body refer to the theorem.
          for (const l of findLabels(t, b.innerStart!, b.innerEnd!)) this.label(l.key, num, 'theorem', b.start);
        }
        this.walk(b.children ?? []);
        break;
      }
      case 'command':
        if (b.name === 'appendix') {
          this.appendix = true;
          this.sec = this.sec.map(() => 0);
        } else if (b.name === 'input' || b.name === 'include') {
          this.include(b);
        }
        break;
      case 'paragraph':
        this.labelsIn(b.start, b.end, 'other', b.start);
        break;
    }
  }

  /**
   * Parses an included file into its own context and numbers it in place, so
   * sections, equations, labels and citations continue across files.
   */
  private include(b: Block) {
    const parent = this.ctx;
    const file = b.arg ? parent.text.slice(b.arg.start, b.arg.end).trim() : '';
    const src = parent.host.includes?.[file];
    if (typeof src !== 'string' || this.stack.includes(file) || this.stack.length >= MAX_INCLUDE_DEPTH) return;
    // Offset-keyed maps are per file; labels, headings and citations are shared.
    const child: Ctx = {
      ...parent,
      doc: parseDocument(src),
      text: src,
      headingNums: new Map(),
      mathSrc: new Map(),
      floatNums: new Map(),
      subNums: new Map(),
      theoremNums: new Map(),
      katexMacros: { ...parent.katexMacros },
      textMacros: new Map(parent.textMacros),
      theorems: new Map(parent.theorems),
      meta: { ...parent.meta },
      includes: new Map(),
    };
    parent.includes.set(b.start, child);
    scanDefinitions(child);
    const anchor = this.anchor;
    this.anchor ??= b.start;
    this.stack.push(file);
    this.ctx = child;
    try {
      this.walk(child.doc.blocks);
    } finally {
      this.ctx = parent;
      this.stack.pop();
      this.anchor = anchor;
    }
  }

  private chapterPrefix(): string {
    return this.topLevel === 0 && this.sec[0] > 0 ? `${this.appendix ? String.fromCharCode(64 + this.sec[0]) : this.sec[0]}.` : '';
  }

  private nextEq(): string {
    return this.chapterPrefix() + ++this.eq;
  }

  /** Builds KaTeX source with explicit \tag numbers and records labels. */
  private math(b: Block) {
    const t = this.ctx.text;
    const env = b.name!;
    const base = env.replace(/\*$/, '');
    const unnumbered = env.endsWith('*') || env === '$$' || env === '\\[' || env === 'displaymath' || env === 'math';
    let inner = stripComments(t.slice(b.innerStart!, b.innerEnd!));
    if (base === 'equation' || base === 'multline' || unnumbered && !['align', 'gather', 'eqnarray', 'flalign', 'alignat'].includes(base)) {
      const labels = [...inner.matchAll(LABEL_RE)].map((m) => m[1].trim());
      inner = inner.replace(LABEL_RE, '');
      const explicit = /\\tag\*?\s*\{/.test(inner);
      const suppressed = /\\(nonumber|notag)\b/.test(inner);
      inner = inner.replace(/\\(nonumber|notag)\b/g, '');
      let tag = '';
      if (explicit) {
        const m = /\\tag\*?\s*\{([^}]*)\}/.exec(inner);
        for (const l of labels) this.label(l, m ? m[1] : '', 'equation', b.start);
      } else if (!unnumbered && !suppressed) {
        const n = this.nextEq();
        tag = `\\tag{${n}}`;
        for (const l of labels) this.label(l, n, 'equation', b.start);
      }
      if (base === 'multline') {
        const rows = splitTopLevel(inner, '\\\\').map((r) => r.text);
        if (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
        rows[rows.length - 1] = (rows[rows.length - 1] ?? '') + tag;
        this.ctx.mathSrc.set(b.start, `\\begin{gather*}${rows.join('\\\\')}\\end{gather*}`);
      } else {
        this.ctx.mathSrc.set(b.start, inner + tag);
      }
      return;
    }

    // Multi-row environments: one number per row.
    let prefix = '';
    if (base === 'alignat') {
      const g = readGroup(inner, skipInlineSpace(inner, 0));
      if (g) {
        prefix = inner.slice(0, g.end);
        inner = inner.slice(g.end);
      }
    }
    const rows = splitTopLevel(inner, '\\\\').map((r) => r.text);
    if (rows.length > 1 && rows[rows.length - 1].trim() === '') rows.pop();
    const out = rows.map((row) => {
      const labels = [...row.matchAll(LABEL_RE)].map((m) => m[1].trim());
      row = row.replace(LABEL_RE, '');
      if (base === 'eqnarray') {
        const cells = splitTopLevel(row, '&').map((c) => c.text);
        if (cells.length === 3) row = `${cells[0]}&${cells[1]}${cells[2]}`;
      }
      const tagMatch = /\\tag\*?\s*\{([^}]*)\}/.exec(row);
      if (tagMatch) {
        for (const l of labels) this.label(l, tagMatch[1], 'equation', b.start);
        return row;
      }
      if (/\\(nonumber|notag)\b/.test(row) || unnumbered) return row.replace(/\\(nonumber|notag)\b/g, '');
      const n = this.nextEq();
      for (const l of labels) this.label(l, n, 'equation', b.start);
      return `${row}\\tag{${n}}`;
    });
    const katexEnv = base === 'gather' ? 'gather*' : base === 'alignat' ? 'alignat*' : 'align*';
    this.ctx.mathSrc.set(b.start, `\\begin{${katexEnv}}${prefix}${out.join('\\\\')}\\end{${katexEnv}}`);
  }
}

function formatEnum(n: number, depth: number): string {
  if (depth === 2) return String.fromCharCode(96 + n);
  if (depth === 3) return toRoman(n);
  if (depth >= 4) return String.fromCharCode(64 + n);
  return String(n);
}

export function toRoman(n: number): string {
  const map: [number, string][] = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
}

/** Top-level subfigure environments within a float body. */
export function findSubfigures(t: string, s: number, e: number): Range[] {
  const out: Range[] = [];
  for (let i = s; i < e; i++) {
    if (t[i] === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (t.startsWith('\\begin{subfigure}', i) || t.startsWith('\\begin{subtable}', i)) {
      const name = t.startsWith('\\begin{subfigure}', i) ? 'subfigure' : 'subtable';
      const f = findEnvEnd(t, i + 8 + name.length, name, e);
      if (!f) break;
      out.push({ start: i, end: f.end });
      i = f.end - 1;
    } else if (t.startsWith('\\subfloat', i)) {
      const args = readArgs(t, i + 9, 1, e, 2);
      out.push({ start: i, end: args.end });
      i = args.end - 1;
    }
  }
  return out;
}
