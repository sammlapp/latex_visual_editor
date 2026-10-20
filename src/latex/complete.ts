// Completion data for citations (\cite{...}), cross-references (\ref{...})
// and file paths (\input{...}, \includegraphics{...}, \bibliography{...}).
// Matching is word-based: every query word must match the start of a word in
// the entry (key parts, author names, title words, year), so
// "lapp opensoundscape" finds Lapp et al., "OpenSoundscape: ...".

import { splitAuthors, lastName } from './bib';
import { Ctx } from './context';
import { renderInline, stripTags } from './render';

export interface CompletionItem {
  /** Text inserted between the braces. */
  key: string;
  /** Short description shown next to the key. */
  detail: string;
  /** Secondary line (e.g. the title). */
  info: string;
  kind?: string;
  /** Normalised words used for matching. */
  words: string[];
  /** Words that rank a little higher when matched (first author, key). */
  strong: string[];
  year?: number;
  /** Order of first citation in the document (cited entries first when the query is empty). */
  rank: number;
  /** Commands: text inserted after the backslash, with `$` marking where the caret goes. */
  snippet?: string;
  /** Commands: only valid in math mode. */
  math?: boolean;
  /** Commands: LaTeX rendered as a preview in the list. */
  preview?: string;
}

/** Lower-case and strip accents so "Körper" matches "korper". */
export function normalizeWord(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function wordsOf(s: string): string[] {
  return normalizeWord(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const plain = (s: string, ctx: Ctx) => stripTags(renderInline(s, ctx));

const citeCache = new WeakMap<object, CompletionItem[]>();

/** Completion items for every bibliography entry (.bib files and thebibliography). */
export function citationItems(ctx: Ctx): CompletionItem[] {
  const cached = citeCache.get(ctx.bib);
  if (cached && !ctx.bibitemText.size) return cached;
  const items: CompletionItem[] = [];
  for (const e of ctx.bib.values()) {
    const f = e.fields;
    const authors = splitAuthors(plain(f.author ?? f.editor ?? '', ctx));
    const lasts = authors.map(lastName);
    const title = plain(f.title ?? '', ctx);
    const year = parseInt(f.year ?? '', 10);
    const who = lasts.length > 2 ? `${lasts[0]} et al.` : lasts.join(' & ');
    const words = [...wordsOf(e.key), ...authors.flatMap(wordsOf), ...wordsOf(title), ...wordsOf(f.year ?? ''),
      ...wordsOf(plain(f.journal ?? f.booktitle ?? '', ctx))];
    items.push({
      key: e.key,
      detail: [who, f.year ? `(${f.year})` : ''].filter(Boolean).join(' '),
      info: title,
      words,
      strong: [normalizeWord(e.key), ...(lasts[0] ? wordsOf(lasts[0]) : [])],
      year: Number.isFinite(year) ? year : undefined,
      rank: ctx.cites.get(e.key) ?? Infinity,
    });
  }
  for (const [key, r] of ctx.bibitemText) {
    if (ctx.bib.has(key)) continue;
    const text = plain(ctx.text.slice(r.start, r.end), ctx);
    items.push({ key, detail: '', info: text.slice(0, 120), words: [...wordsOf(key), ...wordsOf(text)], strong: [normalizeWord(key)], rank: ctx.cites.get(key) ?? Infinity });
  }
  if (!ctx.bibitemText.size) citeCache.set(ctx.bib, items);
  return items;
}

const KIND_NAMES: Record<string, string> = { equation: 'Equation', figure: 'Figure', table: 'Table', section: 'Section', theorem: 'Theorem', item: 'Item', other: '' };

/** Completion items for every \label in the document. */
export function labelItems(ctx: Ctx): CompletionItem[] {
  let i = 0;
  return [...ctx.labels.entries()].map(([key, l]) => {
    const kind = KIND_NAMES[l.kind] ?? '';
    return {
      key,
      detail: `${kind} ${l.num}`.trim(),
      info: '',
      kind: l.kind,
      words: [...wordsOf(key), ...wordsOf(kind), normalizeWord(l.num)],
      strong: [normalizeWord(key)],
      rank: i++,
    };
  });
}

/** Scores one query word against an item: exact word 3, word prefix 2, inside the key 1. */
function scoreWord(q: string, item: CompletionItem): number {
  let best = 0;
  for (const w of item.words) {
    if (w === q) return 3 + (item.strong.includes(w) ? 1 : 0);
    if (w.startsWith(q)) best = Math.max(best, 2 + (item.strong.includes(w) ? 0.5 : 0));
  }
  if (!best && q.length >= 2 && item.strong.some((s) => s.includes(q))) best = 1;
  return best;
}

/** Filters and ranks items for a query; every query word must match. */
export function filterCompletions(items: CompletionItem[], query: string, limit = 8): CompletionItem[] {
  const qs = wordsOf(query);
  // A query typed as a key ("knuth1984", "fig:pair-a") also matches the key exactly.
  const raw = normalizeWord(query.trim());
  if (!qs.length) {
    return [...items].sort((a, b) => a.rank - b.rank || (b.year ?? 0) - (a.year ?? 0) || a.key.localeCompare(b.key)).slice(0, limit);
  }
  const scored: { item: CompletionItem; score: number }[] = [];
  for (const item of items) {
    let total = 0;
    let ok = true;
    for (const q of qs) {
      const s = scoreWord(q, item);
      if (!s) {
        ok = false;
        break;
      }
      total += s;
    }
    if (!ok) continue;
    const key = normalizeWord(item.key);
    if (key === raw) total += 10;
    else if (key.startsWith(raw)) total += 2;
    scored.push({ item, score: total });
  }
  scored.sort((a, b) => b.score - a.score || a.item.rank - b.item.rank || (b.item.year ?? 0) - (a.item.year ?? 0) || a.item.key.localeCompare(b.item.key));
  return scored.slice(0, limit).map((s) => s.item);
}

/** What a file-taking command accepts, and whether the extension is written. */
const FILE_COMMANDS: Record<string, { exts: string[] | null; dropExt: boolean }> = {
  input: { exts: ['.tex'], dropExt: true },
  include: { exts: ['.tex'], dropExt: true },
  subfile: { exts: ['.tex'], dropExt: true },
  includegraphics: { exts: ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.gif'], dropExt: false },
  includesvg: { exts: ['.svg'], dropExt: false },
  includepdf: { exts: ['.pdf'], dropExt: false },
  bibliography: { exts: ['.bib'], dropExt: true },
  addbibresource: { exts: ['.bib'], dropExt: false },
  lstinputlisting: { exts: null, dropExt: false },
  verbatiminput: { exts: null, dropExt: false },
  inputminted: { exts: null, dropExt: false },
};

const extOf = (f: string) => /(\.[^./]+)$/.exec(f)?.[1].toLowerCase() ?? '';

/**
 * Completion items for the files a command can take. `files` are paths
 * relative to the document's folder; graphics inside a \graphicspath folder
 * are also offered relative to that folder.
 */
export function fileItems(files: string[], command: string, graphicsPaths: string[] = []): CompletionItem[] {
  const spec = FILE_COMMANDS[command] ?? { exts: null, dropExt: false };
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const sorted = files
    .filter((f) => !spec.exts || spec.exts.includes(extOf(f)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const f of sorted) {
    const ext = extOf(f);
    const prefixes = command === 'includegraphics' ? graphicsPaths.filter((p) => p && f.startsWith(p)) : [];
    for (const p of [...prefixes, '']) {
      let key = f.slice(p.length);
      if (spec.dropExt && ext) key = key.slice(0, -ext.length);
      if (seen.has(key)) continue;
      seen.add(key);
      const name = key.split('/').pop()!;
      items.push({
        key,
        detail: p ? `in ${p}` : '',
        info: '',
        kind: 'file',
        words: wordsOf(key),
        strong: [normalizeWord(name), ...wordsOf(name)],
        rank: items.length,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// LaTeX commands and environments

/** [name, description, snippet ($ = caret), preview] for math-mode commands. */
const MATH_COMMANDS: [string, string, string?, string?][] = [
  ...'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'
    .split(' ')
    .map((g): [string, string] => [g, `Greek ${g[0] === g[0].toUpperCase() ? 'capital ' : ''}letter`]),
  ['frac', 'fraction', 'frac{$}{}', '\\frac{a}{b}'],
  ['dfrac', 'display-style fraction', 'dfrac{$}{}', '\\dfrac{a}{b}'],
  ['tfrac', 'text-style fraction', 'tfrac{$}{}', '\\tfrac{a}{b}'],
  ['sqrt', 'square root', 'sqrt{$}', '\\sqrt{x}'],
  ['sum', 'sum'],
  ['prod', 'product'],
  ['int', 'integral'],
  ['iint', 'double integral'],
  ['oint', 'contour integral'],
  ['lim', 'limit', 'lim_{$}', '\\lim_{x\\to 0}'],
  ['infty', 'infinity'],
  ['partial', 'partial derivative'],
  ['nabla', 'nabla, gradient'],
  ['pm', 'plus-minus'],
  ['mp', 'minus-plus'],
  ['times', 'times, multiplication'],
  ['div', 'division'],
  ['cdot', 'centred dot, multiplication'],
  ['cdots', 'centred dots'],
  ['vdots', 'vertical dots'],
  ['ddots', 'diagonal dots'],
  ['leq', 'less than or equal'],
  ['geq', 'greater than or equal'],
  ['neq', 'not equal'],
  ['approx', 'approximately equal'],
  ['equiv', 'equivalent, identical'],
  ['sim', 'similar, distributed as'],
  ['simeq', 'similar or equal'],
  ['propto', 'proportional to'],
  ['ll', 'much less than'],
  ['gg', 'much greater than'],
  ['in', 'element of'],
  ['notin', 'not an element of'],
  ['subset', 'subset'],
  ['subseteq', 'subset or equal'],
  ['supset', 'superset'],
  ['supseteq', 'superset or equal'],
  ['cup', 'union'],
  ['cap', 'intersection'],
  ['bigcup', 'big union'],
  ['bigcap', 'big intersection'],
  ['setminus', 'set difference'],
  ['emptyset', 'empty set'],
  ['varnothing', 'empty set'],
  ['forall', 'for all'],
  ['exists', 'there exists'],
  ['neg', 'logical not'],
  ['land', 'logical and'],
  ['lor', 'logical or'],
  ['wedge', 'wedge, and'],
  ['vee', 'vee, or'],
  ['oplus', 'circled plus, direct sum'],
  ['otimes', 'circled times, tensor product'],
  ['circ', 'composition, circle'],
  ['star', 'star'],
  ['ast', 'asterisk'],
  ['dagger', 'dagger'],
  ['to', 'right arrow, maps to'],
  ['rightarrow', 'right arrow'],
  ['leftarrow', 'left arrow'],
  ['leftrightarrow', 'left-right arrow'],
  ['Rightarrow', 'double right arrow, implies'],
  ['Leftarrow', 'double left arrow'],
  ['Leftrightarrow', 'double left-right arrow, if and only if'],
  ['implies', 'implies (long double arrow)'],
  ['iff', 'if and only if (long double arrow)'],
  ['longrightarrow', 'long right arrow'],
  ['mapsto', 'maps to'],
  ['uparrow', 'up arrow'],
  ['downarrow', 'down arrow'],
  ['xrightarrow', 'arrow with text above', 'xrightarrow{$}', '\\xrightarrow{f}'],
  ['hat', 'hat accent', 'hat{$}', '\\hat{x}'],
  ['widehat', 'wide hat accent', 'widehat{$}', '\\widehat{xy}'],
  ['bar', 'bar accent', 'bar{$}', '\\bar{x}'],
  ['overline', 'overline', 'overline{$}', '\\overline{xy}'],
  ['tilde', 'tilde accent', 'tilde{$}', '\\tilde{x}'],
  ['widetilde', 'wide tilde accent', 'widetilde{$}', '\\widetilde{xy}'],
  ['vec', 'vector arrow', 'vec{$}', '\\vec{x}'],
  ['dot', 'dot accent, time derivative', 'dot{$}', '\\dot{x}'],
  ['ddot', 'double dot accent', 'ddot{$}', '\\ddot{x}'],
  ['overbrace', 'brace above', 'overbrace{$}^{}', '\\overbrace{a+b}^{n}'],
  ['underbrace', 'brace below', 'underbrace{$}_{}', '\\underbrace{a+b}_{n}'],
  ['mathbb', 'blackboard bold (ℝ, ℕ)', 'mathbb{$}', '\\mathbb{R}'],
  ['mathcal', 'calligraphic', 'mathcal{$}', '\\mathcal{L}'],
  ['mathbf', 'bold', 'mathbf{$}', '\\mathbf{x}'],
  ['boldsymbol', 'bold symbol', 'boldsymbol{$}', '\\boldsymbol{\\theta}'],
  ['mathrm', 'upright (roman)', 'mathrm{$}', '\\mathrm{d}x'],
  ['mathit', 'italic', 'mathit{$}', '\\mathit{xy}'],
  ['mathsf', 'sans-serif', 'mathsf{$}', '\\mathsf{x}'],
  ['operatorname', 'operator name', 'operatorname{$}', '\\operatorname{argmax}'],
  ['text', 'text inside math', 'text{$}', '\\text{if }x'],
  ['binom', 'binomial coefficient', 'binom{$}{}', '\\binom{n}{k}'],
  ['langle', 'left angle bracket'],
  ['rangle', 'right angle bracket'],
  ['lfloor', 'left floor'],
  ['rfloor', 'right floor'],
  ['lceil', 'left ceiling'],
  ['rceil', 'right ceiling'],
  ['left', 'auto-sized delimiter', 'left( $ \\right)', '\\left(\\frac{a}{b}\\right)'],
  ['ell', 'script l'],
  ['hbar', 'reduced Planck constant'],
  ['Re', 'real part'],
  ['Im', 'imaginary part'],
  ['aleph', 'aleph'],
  ['angle', 'angle'],
  ['perp', 'perpendicular'],
  ['parallel', 'parallel'],
  ['mid', 'divides, such that'],
  ['prime', 'prime'],
  ['log', 'logarithm'],
  ['ln', 'natural logarithm'],
  ['exp', 'exponential'],
  ['sin', 'sine'],
  ['cos', 'cosine'],
  ['tan', 'tangent'],
  ['max', 'maximum'],
  ['min', 'minimum'],
  ['arg', 'argument'],
  ['det', 'determinant'],
  ['sup', 'supremum'],
  ['inf', 'infimum'],
  ['displaystyle', 'display style'],
];

/** [name, description, snippet ($ = caret)] for commands usable in running text (some in math too). */
const TEXT_COMMANDS: [string, string, string?][] = [
  ['textbf', 'bold', 'textbf{$}'],
  ['emph', 'emphasis (italic)', 'emph{$}'],
  ['cite', 'citation', 'cite{$}'],
  ['citep', 'parenthetical citation (natbib)', 'citep{$}'],
  ['citet', 'textual citation (natbib)', 'citet{$}'],
  ['ref', 'cross-reference', 'ref{$}'],
  ['eqref', 'equation reference', 'eqref{$}'],
  ['autoref', 'reference with its name (hyperref)', 'autoref{$}'],
  ['cref', 'clever reference (cleveref)', 'cref{$}'],
  ['label', 'label for cross-references', 'label{$}'],
  ['footnote', 'footnote', 'footnote{$}'],
  ['textit', 'italic', 'textit{$}'],
  ['underline', 'underline', 'underline{$}'],
  ['texttt', 'monospace, typewriter', 'texttt{$}'],
  ['textsc', 'small caps', 'textsc{$}'],
  ['textsf', 'sans-serif', 'textsf{$}'],
  ['textrm', 'roman (serif)', 'textrm{$}'],
  ['textsuperscript', 'superscript', 'textsuperscript{$}'],
  ['textsubscript', 'subscript', 'textsubscript{$}'],
  ['textcolor', 'coloured text (xcolor)', 'textcolor{$}{}'],
  ['url', 'URL', 'url{$}'],
  ['href', 'link with text', 'href{$}{}'],
  ['section', 'section heading', 'section{$}'],
  ['subsection', 'subsection heading', 'subsection{$}'],
  ['subsubsection', 'subsubsection heading', 'subsubsection{$}'],
  ['paragraph', 'paragraph heading', 'paragraph{$}'],
  ['chapter', 'chapter heading', 'chapter{$}'],
  ['begin', 'begin an environment', 'begin{$}'],
  ['end', 'end an environment', 'end{$}'],
  ['item', 'list item'],
  ['includegraphics', 'image', 'includegraphics[width=\\linewidth]{$}'],
  ['caption', 'caption', 'caption{$}'],
  ['input', 'include another .tex file', 'input{$}'],
  ['include', 'include another .tex file (new page)', 'include{$}'],
  ['newline', 'line break'],
  ['newpage', 'page break'],
  ['clearpage', 'page break, flush floats'],
  ['noindent', 'no paragraph indent'],
  ['centering', 'centre the contents'],
  ['hspace', 'horizontal space', 'hspace{$}'],
  ['vspace', 'vertical space', 'vspace{$}'],
  ['quad', 'space (1em)'],
  ['qquad', 'space (2em)'],
  ['ldots', 'ellipsis …'],
  ['today', "today's date"],
  ['LaTeX', 'LaTeX logo'],
  ['TeX', 'TeX logo'],
  ['small', 'smaller font'],
  ['footnotesize', 'footnote-size font'],
  ['large', 'larger font'],
  ['mbox', 'unbreakable box', 'mbox{$}'],
  ['textbackslash', 'backslash \\'],
  ['S', 'section sign §'],
  ['P', 'paragraph sign ¶'],
  ['copyright', 'copyright ©'],
  ['dag', 'dagger †'],
  ['tableofcontents', 'table of contents'],
  ['maketitle', 'title block'],
  ['newcommand', 'define a command', 'newcommand{\\$}{}'],
];

/** [name, arguments after \begin{name}, math] */
const ENVIRONMENTS: [string, string, boolean?][] = [
  ['equation', ''], ['equation*', ''], ['align', ''], ['align*', ''], ['gather', ''], ['multline', ''],
  ['itemize', ''], ['enumerate', ''], ['description', ''], ['figure', '[htbp]'], ['table', '[htbp]'],
  ['tabular', '{lll}'], ['center', ''], ['flushleft', ''], ['flushright', ''], ['quote', ''], ['abstract', ''],
  ['theorem', ''], ['lemma', ''], ['proposition', ''], ['corollary', ''], ['definition', ''], ['remark', ''], ['proof', ''],
  ['minipage', '{0.45\\linewidth}'], ['verbatim', ''], ['subfigure', '{0.45\\linewidth}'],
  ['cases', '', true], ['pmatrix', '', true], ['bmatrix', '', true], ['matrix', '', true], ['aligned', '', true], ['array', '{cc}', true],
];

let staticCommands: CompletionItem[] | undefined;

function commandItem(name: string, detail: string, rank: number, snippet?: string, math?: boolean, preview?: string): CompletionItem {
  return { key: name, detail, info: '', kind: 'command', words: [normalizeWord(name), ...wordsOf(detail)], strong: [normalizeWord(name)], rank, snippet, math, preview };
}

/** Completion items for LaTeX commands: common built-ins plus the document's own macros. */
export function commandItems(ctx: Ctx): CompletionItem[] {
  staticCommands ??= [
    ...TEXT_COMMANDS.map(([n, d, s], k) => commandItem(n, d, k, s)),
    ...MATH_COMMANDS.map(([n, d, s, p], k) => commandItem(n, d, 1000 + k, s, true, p)),
  ];
  const own: CompletionItem[] = [];
  const known = new Set(staticCommands.map((c) => c.key));
  for (const [name, m] of ctx.textMacros) {
    if (known.has(name)) continue;
    known.add(name);
    const args = '{}'.repeat(Math.max(0, m.nargs - (m.optDefault !== undefined ? 1 : 0)));
    own.push(commandItem(name, 'defined in this document', -1, args ? `${name}${args.replace('{}', '{$}')}` : undefined, false, `\\${name}${args.replace(/\{\}/g, '{x}')}`));
  }
  for (const macro of Object.keys(ctx.katexMacros)) {
    const name = macro.slice(1);
    if (known.has(name)) continue;
    own.push(commandItem(name, 'math operator defined in this document', -1, undefined, true));
  }
  return [...own, ...staticCommands];
}

export function environmentItems(): CompletionItem[] {
  return ENVIRONMENTS.map(([n, args, math], k) => ({ ...commandItem(n, math ? 'math environment' : 'environment', k, args ? `${n}}${args}` : undefined, math), kind: 'env' }));
}

/** True when position `pos` of a LaTeX snippet is inside $…$ or \(…\). */
export function inMath(s: string, pos: number): boolean {
  let math = false;
  for (let i = 0; i < pos; i++) {
    if (s[i] === '\\') {
      if (s[i + 1] === '(' || s[i + 1] === '[') math = true;
      else if (s[i + 1] === ')' || s[i + 1] === ']') math = false;
      i++;
    } else if (s[i] === '$') math = !math;
  }
  return math;
}

export type CompletionKind = 'cite' | 'ref' | 'file' | 'command' | 'env';

export interface CompletionContext {
  kind: CompletionKind;
  /** The command name, e.g. "citep" or "eqref". */
  command: string;
  /** Text typed for the current key (after "{" or the last ","). */
  query: string;
  /** Offsets in the scanned string of the text to replace. */
  from: number;
  to: number;
}

const CITE_RE = /\\([A-Za-z]*cite[A-Za-z]*|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)$/;
const REF_RE = /\\(ref|eqref|autoref|Autoref|cref|Cref|pageref|nameref|vref|cpageref|labelcref)\s*\{([^{}]*)$/;
const FILE_RE = new RegExp(String.raw`\\(${Object.keys(FILE_COMMANDS).join('|')})\*?(?:\s*\[[^\]]*\])*\s*(?:\{[^{}]*\}\s*)?\{([^{}]*)$`);

/**
 * Finds a citation/reference key or file path being typed at `caret` in `s`.
 * The replaced range also covers key characters right after the caret, so
 * accepting a suggestion in the middle of an existing key replaces the whole key.
 */
export function completionAt(s: string, caret: number): CompletionContext | null {
  const before = s.slice(0, caret);
  let kind: CompletionKind = 'cite';
  let m = CITE_RE.exec(before);
  if (!m && (m = REF_RE.exec(before))) kind = 'ref';
  if (!m && (m = FILE_RE.exec(before))) kind = 'file';
  if (!m) {
    // An environment name after \begin{ / \end{, or a command name after \.
    const env = /\\(begin|end)\s*\{([A-Za-z*]*)$/.exec(before);
    const cmd = env ? null : /(?:^|[^\\])\\([A-Za-z]*)$/.exec(before);
    if (!env && !cmd) return null;
    const query = env ? env[2] : cmd![1];
    let to = caret;
    while (to < s.length && (env ? /[A-Za-z*]/ : /[A-Za-z]/).test(s[to])) to++;
    return { kind: env ? 'env' : 'command', command: env ? env[1] : '', query, from: caret - query.length, to };
  }
  // Only bibliography lists hold several files; a path may contain spaces.
  const list = kind !== 'file' || m[1] === 'bibliography';
  const inside = m[2];
  const segment = list ? inside.slice(inside.lastIndexOf(',') + 1) : inside;
  const lead = segment.length - segment.trimStart().length;
  const from = caret - segment.length + lead;
  let to = caret;
  while (to < s.length && !(list ? /[,}\s]/ : /[}\n]/).test(s[to])) to++;
  return { kind, command: m[1], query: s.slice(from, caret), from, to };
}
