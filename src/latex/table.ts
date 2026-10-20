// Structural table editing: parses a tabular-like environment into rows and
// cells (keeping each cell's LaTeX untouched), applies operations such as
// inserting a column or merging cells, and writes the environment back.

import { Block } from './parser';
import { findEnvEnd, readArgs, readCommandName, readGroup, readOptional, skipComment, skipInlineSpace, splitTopLevel, trimRange } from './util';

export const TABLE_ENVS = ['tabular', 'tabular*', 'tabularx', 'longtable'];

/** One column of the column spec: decorations before it (`|`, `@{}`, `>{…}`) and the column type itself. */
export interface ColToken {
  pre: string;
  core: string;
}

export interface TableCell {
  /** Cell content (inside \multicolumn when spanning). */
  src: string;
  /** Source range of `src` in the document (only valid for a freshly parsed model). */
  start: number;
  end: number;
  span: number;
  /** \multicolumn column spec, when the cell is a \multicolumn. */
  mcSpec?: string;
}

export interface TableRow {
  /** Rule commands (and the like) before the row, as written. */
  pre: string;
  cells: TableCell[];
  /** Row terminator, e.g. `\\` or `\\[2pt]`; empty for a last row without one. */
  end: string;
  /** A row kept verbatim (longtable caption, \endhead…). */
  raw?: string;
}

export interface TableModel {
  /** Source range of the whole environment. */
  start: number;
  end: number;
  env: string;
  /** Arguments between \begin{env} and the column spec, e.g. `{\linewidth}` or `[t]`. */
  head: string;
  cols: ColToken[];
  /** Spec text after the last column (e.g. a closing `|`). */
  specTail: string;
  rows: TableRow[];
  /** Rules after the last row (e.g. \bottomrule). */
  tail: string;
  /** Indentation of the line holding \begin{env}. */
  indent: string;
}

const RULE_CMDS = new Set([
  'hline', 'toprule', 'midrule', 'bottomrule', 'cline', 'cmidrule', 'specialrule', 'addlinespace', 'hhline', 'rowcolor',
  'noalign', 'morecmidrules', 'cdashline', 'hdashline', 'endhead', 'endfirsthead', 'endfoot', 'endlastfoot',
]);
const FULL_RULE = /\\(?:hline|toprule|midrule|bottomrule)\b(?:\s*\[[^\]]*\])?/g;

// ---------------------------------------------------------------------------
// Locating and parsing

/** The innermost table environment containing `offset`. */
export function findTableAt(t: string, offset: number): TableModel | null {
  const re = /\\begin\s*\{(tabular\*?|tabularx|longtable)\}/g;
  let best: TableModel | null = null;
  for (let m = re.exec(t); m && m.index < offset; m = re.exec(t)) {
    const f = findEnvEnd(t, m.index + m[0].length, m[1]);
    if (f && f.end > offset) best = parseTable(t, m.index) ?? best;
  }
  return best;
}

