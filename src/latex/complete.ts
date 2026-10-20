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

export type CompletionKind = 'cite' | 'ref' | 'file';

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
  if (!m) return null;
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
