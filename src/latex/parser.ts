// Splits a LaTeX document into a tree of visual blocks, each tied to the
// exact source range it came from so that edits can be written back.

import {
  VERBATIM_ENVS,
  findEnvEnd,
  findOutsideComments,
  readArgs,
  readCommandName,
  readGroup,
  readOptional,
  skipComment,
  skipInlineSpace,
  trimRange,
} from './util';

export type BlockKind =
  | 'preamble'
  | 'heading'
  | 'paragraph'
  | 'math'
  | 'figure'
  | 'table'
  | 'tabular'
  | 'list'
  | 'env'
  | 'verbatim'
  | 'command'
  | 'comment';

export interface ListItem {
  start: number;
  end: number;
  /** Range of the `[label]` contents, for description lists / custom labels. */
  label?: { start: number; end: number };
  children: Block[];
}

export interface Block {
  kind: BlockKind;
  start: number;
  end: number;
  /** Environment name (env-based blocks) or command name. */
  name?: string;
  /** Inner range of an environment body. */
  innerStart?: number;
  innerEnd?: number;
  /** Heading level: -1 part, 0 chapter, 1 section ... 5 subparagraph. */
  level?: number;
  starred?: boolean;
  /** Heading title / command argument range. */
  arg?: { start: number; end: number };
  children?: Block[];
  items?: ListItem[];
  /** Paragraph that continues the previous one (no blank line before). */
  continuation?: boolean;
}

export interface ParsedDocument {
  text: string;
  preamble?: Block;
  blocks: Block[];
  bodyStart: number;
  bodyEnd: number;
  /** Offset of `\end{document}` (insertion point for new content). */
  insertPoint: number;
}

export const SECTION_LEVELS: Record<string, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

export const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'displaymath', 'math',
]);
const FIGURE_ENVS = new Set(['figure', 'figure*', 'wrapfigure']);
const TABLE_ENVS = new Set(['table', 'table*']);
const TABULAR_ENVS = new Set(['tabular', 'tabular*', 'tabularx', 'longtable', 'array']);
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);

/** Commands that form their own block, with the number of brace args they take. */
const BLOCK_COMMANDS: Record<string, number> = {
  maketitle: 0,
  tableofcontents: 0,
  listoffigures: 0,
  listoftables: 0,
  newpage: 0,
  clearpage: 0,
  cleardoublepage: 0,
  pagebreak: 0,
  appendix: 0,
  printbibliography: 0,
  bibliography: 1,
  bibliographystyle: 1,
  addbibresource: 1,
  input: 1,
  include: 1,
  title: 1,
  author: 1,
  date: 1,
  nocite: 1,
  setcounter: 2,
  addtocounter: 2,
  setlength: 2,
  addcontentsline: 3,
  newcommand: 2,
  renewcommand: 2,
  providecommand: 2,
  DeclareMathOperator: 2,
  newtheorem: 2,
  pagestyle: 1,
  thispagestyle: 1,
};

/** Spacing commands are blocks only when they stand alone between paragraphs. */
const SPACING_COMMANDS: Record<string, number> = {
  vspace: 1,
  vfill: 0,
  bigskip: 0,
  medskip: 0,
  smallskip: 0,
};

export function parseDocument(text: string): ParsedDocument {
  const begin = findOutsideComments(text, '\\begin{document}');
  if (begin === -1) {
    // A fragment (e.g. a chapter included via \input): everything is body.
    return { text, blocks: parseBlocks(text, 0, text.length), bodyStart: 0, bodyEnd: text.length, insertPoint: text.length };
  }
  const bodyStart = begin + '\\begin{document}'.length;
  const endDoc = findOutsideComments(text, '\\end{document}', bodyStart);
  const bodyEnd = endDoc === -1 ? text.length : endDoc;
  const pre = trimRange(text, 0, begin);
  const preamble: Block | undefined = pre.end > pre.start ? { kind: 'preamble', start: pre.start, end: pre.end } : undefined;
  return { text, preamble, blocks: parseBlocks(text, bodyStart, bodyEnd), bodyStart, bodyEnd, insertPoint: bodyEnd };
}