/** Parses the table environment whose `\begin` is at `start`. */
export function parseTable(t: string, start: number): TableModel | null {
  const nameGroup = readGroup(t, skipInlineSpace(t, start + 6));
  if (!nameGroup) return null;
  const env = t.slice(nameGroup.innerStart, nameGroup.innerEnd).trim();
  if (!TABLE_ENVS.includes(env)) return null;
  const f = findEnvEnd(t, nameGroup.end, env);
  if (!f) return null;
  let j = nameGroup.end;
  if (env === 'tabular*' || env === 'tabularx') j = readArgs(t, j, 1, f.innerEnd, 0).end;
  j = skipInlineSpace(t, j, f.innerEnd);
  if (t[j] === '[') j = readOptional(t, j, f.innerEnd)?.end ?? j;
  const specStart = skipInlineSpace(t, j, f.innerEnd);
  const spec = readGroup(t, specStart, f.innerEnd);
  if (!spec) return null;
  const { cols, tail: specTail } = tokenizeColSpec(t.slice(spec.innerStart, spec.innerEnd));
  const lineStart = t.lastIndexOf('\n', start - 1) + 1;
  const model: TableModel = {
    start,
    end: f.end,
    env,
    head: t.slice(nameGroup.end, specStart).trim(),
    cols,
    specTail,
    rows: [],
    tail: '',
    indent: /^[ \t]*/.exec(t.slice(lineStart, start))![0],
  };

  const body = spec.end;
  const segs = splitTopLevel(t.slice(body, f.innerEnd), '\\\\').map((s) => ({ start: body + s.start, end: body + s.end }));
  segs.forEach((seg, k) => {
    const next = segs[k + 1];
    const end = next ? t.slice(seg.end, next.start).trim() : '';
    const restStart = skipRules(t, seg.start, seg.end);
    const pre = t.slice(seg.start, restStart).trim();
    const rest = trimRange(t, restStart, seg.end);
    if (rest.start >= rest.end) {
      if (!next) model.tail = pre;
      else model.rows.push({ pre, cells: [], end, raw: '' });
      return;
    }
    const content = t.slice(rest.start, rest.end);
    if (/\\(caption|endhead|endfirsthead|endfoot|endlastfoot)\b/.test(content)) {
      model.rows.push({ pre, cells: [], end, raw: content });
      return;
    }
    // Split the untrimmed row, as the renderer does, so empty cells sit at the same offsets.
    const cells = splitTopLevel(t.slice(restStart, seg.end), '&').map((c) => parseCell(t, restStart + c.start, restStart + c.end));
    model.rows.push({ pre, cells, end });
  });
  return model;
}

function parseCell(t: string, s: number, e: number): TableCell {
  const r = trimRange(t, s, e);
  if (t.startsWith('\\multicolumn', r.start)) {
    const a = readArgs(t, r.start + '\\multicolumn'.length, 3, r.end, 0);
    if (a.required.length === 3 && trimRange(t, a.end, r.end).start === r.end) {
      const [n, spec, content] = a.required;
      const c = trimRange(t, content.innerStart, content.innerEnd);
      return {
        src: t.slice(c.start, c.end),
        start: c.start,
        end: c.end,
        span: Math.max(1, parseInt(t.slice(n.innerStart, n.innerEnd), 10) || 1),
        mcSpec: t.slice(spec.innerStart, spec.innerEnd).trim(),
      };
    }
  }
  return { src: t.slice(r.start, r.end), start: r.start, end: r.end, span: 1 };
}

/** Skips whitespace, comments and rule commands (with their arguments) at the start of a row. */
function skipRules(t: string, s: number, e: number): number {
  let i = s;
  while (i < e) {
    while (i < e && /\s/.test(t[i])) i++;
    if (t[i] === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (t[i] !== '\\') break;
    const name = readCommandName(t, i);
    if (!RULE_CMDS.has(name)) break;
    let j = i + 1 + name.length;
    const k = skipInlineSpace(t, j, e);
    if (t[k] === '(') {
      const close = t.indexOf(')', k);
      if (close !== -1 && close < e) j = close + 1;
    }
    const nReq = name === 'cline' || name === 'cmidrule' || name === 'cdashline' || name === 'rowcolor' || name === 'noalign' || name === 'hhline' ? 1 : name === 'specialrule' ? 3 : 0;
    i = readArgs(t, j, nReq, e, 1).end;
  }
  return i;
}

/** Splits a column spec into columns, keeping decorations. `*{n}{…}` is expanded. */
export function tokenizeColSpec(spec: string): { cols: ColToken[]; tail: string } {
  spec = spec.replace(/\*\s*\{(\d+)\}\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_m, n, s) => s.repeat(Number(n)));
  const cols: ColToken[] = [];
  let pre = '';
  let i = 0;
  while (i < spec.length) {
    const c = spec[i];
    if (/\s/.test(c)) {
      i++;
    } else if ('@!><'.includes(c)) {
      const g = readGroup(spec, skipInlineSpace(spec, i + 1));
      const end = g ? g.end : i + 1;
      pre += spec.slice(i, end);
      i = end;
    } else if (c === '|') {
      pre += c;
      i++;
    } else if ('pmbw'.includes(c) && spec[skipInlineSpace(spec, i + 1)] === '{') {
      const g = readGroup(spec, skipInlineSpace(spec, i + 1))!;
      cols.push({ pre, core: `${c}{${spec.slice(g.innerStart, g.innerEnd)}}` });
      pre = '';
      i = g.end;
    } else {
      cols.push({ pre, core: c });
      pre = '';
      i++;
    }
  }
  return { cols, tail: pre };
}

