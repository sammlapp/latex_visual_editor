# Changelog

## Unreleased

- Command and symbol completion after `\` (with math previews and the document's own macros), and environment
  completion after `\begin{` that adds the matching `\end`.

- Delete any block with the × at its upper right on hover (with an Undo notice).
- Cmd/Ctrl+F opens VS Code's find widget in the visual editor.
- `\input` / `\include` files render inline, read-only, with an **Open ↗** button (or double-click) to
  edit them. Section, equation, figure and citation numbering continues across files, `\ref`s into
  included files resolve, and the view updates live as the included file changes.
- Table editing: a contextual table bar to add/delete rows and columns, align and resize columns
  (drag a column edge; text wraps), add or remove lines, merge and split cells, switch booktabs and
  longtable on or off, and set font size, row spacing and column padding. Tab / Shift+Tab / Enter move
  between cells, and cells pasted from Excel or Google Sheets fill the table. Needed packages are added to
  the preamble.
- File path completion in `\input`, `\include`, `\includegraphics`, `\bibliography`,
  `\addbibresource`, `\lstinputlisting` and similar, from the files in the document's folder (respecting
  `\graphicspath`, and dropping `.tex` / `.bib` where LaTeX expects that).
- Problems reported by language servers — LTeX spelling and grammar checks, Code Spell Checker — are
  underlined in the visual editor. Hover an underline for the message and the server's quick fixes
  (replacements, add to dictionary, …). Configure with `latexVisual.diagnostics.*`.

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