export function parseBlocks(t: string, s: number, e: number): Block[] {
  const blocks: Block[] = [];
  let paraStart = -1;
  let lastWasBlockBreak = true; // true after a blank line or at start
  let pendingContinuation = false;

  const flush = (at: number) => {
    if (paraStart === -1) return;
    const r = trimRange(t, paraStart, at);
    if (r.end > r.start) {
      const onlyComments = t
        .slice(r.start, r.end)
        .split('\n')
        .every((l) => /^\s*(%.*)?$/.test(l));
      blocks.push({
        kind: onlyComments ? 'comment' : 'paragraph',
        start: r.start,
        end: r.end,
        continuation: pendingContinuation || undefined,
      });
    }
    paraStart = -1;
    pendingContinuation = false;
  };

  const push = (b: Block) => {
    blocks.push(b);
    // Text right after a display block without a blank line continues the paragraph.
    pendingContinuation = b.kind === 'math';
    lastWasBlockBreak = false;
  };

  let i = s;
  while (i < e) {
    const c = t[i];

    if (c === '\n') {
      // Blank line → paragraph break.
      let k = i + 1;
      while (k < e && (t[k] === ' ' || t[k] === '\t' || t[k] === '\r')) k++;
      if (k < e && t[k] === '\n') {
        flush(i);
        pendingContinuation = false;
        lastWasBlockBreak = true;
        i = k;
        continue;
      }
      i++;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }

    if (c === '%') {
      if (paraStart === -1) paraStart = i;
      i = skipComment(t, i, e);
      continue;
    }

    if (c === '$') {
      if (t[i + 1] === '$') {
        const close = t.indexOf('$$', i + 2);
        const end = close === -1 || close + 2 > e ? e : close + 2;
        flush(i);
        push({ kind: 'math', name: '$$', start: i, end, innerStart: i + 2, innerEnd: close === -1 ? e : close });
        i = end;
        continue;
      }
      if (paraStart === -1) paraStart = i;
      i = skipInlineMath(t, i, e);
      continue;
    }

    if (c === '\\') {
      const name = readCommandName(t, i);
      const afterName = i + 1 + name.length;

      if (name === '[') {
        const close = t.indexOf('\\]', afterName);
        const end = close === -1 || close + 2 > e ? e : close + 2;
        flush(i);
        push({ kind: 'math', name: '\\[', start: i, end, innerStart: afterName, innerEnd: close === -1 ? e : close });
        i = end;
        continue;
      }

      if (name === 'begin') {
        const g = readGroup(t, afterName, e);
        if (g) {
          const env = t.slice(g.innerStart, g.innerEnd).trim();
          if (env !== 'math') {
            const found = findEnvEnd(t, g.end, env, e);
            const innerEnd = found ? found.innerEnd : e;
            const end = found ? found.end : e;
            flush(i);
            push(makeEnvBlock(t, env, i, g.end, innerEnd, end));
            i = end;
            continue;
          }
        }
      }

      if (name in SECTION_LEVELS) {
        const args = readArgs(t, afterName, 1, e, 1);
        if (args.required.length === 1) {
          flush(i);
          let end = args.end;
          // Attach a directly following \label to the heading.
          const k = skipInlineSpace(t, end, e);
          if (t.startsWith('\\label', k)) {
            const lg = readGroup(t, k + 6, e);
            if (lg) end = lg.end;
          }
          const arg = args.required[0];
          push({
            kind: 'heading',
            name,
            level: SECTION_LEVELS[name],
            starred: args.star,
            start: i,
            end,
            arg: { start: arg.innerStart, end: arg.innerEnd },
          });
          i = end;
          continue;
        }
      }

      const isBlockCmd = name in BLOCK_COMMANDS;
      const isSpacing = name in SPACING_COMMANDS && paraStart === -1;
      if (isBlockCmd || isSpacing) {
        let end: number;
        let arg: { start: number; end: number } | undefined;
        if (name === 'newcommand' || name === 'renewcommand' || name === 'providecommand' || name === 'DeclareMathOperator') {
          end = readDefinitionEnd(t, afterName, e);
        } else {
          const args = readArgs(t, afterName, isBlockCmd ? BLOCK_COMMANDS[name] : SPACING_COMMANDS[name], e);
          end = args.end;
          if (args.required[0]) arg = { start: args.required[0].innerStart, end: args.required[0].innerEnd };
        }
        flush(i);
        push({ kind: 'command', name, start: i, end, arg });
        i = end;
        continue;
      }

      if (name === 'def') {
        flush(i);
        const end = readDefEnd(t, afterName, e);
        push({ kind: 'command', name, start: i, end });
        i = end;
        continue;
      }

      if (paraStart === -1) {
        paraStart = i;
        if (!lastWasBlockBreak && blocks.length && blocks[blocks.length - 1].kind === 'math') pendingContinuation = true;
      }
      if (name === 'verb' || name === 'verb*') {
        i = skipVerb(t, afterName, e);
        continue;
      }
      if (name === '(') {
        const close = t.indexOf('\\)', afterName);
        i = close === -1 ? e : close + 2;
        continue;
      }
      i = afterName > i + 1 ? afterName : i + 2;
      continue;
    }

    if (paraStart === -1) paraStart = i;
    i++;
  }
  flush(e);
  return blocks;
}