// ---------------------------------------------------------------------------
// Writing

export interface Serialized {
  src: string;
  /** Per row, per cell: offset of the cell content within `src` (undefined for raw rows). */
  cells: number[][];
}

export function serializeTable(m: TableModel, indent = m.indent): Serialized {
  const inner = indent + '  ';
  const spec = m.cols.map((c) => c.pre + c.core).join('') + m.specTail;
  let src = `\\begin{${m.env}}${m.head}{${spec}}\n`;
  const cells: number[][] = [];
  for (const row of m.rows) {
    if (row.pre) src += `${inner}${row.pre}\n`;
    const offs: number[] = [];
    if (row.raw !== undefined) {
      src += `${inner}${row.raw}${row.end ? ' ' + row.end : ''}\n`;
    } else {
      src += inner;
      // No space after an empty cell: an empty cell's position is then where the renderer puts it (just before the next `&`).
      row.cells.forEach((c, k) => {
        const prev = row.cells[k - 1]?.src;
        if (k) src += /(^|[^\\])%/.test(prev) ? `\n${inner}& ` : prev ? ' & ' : '& ';
        if (c.mcSpec !== undefined || c.span > 1) {
          src += `\\multicolumn{${c.span}}{${c.mcSpec ?? 'c'}}{`;
          offs.push(src.length);
          src += `${c.src}}`;
        } else {
          offs.push(src.length);
          src += c.src;
        }
      });
      // A trailing comment would swallow the row terminator.
      const lastSrc = row.cells[row.cells.length - 1]?.src ?? '';
      src += `${row.end ? (/(^|[^\\])%/.test(lastSrc) ? `\n${inner}` : lastSrc ? ' ' : '') + row.end : ''}\n`;
    }
    cells.push(offs);
  }
  if (m.tail) src += `${inner}${m.tail}\n`;
  src += `${indent}\\end{${m.env}}`;
  return { src, cells };
}

// ---------------------------------------------------------------------------
// Operations. Each mutates the model and returns the cell to put the caret in.

export interface CellPos {
  row: number;
  col: number;
}

const empty = (): TableCell => ({ src: '', start: -1, end: -1, span: 1 });

export const isDataRow = (r: TableRow) => r.raw === undefined;

/** Index of the cell covering logical column `col`, and the column that cell starts at. */
export function cellAt(row: TableRow, col: number): { index: number; startCol: number } | null {
  let c = 0;
  for (let k = 0; k < row.cells.length; k++) {
    const span = row.cells[k].span;
    if (col < c + span) return { index: k, startCol: c };
    c += span;
  }
  return null;
}

export const rowWidth = (row: TableRow) => row.cells.reduce((n, c) => n + c.span, 0);

/** Row and logical column of the cell whose content range contains `offset`. */
export function cellPosAt(m: TableModel, offset: number): (CellPos & { index: number }) | null {
  for (let r = 0; r < m.rows.length; r++) {
    let col = 0;
    for (let k = 0; k < m.rows[r].cells.length; k++) {
      const c = m.rows[r].cells[k];
      if (c.start <= offset && offset <= c.end) return { row: r, col, index: k };
      col += c.span;
    }
  }
  return null;
}

