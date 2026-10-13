# LaTeX Visual Editor

A visual editor for `.tex` files in VS Code. Text, equations, tables, figures
and cross-references are rendered inline, and you **type directly into the
rendered page**. The `.tex` file stays the source of truth: every keystroke
becomes a small edit of the LaTeX source, so undo, save, git and other LaTeX
extensions keep working.

## Usage

- Open a `.tex` file and click the preview icon in the editor title bar
  (**Open Visual Editor to the Side**), or run **LaTeX: Open Visual Editor**,
  or right-click the file → *Open With…* → *LaTeX Visual Editor*.
- To always open `.tex` files visually, add to settings:
  `"workbench.editorAssociations": { "*.tex": "latexVisual.editor" }`

### Typing

- Click into any paragraph, heading, caption, table cell, footnote or the title
  and type. Characters with a special meaning in LaTeX (`% & # _ { } ~ ^`) are
  escaped for you.
- **Enter** splits a paragraph (or starts a new paragraph at the end of one);
  at the end of a list item it starts a new `\item`, and on an empty item it
  leaves the list. **Backspace** at the start of a paragraph joins it to the
  previous one. **Shift+Enter** inserts a line break (`\\`).
- **⌘/Ctrl+B** and **⌘/Ctrl+I** wrap the selection in `\textbf{…}` / `\emph{…}`
  (again to remove). **⌘/Ctrl+Z** undoes through VS Code's normal history.
- Type **`$`** (or press ⌘/Ctrl+M) to insert inline math, and **`\`** to insert
  any LaTeX command, both in a small popover with a live preview.
- **→ Ref** and **❝ Cite** insert `\ref` / `\cite` at the caret from a
  searchable list of labels and bibliography entries.

### Math, figures, tables and other blocks

- Click inline math, a display equation, a figure, a table's border or any
  other non-text element to edit its source with a live preview
  (`Esc` or `⌘/Ctrl+Enter` to finish).
- Hover any block and click **`</>`** at its left to edit its full source.
- Click a reference or citation to jump to its target (⌥/Alt+click to edit it).
- The toolbar inserts sections, equations, tables, figures (pick an image file)
  and lists after the current block.

## What is rendered

| Element | Support |
| --- | --- |
| Text | paragraphs, `\textbf` `\emph` `\texttt` etc., size/style switches, accents, quotes, dashes, `~`, footnotes, `\url`/`\href`, user `\newcommand`s |
| Math | inline `$…$` `\(…\)`; display `\[…\]` `$$…$$`, `equation`, `align`, `gather`, `multline`, `eqnarray`, `alignat` (via KaTeX) with LaTeX-style numbering, `\nonumber`, `\tag`, preamble macros and `\DeclareMathOperator` |
| Tables | `tabular`/`tabularx`/`longtable`, column alignment, `\|` borders, `\hline`, booktabs rules, `\cline`/`\cmidrule`, `\multicolumn`, `\multirow` |
| Figures | `\includegraphics` (PNG/JPG/SVG/GIF, and PDF via pdf.js) with `width`/`scale`, `\graphicspath`, subfigures, captions |
| References | `\label`, `\ref`, `\eqref`, `\autoref`, `\cref`; `\cite`/`\citep`/`\citet` etc. from `.bib` files or `thebibliography`; reference list |
| Structure | `\maketitle`, abstract, sections (numbered, `\appendix`), lists, theorem-like environments, proofs, `\tableofcontents`, verbatim |

Anything else is shown in a muted style rather than hidden, so no content is lost.

## Development

```
npm install
npm run build          # bundle to dist/
npm run test:unit      # parser/renderer tests (node)
npm run test:integration  # runs inside VS Code against sample/paper.tex
npm run package        # build a .vsix
```

Press F5 in VS Code to launch an Extension Development Host with the sample paper.