function makeEnvBlock(t: string, env: string, start: number, innerStart: number, innerEnd: number, end: number): Block {
  const base = { start, end, name: env, innerStart, innerEnd };
  if (MATH_ENVS.has(env)) return { kind: 'math', ...base };
  if (FIGURE_ENVS.has(env)) return { kind: 'figure', ...base };
  if (TABLE_ENVS.has(env)) return { kind: 'table', ...base };
  if (TABULAR_ENVS.has(env)) return { kind: 'tabular', ...base };
  if (VERBATIM_ENVS.has(env)) return { kind: 'verbatim', ...base };
  if (LIST_ENVS.has(env)) return { kind: 'list', ...base, items: parseItems(t, innerStart, innerEnd) };
  if (env === 'thebibliography') return { kind: 'env', ...base, items: parseItems(t, innerStart, innerEnd, 'bibitem') };
  // Skip leading arguments such as \begin{minipage}{0.5\textwidth}.
  let bodyStart = innerStart;
  if (env === 'minipage' || env === 'subfigure' || env === 'wrapfigure') bodyStart = readArgs(t, innerStart, 1, innerEnd).end;
  else if (t[innerStart] === '[') bodyStart = readArgs(t, innerStart, 0, innerEnd, 1).end;
  return { kind: 'env', ...base, children: parseBlocks(t, bodyStart, innerEnd) };
}

/** Splits a list body at top-level `\item` (or `\bibitem`) commands. */
export function parseItems(t: string, s: number, e: number, itemCmd = 'item'): ListItem[] {
  const marks: { at: number; contentStart: number; label?: { start: number; end: number } }[] = [];
  let depth = 0;
  for (let i = s; i < e; i++) {
    const c = t[i];
    if (c === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '$') {
      i = skipInlineMath(t, i, e) - 1;
    } else if (c === '\\') {
      const name = readCommandName(t, i);
      if (name === 'begin') {
        const g = readGroup(t, i + 6, e);
        if (g) {
          const found = findEnvEnd(t, g.end, t.slice(g.innerStart, g.innerEnd).trim(), e);
          if (found) {
            i = found.end - 1;
            continue;
          }
        }
      }
      if (name === itemCmd && depth === 0) {
        let j = i + 1 + name.length;
        let label: { start: number; end: number } | undefined;
        const k = skipInlineSpace(t, j, e);
        if (t[k] === '[') {
          const g = readOptional(t, k, e);
          if (g) {
            label = { start: g.innerStart, end: g.innerEnd };
            j = g.end;
          }
        }
        if (itemCmd === 'bibitem') {
          const k2 = skipInlineSpace(t, j, e);
          const g = readGroup(t, k2, e);
          if (g) {
            // For bibitems, `label` holds the citation key.
            label = { start: g.innerStart, end: g.innerEnd };
            j = g.end;
          }
        }
        marks.push({ at: i, contentStart: j, label });
        i = j - 1;
        continue;
      }
      i += Math.max(name.length, 1);
    }
  }
  return marks.map((m, idx) => {
    const itemEnd = idx + 1 < marks.length ? marks[idx + 1].at : e;
    const r = trimRange(t, m.at, itemEnd);
    return { start: r.start, end: r.end, label: m.label, children: parseBlocks(t, m.contentStart, r.end) };
  });
}

export function skipInlineMath(t: string, i: number, e: number): number {
  // t[i] === '$'
  for (let j = i + 1; j < e; j++) {
    if (t[j] === '\\') {
      j++;
      continue;
    }
    if (t[j] === '$') return j + 1;
    if (t[j] === '\n' && t[j + 1] === '\n') return j; // unterminated: stop at paragraph break
  }
  return e;
}

function skipVerb(t: string, i: number, e: number): number {
  const delim = t[i];
  const close = t.indexOf(delim, i + 1);
  return close === -1 || close >= e ? e : close + 1;
}

/** End of `\newcommand{\foo}[n][default]{body}` (also accepts `\newcommand\foo`). */
function readDefinitionEnd(t: string, i: number, e: number): number {
  let j = skipInlineSpace(t, i, e);
  if (t[j] === '*') j++;
  if (t[j] === '{') {
    const g = readGroup(t, j, e);
    if (!g) return e;
    j = g.end;
  } else if (t[j] === '\\') {
    j += 1 + readCommandName(t, j).length;
  }
  return readArgs(t, j, 1, e).end;
}

/** End of `\def\foo#1#2{body}`. */
function readDefEnd(t: string, i: number, e: number): number {
  const open = t.indexOf('{', i);
  if (open === -1 || open >= e) return e;
  const g = readGroup(t, open, e);
  return g ? g.end : e;
}

/** Returns the innermost block (searching children and list items) containing [start, end). */
export function findDeepestBlock(blocks: Block[], offset: number): Block | undefined {
  for (const b of blocks) {
    if (offset >= b.start && offset <= b.end) {
      if (b.children) {
        const inner = findDeepestBlock(b.children, offset);
        if (inner) return inner;
      }
      if (b.items) {
        for (const it of b.items) {
          const inner = findDeepestBlock(it.children, offset);
          if (inner) return inner;
        }
      }
      return b;
    }
  }
  return undefined;
}