export function insertRow(m: TableModel, row: number, below: boolean): CellPos {
  const at = below ? row + 1 : row;
  const width = Math.max(m.cols.length, ...m.rows.filter(isDataRow).map(rowWidth));
  // The new row takes over the rules above the row it pushes down, so a header rule stays above the body.
  const pushed = m.rows[at];
  const pre = pushed && isDataRow(pushed) ? pushed.pre : '';
  if (pushed && isDataRow(pushed)) pushed.pre = '';
  m.rows.splice(at, 0, { pre, cells: Array.from({ length: width }, empty), end: '\\\\' });
  // A last row without \\ needs one now that another row follows it.
  for (let r = 0; r < m.rows.length - 1; r++) if (!m.rows[r].end) m.rows[r].end = '\\\\';
  return { row: at, col: 0 };
}

export function deleteRow(m: TableModel, row: number): CellPos | null {
  if (m.rows.filter(isDataRow).length <= 1) return null;
  const [gone] = m.rows.splice(row, 1);
  const next = m.rows[row];
  if (next && !next.pre) next.pre = gone.pre;
  return { row: Math.min(row, m.rows.length - 1), col: 0 };
}

export function insertCol(m: TableModel, col: number, right: boolean): CellPos {
  const ref = m.rows.find(isDataRow);
  const covering = ref ? cellAt(ref, col) : null;
  const at = right ? (covering ? covering.startCol + ref!.cells[covering.index].span : col + 1) : covering ? covering.startCol : col;
  const like = m.cols[Math.min(col, m.cols.length - 1)];
  const tok: ColToken = { pre: like?.pre.match(ALIGN_ANY)?.[0] ?? '', core: like?.core ?? 'l' };
  if (at === 0 && m.cols[0]) {
    // Keep the table's left edge decoration (| or @{}) on the new first column.
    const old = m.cols[0];
    tok.pre = old.pre.replace(ALIGN_ANY, '') + tok.pre;
    old.pre = old.pre.match(ALIGN_ANY)?.[0] ?? '';
  }
  m.cols.splice(at, 0, tok);
  for (const row of m.rows) {
    if (!isDataRow(row)) continue;
    const width = rowWidth(row);
    if (at >= width) {
      if (at === width) row.cells.push(empty());
      continue;
    }
    const c = cellAt(row, at)!;
    if (c.startCol === at) row.cells.splice(c.index, 0, empty());
    else row.cells[c.index].span++;
  }
  return { row: m.rows.findIndex(isDataRow), col: at };
}

export function deleteCol(m: TableModel, col: number): CellPos | null {
  if (m.cols.length <= 1) return null;
  const [gone] = m.cols.splice(col, 1);
  if (col === 0 && m.cols[0]) m.cols[0].pre = gone.pre.replace(/[^|]/g, '') + m.cols[0].pre;
  for (const row of m.rows) {
    if (!isDataRow(row)) continue;
    const c = cellAt(row, col);
    if (!c) continue;
    const cell = row.cells[c.index];
    if (cell.span > 1) {
      cell.span--;
      if (cell.span === 1 && /^[lcr]$/.test(cell.mcSpec ?? '')) delete cell.mcSpec;
    } else if (row.cells.length > 1) row.cells.splice(c.index, 1);
    else cell.src = '';
  }
  return { row: m.rows.findIndex(isDataRow), col: Math.min(col, m.cols.length - 1) };
}

const ALIGN_ANY = />\{\\(?:centering|raggedleft|raggedright)\\arraybackslash\s*\}/;
const ALIGN_PREFIX = new RegExp(ALIGN_ANY.source, 'g');
const ALIGN_CMD: Record<string, string> = { l: 'raggedright', c: 'centering', r: 'raggedleft' };

export type Align = 'l' | 'c' | 'r';

/** Alignment and width of a column (a width means the column wraps its text). */
export function colInfo(tok: ColToken): { align: Align; width?: string } {
  const w = /^[pmbw]\{(.*)\}$/.exec(tok.core);
  if (w || tok.core === 'X') {
    const a = /\\(centering|raggedleft|raggedright)/.exec(tok.pre)?.[1];
    return { align: a === 'centering' ? 'c' : a === 'raggedleft' ? 'r' : 'l', width: w ? w[1] : undefined };
  }
  return { align: tok.core === 'c' || tok.core === 'r' ? tok.core : 'l' };
}

