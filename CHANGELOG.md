# Changelog

## 0.1.0 — preview

First public preview.

- Visual editor for `.tex` files: text, equations (KaTeX), tables, figures (PNG/JPG/SVG/PDF), lists,
  theorems, title block, footnotes and bibliography render inline, with LaTeX-style numbering.
- Type directly into paragraphs, headings, captions, table cells, footnotes and the title; every
  keystroke is a minimal edit of the LaTeX source, so undo, save and git work as usual.
- Enter / Backspace split and join paragraphs and list items; ⌘/Ctrl+B and ⌘/Ctrl+I toggle bold and
  italic.
- `$` and `\` open an inline LaTeX popover with live preview.
- Citation completion for `\cite`-style commands (word matching on keys, authors and titles) and label
  completion for `\ref`-style commands.
- Source editor with live preview for math, figures, tables and any block (`</>` on hover).
- Cross-references and citations link to their targets; cursor position syncs from the text editor.
