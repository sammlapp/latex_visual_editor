// Low-level scanning helpers shared by the parser and renderer.
// All positions are absolute offsets into the full document text.

export interface Range {
  start: number;
  end: number;
}

export interface Group extends Range {
  /** Offset of the first character inside the delimiters. */
  innerStart: number;
  /** Offset of the closing delimiter. */
  innerEnd: number;
}

export const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'comment']);

/** t[i] === '%' → returns the offset of the terminating newline (or end). */
export function skipComment(t: string, i: number, end = t.length): number {
  const nl = t.indexOf('\n', i);
  return nl === -1 || nl > end ? end : nl;
}

/** Reads a command name starting at a backslash. Returns '' for a lone backslash. */
export function readCommandName(t: string, i: number): string {
  let j = i + 1;
  if (j >= t.length) return '';
  if (!isLetter(t[j])) return t[j];
  while (j < t.length && isLetter(t[j])) j++;
  return t.slice(i + 1, j);
}

export function isLetter(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '@');
}

/** Skips spaces/tabs and at most one newline (never a paragraph break). */
export function skipInlineSpace(t: string, i: number, end = t.length): number {
  let sawNewline = false;
  while (i < end) {
    const c = t[i];
    if (c === ' ' || c === '\t' || c === '\r') i++;
    else if (c === '\n' && !sawNewline) {
      sawNewline = true;
      i++;
    } else break;
  }
  return i;
}