/** Sets a column's alignment. Returns true when the array package is needed (for wrapped columns). */
export function setColAlign(m: TableModel, col: number, align: Align): boolean {
  const tok = m.cols[col];
  if (!tok) return false;
  if (/^[lcrS]$/.test(tok.core)) {
    tok.core = align;
    return false;
  }
  tok.pre = tok.pre.replace(ALIGN_PREFIX, '');
  tok.pre = `>{\\${ALIGN_CMD[align]}\\arraybackslash}` + tok.pre;
  return true;
}

/** Gives a column a fixed width (its text wraps), or back to natural width with `null`. Returns true when the array package is needed. */
export function setColWidth(m: TableModel, col: number, width: string | null): boolean {
  const tok = m.cols[col];
  if (!tok) return false;
  const { align, width: had } = colInfo(tok);
  if (width === null) {
    tok.pre = tok.pre.replace(ALIGN_PREFIX, '');
    tok.core = align;
    return false;
  }
  if (!had && tok.core !== 'X') {
    tok.core = `p{${width}}`;
    // p columns are justified; keep a centred / right alignment explicit.
    if (align !== 'l') {
      tok.pre = `>{\\${ALIGN_CMD[align]}\\arraybackslash}` + tok.pre.replace(ALIGN_PREFIX, '');
      return true;
    }
    return false;
  }
  tok.core = tok.core === 'X' ? 'X' : tok.core.replace(/\{.*\}$/, `{${width}}`);
  return ALIGN_ANY.test(tok.pre);
}

export function usesBooktabs(m: TableModel): boolean {
  return [...m.rows.map((r) => r.pre), m.tail].some((p) => /\\(toprule|midrule|bottomrule|cmidrule)\b/.test(p));
}

/** True when there is a full-width rule above row `index` (`index === rows.length`: below the last row). */
export function hasRule(m: TableModel, index: number): boolean {
  const p = index >= m.rows.length ? m.tail : m.rows[index].pre;
  return new RegExp(FULL_RULE.source).test(p);
}

/** Adds or removes a full-width rule above row `index`. Returns true when the rule added is a booktabs one. */
export function toggleRule(m: TableModel, index: number): boolean {
  const last = index >= m.rows.length;
  const get = () => (last ? m.tail : m.rows[index].pre);
  const set = (v: string) => (last ? (m.tail = v) : (m.rows[index].pre = v));
  if (hasRule(m, index)) {
    set(get().replace(FULL_RULE, '').replace(/\s+/g, ' ').trim());
    return false;
  }
  // Follow the table's style; booktabs for tables without rules yet.
  const plain = !usesBooktabs(m) && [...m.rows.map((r) => r.pre), m.tail].some((p) => /\\hline/.test(p));
  const rule = plain ? '\\hline' : index <= m.rows.findIndex(isDataRow) ? '\\toprule' : last ? '\\bottomrule' : '\\midrule';
  set(get() ? `${get()} ${rule}` : rule);
  return !plain;
}

/** Merges the cells of `row` covering logical columns from..to into one \multicolumn. */
export function mergeCells(m: TableModel, row: number, from: number, to: number): CellPos | null {
  const r = m.rows[row];
  const a = cellAt(r, from);
  const b = cellAt(r, to);
  if (!a || !b || a.index === b.index) return null;
  const merged = r.cells.slice(a.index, b.index + 1);
  const span = merged.reduce((n, c) => n + c.span, 0);
  const startCol = a.startCol;
  const first = m.cols[startCol];
  const lastTok = m.cols[startCol + span];
  const left = startCol === 0 ? (first?.pre.match(/\|+/)?.[0] ?? '') : '';
  const right = (lastTok ? lastTok.pre : m.specTail).match(/\|+/)?.[0] ?? '';
  const align = first ? colInfo(first).align : 'c';
  r.cells.splice(a.index, merged.length, {
    src: merged.map((c) => c.src).filter(Boolean).join(' '),
    start: -1,
    end: -1,
    span,
    mcSpec: `${left}${align}${right}`,
  });
  return { row, col: startCol };
}

