# LaTeX Visual Editor

A visual editor for `.tex` files in VS Code. Text, equations, tables, figures
and cross-references are rendered inline; click any block to edit its LaTeX
source with a live preview. The `.tex` file stays the source of truth: edits
are written straight into the document, so undo, save, git and other LaTeX
extensions keep working.

## Usage

- Open a `.tex` file and click the preview icon in the editor title bar
  (**Open Visual Editor to the Side**), or run **LaTeX: Open Visual Editor**,
  or right-click the file → *Open With…* → *LaTeX Visual Editor*.
- To always open `.tex` files visually, add to settings:
  `"workbench.editorAssociations": { "*.tex": "latexVisual.editor" }`
- **Click a block** to edit its source. Changes apply live. `Esc` or `⌘/Ctrl+Enter`
  finishes; `⌘B` / `⌘I` wrap the selection in `\textbf` / `\emph`; `⌘M` wraps it in `$…$`.
- **Toolbar**: insert paragraph, section, equation, table, figure (pick an image file),
  or list after the selected block; insert `\ref` / `\cite` at the cursor from a
  searchable list; toggle paper style; open the source side by side.
- Click a reference or citation to jump to its target. Moving the cursor in the
  text editor highlights the matching block.

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