/** Reads a balanced group delimited by open/close starting exactly at i. */
export function readBalanced(t: string, i: number, open: string, close: string, end = t.length): Group | null {
  if (t[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < end; j++) {
    const c = t[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '%') {
      j = skipComment(t, j, end);
      continue;
    }
    if (open === '[' && c === '{') {
      // Brackets may contain braced groups with ']' inside.
      const g = readBalanced(t, j, '{', '}', end);
      if (!g) return null;
      j = g.end - 1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { start: i, end: j + 1, innerStart: i + 1, innerEnd: j };
    }
  }
  return null;
}

export function readGroup(t: string, i: number, end = t.length): Group | null {
  return readBalanced(t, i, '{', '}', end);
}

export function readOptional(t: string, i: number, end = t.length): Group | null {
  return readBalanced(t, i, '[', ']', end);
}

export interface CommandArgs {
  /** Offset just past the last consumed argument. */
  end: number;
  star: boolean;
  optional: Group[];
  required: Group[];
  /** Arguments in source order. */
  all: { kind: 'opt' | 'req'; group: Group }[];
}

/**
 * Consumes arguments following a command whose name ends at `i`.
 * Reads an optional star, then bracket/brace groups until `maxRequired`
 * brace groups have been read or no further group follows.
 */
export function readArgs(t: string, i: number, maxRequired: number, end = t.length, maxOptional = 3): CommandArgs {
  const res: CommandArgs = { end: i, star: false, optional: [], required: [], all: [] };
  let j = i;
  if (t[j] === '*') {
    res.star = true;
    j++;
    res.end = j;
  }
  while (j < end) {
    const k = skipInlineSpace(t, j, end);
    const optAllowed = maxRequired === 0 ? res.required.length === 0 : res.required.length < maxRequired;
    if (t[k] === '[' && res.optional.length < maxOptional && optAllowed) {
      const g = readOptional(t, k, end);
      if (!g) break;
      res.optional.push(g);
      res.all.push({ kind: 'opt', group: g });
      j = res.end = g.end;
    } else if (t[k] === '{' && res.required.length < maxRequired) {
      const g = readGroup(t, k, end);
      if (!g) break;
      res.required.push(g);
      res.all.push({ kind: 'req', group: g });
      j = res.end = g.end;
    } else break;
  }
  return res;
}

/**
 * Given `i` positioned just after `\begin{name}`, finds the matching
 * `\end{name}`. Returns the offset of the backslash of `\end` and the
 * offset just past it.
 */
export function findEnvEnd(t: string, i: number, name: string, end = t.length): { innerEnd: number; end: number } | null {
  const endTag = `\\end{${name}}`;
  if (VERBATIM_ENVS.has(name)) {
    const k = t.indexOf(endTag, i);
    if (k === -1 || k + endTag.length > end) return null;
    return { innerEnd: k, end: k + endTag.length };
  }
  const beginTag = `\\begin{${name}}`;
  let depth = 1;
  for (let j = i; j < end; j++) {
    const c = t[j];
    if (c === '%') {
      j = skipComment(t, j, end);
      continue;
    }
    if (c !== '\\') continue;
    if (t.startsWith(beginTag, j)) {
      depth++;
      j += beginTag.length - 1;
    } else if (t.startsWith(endTag, j)) {
      depth--;
      if (depth === 0) return { innerEnd: j, end: j + endTag.length };
      j += endTag.length - 1;
    } else if (t.startsWith('\\begin{', j)) {
      // Skip over verbatim-like environments, whose bodies are opaque.
      const g = readGroup(t, j + 6, end);
      if (g) {
        const inner = t.slice(g.innerStart, g.innerEnd);
        if (VERBATIM_ENVS.has(inner)) {
          const e = findEnvEnd(t, g.end, inner, end);
          if (e) j = e.end - 1;
        }
      }
    } else {
      j++; // skip escaped char
    }
  }
  return null;
}

/** Finds the first occurrence of `needle` outside comments. */
export function findOutsideComments(t: string, needle: string, from = 0, end = t.length): number {
  for (let j = from; j < end; j++) {
    const c = t[j];
    if (c === '%') {
      j = skipComment(t, j, end);
      continue;
    }
    if (c === '\\') {
      if (t.startsWith(needle, j)) return j;
      j++;
      continue;
    }
    if (t.startsWith(needle, j)) return j;
  }
  return -1;
}

/** Trims whitespace from both ends of a range. */
export function trimRange(t: string, start: number, end: number): Range {
  while (start < end && /\s/.test(t[start])) start++;
  while (end > start && /\s/.test(t[end - 1])) end--;
  return { start, end };
}

/** Removes `%` comments (respecting `\%`), as TeX would before tokenizing. */
export function stripComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      out += c + s[i + 1];
      i++;
    } else if (c === '%') {
      const nl = s.indexOf('\n', i);
      if (nl === -1) break;
      // TeX also eats the newline and leading spaces of the next line.
      i = nl;
      while (i + 1 < s.length && (s[i + 1] === ' ' || s[i + 1] === '\t')) i++;
    } else out += c;
  }
  return out;
}

/**
 * Splits `s` at top-level occurrences of a separator (`\\` or `&`), ignoring
 * separators nested in braces or environments. Returns slices with offsets
 * relative to `s`.
 */
export function splitTopLevel(s: string, sep: '\\\\' | '&'): { text: string; start: number; end: number }[] {
  const parts: { text: string; start: number; end: number }[] = [];
  let depth = 0;
  let envDepth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%') {
      i = skipComment(s, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '\\') {
      if (s.startsWith('\\begin{', i)) envDepth++;
      else if (s.startsWith('\\end{', i)) envDepth--;
      if (sep === '\\\\' && s[i + 1] === '\\' && depth === 0 && envDepth === 0) {
        parts.push({ text: s.slice(last, i), start: last, end: i });
        i += 1;
        // Swallow an optional spacing argument like \\[2pt].
        let k = i + 1;
        while (s[k] === ' ') k++;
        if (s[k] === '[') {
          const g = readOptional(s, k);
          if (g) i = g.end - 1;
        }
        last = i + 1;
        continue;
      }
      i++;
      continue;
    } else if (sep === '&' && c === '&' && depth === 0 && envDepth === 0) {
      parts.push({ text: s.slice(last, i), start: last, end: i });
      last = i + 1;
    }
  }
  parts.push({ text: s.slice(last), start: last, end: s.length });
  return parts;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
