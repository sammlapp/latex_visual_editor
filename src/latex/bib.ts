// Minimal BibTeX parser: enough to show citation numbers, tooltips and a
// reference list.

export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
}

export function parseBib(src: string): Map<string, BibEntry> {
  const entries = new Map<string, BibEntry>();
  let i = 0;
  while (true) {
    const at = src.indexOf('@', i);
    if (at === -1) break;
    const m = /^@\s*([A-Za-z]+)\s*([{(])/.exec(src.slice(at, at + 64));
    if (!m) {
      i = at + 1;
      continue;
    }
    const type = m[1].toLowerCase();
    const open = at + m[0].length - 1;
    const close = matchDelim(src, open);
    if (close === -1) break;
    i = close + 1;
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    const body = src.slice(open + 1, close);
    const comma = body.indexOf(',');
    if (comma === -1) continue;
    const key = body.slice(0, comma).trim();
    entries.set(key, { key, type, fields: parseFields(body.slice(comma + 1)) });
  }
  return entries;
}

function matchDelim(s: string, i: number): number {
  const open = s[i];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
  }
  return -1;
}

function parseFields(s: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const m = /^[\s,]*([A-Za-z][\w:-]*)\s*=\s*/.exec(s.slice(i));
    if (!m) break;
    i += m[0].length;
    const name = m[1].toLowerCase();
    let value = '';
    // A value is a sequence of parts joined by '#'.
    while (i < s.length) {
      while (/\s/.test(s[i] ?? '')) i++;
      if (s[i] === '{') {
        const close = matchDelim(s, i);
        value += s.slice(i + 1, close === -1 ? s.length : close);
        i = close === -1 ? s.length : close + 1;
      } else if (s[i] === '"') {
        let j = i + 1;
        let depth = 0;
        for (; j < s.length; j++) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') depth--;
          else if (s[j] === '"' && depth === 0) break;
        }
        value += s.slice(i + 1, j);
        i = j + 1;
      } else {
        const m2 = /^[^,#}\s]+/.exec(s.slice(i));
        if (m2) {
          value += m2[0];
          i += m2[0].length;
        }
      }
      while (/\s/.test(s[i] ?? '')) i++;
      if (s[i] === '#') {
        i++;
        continue;
      }
      break;
    }
    fields[name] = value.replace(/\s+/g, ' ').trim();
  }
  return fields;
}

/** "A. Smith and B. Jones" → ["A. Smith", "B. Jones"], normalising "Last, First". */
export function splitAuthors(s: string): string[] {
  return s
    .split(/\s+and\s+/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => {
      const parts = a.split(',').map((p) => p.trim());
      return parts.length >= 2 ? `${parts.slice(1).join(' ')} ${parts[0]}` : a;
    });
}

export function lastName(author: string): string {
  const parts = author.replace(/[{}]/g, '').trim().split(/\s+/);
  return parts[parts.length - 1] ?? author;
}

/** Short author string for \citet: "Smith", "Smith and Jones", "Smith et al." */
export function shortAuthors(e: BibEntry): string {
  const authors = splitAuthors(e.fields.author ?? e.fields.editor ?? '');
  if (authors.length === 0) return e.key;
  if (authors.length === 1) return lastName(authors[0]);
  if (authors.length === 2) return `${lastName(authors[0])} and ${lastName(authors[1])}`;
  return `${lastName(authors[0])} et al.`;
}