/** Splits a \multicolumn cell back into single cells (its content stays in the first). */
export function splitCell(m: TableModel, row: number, col: number): CellPos | null {
  const r = m.rows[row];
  const c = cellAt(r, col);
  if (!c) return null;
  const cell = r.cells[c.index];
  if (cell.span <= 1 && cell.mcSpec === undefined) return null;
  const n = cell.span;
  r.cells.splice(c.index, 1, { ...cell, span: 1, mcSpec: undefined }, ...Array.from({ length: n - 1 }, empty));
  return { row, col: c.startCol };
}

/** Writes a grid of LaTeX cell contents starting at a cell, adding rows and columns as needed. */
export function fillCells(m: TableModel, at: CellPos, grid: string[][]): CellPos {
  const width = Math.max(...grid.map((g) => g.length));
  while (at.col + width > m.cols.length) insertCol(m, m.cols.length - 1, true);
  let r = at.row;
  for (let k = 0; k < grid.length; k++) {
    while (r < m.rows.length && !isDataRow(m.rows[r])) r++;
    if (r >= m.rows.length) insertRow(m, m.rows.length - 1, true);
    const row = m.rows[r];
    while (rowWidth(row) < at.col + width) row.cells.push(empty());
    grid[k].forEach((v, j) => {
      const c = cellAt(row, at.col + j);
      if (c && c.startCol === at.col + j) row.cells[c.index].src = v;
    });
    if (k < grid.length - 1) r++;
  }
  return { row: r, col: at.col + width - 1 };
}

/** Converts rules between booktabs (\toprule…) and plain (\hline) styles; booktabs also drops vertical rules. */
export function setBooktabs(m: TableModel, on: boolean) {
  const dataRows = m.rows.map((r, k) => (isDataRow(r) ? k : -1)).filter((k) => k >= 0);
  const first = dataRows[0];
  if (on) {
    m.rows.forEach((r, k) => {
      r.pre = r.pre
        .replace(/(\\hline\s*)+/g, k === first ? '\\toprule ' : '\\midrule ')
        .replace(/\\cline/g, '\\cmidrule')
        .trim();
    });
    m.tail = m.tail.replace(/(\\hline\s*)+/g, '\\bottomrule ').trim();
    for (const c of m.cols) c.pre = c.pre.replace(/\|/g, '');
    m.specTail = m.specTail.replace(/\|/g, '');
    for (const r of m.rows) for (const c of r.cells) if (c.mcSpec) c.mcSpec = c.mcSpec.replace(/\|/g, '');
  } else {
    const plain = (p: string) =>
      p
        .replace(/\\(toprule|midrule|bottomrule)\b(\s*\[[^\]]*\])?/g, '\\hline')
        .replace(/\\cmidrule\s*(\([^)]*\))?/g, '\\cline')
        .replace(/\\addlinespace\b(\s*\[[^\]]*\])?/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    for (const r of m.rows) r.pre = plain(r.pre);
    m.tail = plain(m.tail);
  }
}

// ---------------------------------------------------------------------------
// Table floats: size settings and longtable conversion

export type SettingKey = 'size' | 'stretch' | 'colsep';

export interface FloatSetting {
  value: string;
  /** Source range of the command. */
  start: number;
  end: number;
}

export const SIZE_SWITCHES = ['tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large'];

/** \small, \arraystretch and \tabcolsep settings at the top level of a float body [s, e). */
export function floatSettings(t: string, s: number, e: number): Partial<Record<SettingKey, FloatSetting>> {
  const out: Partial<Record<SettingKey, FloatSetting>> = {};
  for (let i = s; i < e; i++) {
    const c = t[i];
    if (c === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (c === '{') {
      i = (readGroup(t, i, e)?.end ?? i + 1) - 1;
      continue;
    }
    if (c !== '\\') continue;
    const name = readCommandName(t, i);
    const after = i + 1 + name.length;
    if (name === 'begin') {
      const g = readGroup(t, after, e);
      const f = g && findEnvEnd(t, g.end, t.slice(g.innerStart, g.innerEnd), e);
      if (f) i = f.end - 1;
      continue;
    }
    if (SIZE_SWITCHES.includes(name)) {
      out.size = { value: name, start: i, end: after };
    } else if (name === 'renewcommand' || name === 'setlength') {
      const target = name === 'renewcommand' ? 'arraystretch' : 'tabcolsep';
      const k = skipInlineSpace(t, after, e);
      let j: number;
      let macro: string;
      if (t[k] === '{') {
        const g = readGroup(t, k, e);
        if (!g) continue;
        macro = t.slice(g.innerStart, g.innerEnd).trim();
        j = g.end;
      } else {
        macro = '\\' + readCommandName(t, k);
        j = k + macro.length;
      }
      if (macro !== '\\' + target) continue;
      const v = readGroup(t, skipInlineSpace(t, j, e), e);
      if (!v) continue;
      out[name === 'renewcommand' ? 'stretch' : 'colsep'] = { value: t.slice(v.innerStart, v.innerEnd).trim(), start: i, end: v.end };
      i = v.end - 1;
    } else {
      i = after - 1;
    }
  }
  return out;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

const SETTING_CMD: Record<SettingKey, (v: string) => string> = {
  size: (v) => `\\${v}`,
  stretch: (v) => `\\renewcommand{\\arraystretch}{${v}}`,
  colsep: (v) => `\\setlength{\\tabcolsep}{${v}}`,
};

/** The edit that sets (or with `null` removes) one setting of a table float. */
export function setFloatSetting(t: string, float: Block, key: SettingKey, value: string | null): TextEdit | null {
  const bodyStart = readArgs(t, float.innerStart!, 0, float.innerEnd!, 1).end;
  const cur = floatSettings(t, bodyStart, float.innerEnd!)[key];
  if (cur) {
    if (value !== null) return { start: cur.start, end: cur.end, text: SETTING_CMD[key](value) };
    // Remove the whole line when the command stands alone on it.
    const ls = t.lastIndexOf('\n', cur.start - 1);
    const le = t.indexOf('\n', cur.end);
    if (/^[ \t]*$/.test(t.slice(ls + 1, cur.start)) && le !== -1 && /^[ \t]*$/.test(t.slice(cur.end, le))) return { start: ls, end: le, text: '' };
    return { start: cur.start, end: cur.end, text: '' };
  }
  if (value === null) return null;
  // New settings go after \centering, or at the top of the float.
  const centering = /\\centering\b/.exec(t.slice(bodyStart, float.innerEnd));
  const at = centering ? bodyStart + centering.index + centering[0].length : bodyStart;
  const nextLine = t.slice(at).match(/\n([ \t]*)\S/);
  return { start: at, end: at, text: `\n${nextLine ? nextLine[1] : '  '}${SETTING_CMD[key](value)}` };
}

/** The table float or longtable block a table belongs to (if it is the only table in a float). */
export function tableContainer(blocks: Block[], m: TableModel): Block | undefined {
  const visit = (bs: Block[]): Block | undefined => {
    for (const b of bs) {
      if (b.start > m.start || b.end < m.end) continue;
      if ((b.kind === 'table' || b.kind === 'figure') && b.name !== 'wrapfigure') return b.kind === 'table' ? b : undefined;
      if (b.kind === 'tabular' && b.start === m.start) return b;
      const inner = visit([...(b.children ?? []), ...(b.items ?? []).flatMap((it) => it.children)]);
      if (inner) return inner;
    }
    return undefined;
  };
  return visit(blocks);
}

/** First top-level `\name{…}` (with optional args) in [s, e), skipping nested environments. */
function findTopCommand(t: string, s: number, e: number, name: string): { start: number; end: number } | null {
  for (let i = s; i < e; i++) {
    if (t[i] === '%') {
      i = skipComment(t, i, e);
      continue;
    }
    if (t[i] !== '\\') continue;
    const n = readCommandName(t, i);
    if (n === 'begin') {
      const g = readGroup(t, i + 6, e);
      const f = g && findEnvEnd(t, g.end, t.slice(g.innerStart, g.innerEnd), e);
      if (f) i = f.end - 1;
      continue;
    }
    if (n === name) return { start: i, end: readArgs(t, i + 1 + n.length, 1, e, 1).end };
    i += Math.max(n.length, 1);
  }
  return null;
}

/** Turns a table float into a longtable (pages can break inside it). Null when the float is not a plain tabular. */
export function floatToLongtable(t: string, float: Block, m: TableModel): TextEdit | null {
  if (m.env !== 'tabular') return null;
  const s = float.innerStart!;
  const e = float.innerEnd!;
  const cap = findTopCommand(t, s, e, 'caption');
  const label = findTopCommand(t, s, e, 'label');
  const lt: TableModel = { ...m, env: 'longtable', head: '', rows: [...m.rows] };
  const capRow = [cap, label].filter((x): x is { start: number; end: number } => !!x).map((x) => t.slice(x.start, x.end)).join('');
  if (capRow) lt.rows.unshift({ pre: '', cells: [], end: '\\\\', raw: capRow });
  const lineStart = t.lastIndexOf('\n', float.start - 1) + 1;
  const indent = /^[ \t]*/.exec(t.slice(lineStart, float.start))![0];
  return { start: float.start, end: float.end, text: serializeTable(lt, indent).src };
}

/** Turns a longtable into a table float with a tabular. */
export function longtableToFloat(t: string, m: TableModel): TextEdit {
  let caption = '';
  let label = '';
  const rows = m.rows.filter((r) => {
    if (r.raw === undefined) return true;
    const c = /\\caption\s*(\[[^\]]*\])?\s*\{/.exec(r.raw);
    if (c) {
      const g = readGroup(r.raw, c.index + c[0].length - 1);
      if (g) caption = r.raw.slice(c.index, g.end);
    }
    const l = /\\label\s*\{[^}]*\}/.exec(r.raw);
    if (l) label = l[0];
    return false;
  });
  const strip = (p: string) => p.replace(/\\end(first)?(head|foot)\b|\\endlastfoot\b/g, '').replace(/\s+/g, ' ').trim();
  const tab: TableModel = { ...m, env: 'tabular', head: '', rows: rows.map((r) => ({ ...r, pre: strip(r.pre) })), tail: strip(m.tail) };
  const ind = m.indent;
  const inner = `${ind}  `;
  let src = `\\begin{table}[htbp]\n${inner}\\centering\n${inner}${serializeTable(tab, inner).src}\n`;
  if (caption) src += `${inner}${caption}\n`;
  if (label) src += `${inner}${label}\n`;
  src += `${ind}\\end{table}`;
  return { start: m.start, end: m.end, text: src };
}

/** An edit adding `\usepackage{pkg}` to the preamble, or null when it is already loaded (or there is no preamble). */
export function ensurePackage(t: string, pkg: string): TextEdit | null {
  const begin = t.indexOf('\\begin{document}');
  if (begin === -1) return null;
  const pre = t.slice(0, begin);
  const commented = (i: number) => /(^|[^\\])%/.test(pre.slice(pre.lastIndexOf('\n', i - 1) + 1, i));
  const loads = [...pre.matchAll(/\\(usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)].filter((m) => !commented(m.index!));
  if (loads.some((m) => m[1] !== 'documentclass' && m[2].split(',').some((p) => p.trim() === pkg))) return null;
  const last = loads.pop();
  const lineEnd = last ? pre.indexOf('\n', last.index! + last[0].length) : -1;
  const at = last ? (lineEnd === -1 ? pre.length : lineEnd) : 0;
  return { start: at, end: at, text: `${at ? '\n' : ''}\\usepackage{${pkg}}${at ? '' : '\n'}` };
}

/** Parses tab-separated text (as copied from Excel or Google Sheets) into rows of cells. */
export function parseTsv(s: string): string[][] {
  s = s.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
    i++;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.replace(/\n/g, ' ').trim()));
}
