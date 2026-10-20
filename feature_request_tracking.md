
# Feature requests


collapse/expand sections from the header line

drag-drop figure from VS Code Explorer

Problems panel navigation: clicking an item in the Problems panel should go to that position in the open visual editor (split out of the LTeX item below; not done yet).
# Bugs




  

Can't copy/cut content from multiple chunks. Enable shift+click across sections to select multiple sections, with copy/cut enabled

cmd+A should select entire chunk (currently no effect)


Typing a space before an existing space glues the next typed word onto the following word: with the cursor after "Special" in "Special relativity", typing " th" gives "Special  threlativity" (rendered "Special threlativity") instead of "Special th relativity". The source now has two spaces, which render as one; the cursor position after that rendered space maps to the end of both source spaces, so the following characters land at the start of the next word. Cause: runIndexToSource in src/webview/main.ts snaps to the end of a collapsed whitespace run.

# Completed

Completed: clicking on a rendered citation should open the cite/citep/citet{} editor rather than scroll to the citation. Hovering over a citation renders a little box with the title/authors/year/journal. Done: click opens the \cite{…} source with the caret after the keys and the bibliography list open; hovering shows a card with title, authors, venue (volume, pages), year, entry type, key and DOI. Citations in included files and the reference list still jump on click.

Completed (bug): copy-paste lost refs, citations and raw LaTeX, and a paste could land unnoticed elsewhere in the document. Copy/cut now put the selection's LaTeX source on the clipboard (citations, refs and math whole; partial \textbf{…}/link/list selections completed into valid LaTeX); pasting LaTeX code keeps it as LaTeX; pasted text flashes and scrolls into view. The misplaced paste itself was never reproduced; if it recurs, note where the yellow flash appears.

Completed (bug): when a block is empty, I can't open the raw latex editor, so I can't paste latex code or start typing latex code to insert a figure. Fixed: in an empty paragraph (new paragraph or empty list item), typing \ or clicking </> opens the full LaTeX editor for a new block (with command/environment completion), and pasting text containing LaTeX commands inserts it as LaTeX. A lone \ is discarded on Esc.

Completed: Auto-complete of latex commands or symbols. For instance, when typing \bet should se "beta" as an auto-complete option. Done: suggestions after \ in the \ box and in source editors, matched by name and description, with KaTeX previews for math symbols and the document's own macros; snippets put the caret in the braces; math symbols in running text are wrapped in $…$; environments after \begin{ get their \end. Not in the plain text paragraphs themselves (typing \ there opens the \ box, which has the completion).

Completed: remove block with an 'x' button shown when hovering over upper-right corner of the block. Done: × at the hovered block's upper right (next to the </> on the left); deletes the block and its empty line, or the whole \item when the block is the item's only content; Undo notice (or Cmd+Z). The preamble can't be deleted this way.

Completed: Cmd+F not availabile for search. Uses VS Code's own find widget (Cmd/Ctrl+F, Enter / Shift+Enter for next/previous) over the rendered text. Not done: find-and-replace.

Completed: VS Code pastes/cuts in the visual editor with execCommand, which fired no beforeinput, so pasted text only changed the page and never the .tex source (and was lost on the next re-render); paste and cut events are now handled. Original report: buggy cut/ pasting behavior: after pasting text into a block, something goes wrong; exiting the block results in the pasted text being lost; the positioning of the cursor becomes wonky and sometimes jumps to a previous position;  paste shows the text, but then spacebar removes the pasted text, even if I change the cursor position to ensure nothing is highlighted.

Completed: Table editing: tables are edited in a tabular layout, similar to google sheets, and content can be pasted from excel/google sheets. Enable booktabs by default. Basic formatting like inserting horizontal line-rules and merging/unmerging cells is supported. Columns text alignment and resizing with text wrapping. Table-level controls for size/spacing of elelements. Check-box for longtable  to allow split across tables. Done: table bar while the cursor is in a cell (rows/columns, alignment, Wrap + drag column edges, lines above/below, merge/split, booktabs and long checkboxes, font size / row spacing / column padding); Tab, Shift+Tab, Enter navigation; paste from Excel/Sheets; new tables use booktabs; packages added automatically. Not done: vertical merges (\multirow); size/spacing controls for longtables.

Completed: Citation autocomplete: after typing \citep{ \citet{ , the document bibliography entries are provided as an autocomplete-filtered list. Filters match on author names, citation keys, and title words, with full-word matching rather than split-up characters. For instance "lapp opensoundscape" should match on a bib item for Lapp, ....,2023 "Opensoundscape: an open-source...". Display up to 5-10ish matching items in a pop-up window, or perhaps a side panel. Latex Workshop has a feature like this that works well.

Completed: adding a ref using the menu bar works but then context/focus is removed so I can't continue typing without clicking back into the paragraph.

Completed: underline ltex+ extension grammar/spelling errors in the text (they appear in the "Problems panel" in VS Code as "Infos", and Latex Workspace provides the rendering of them on the document; should be able to toggle on/off. Done: wavy underlines by severity, hover for the message and quick fixes (replacements, add to dictionary…), toggle with the latexVisual.diagnostics.enabled setting, sources chosen with latexVisual.diagnostics.sources (LTeX/LTeX+ and cSpell by default). Not done: going to the position from the Problems panel (listed under feature requests).

Completed: \include should render the input content as read-only, with a click to open source document link/button/symbol. Done for \input and \include: content renders inline and read-only, with an "Open ↗" button (or double-click) to open the file; numbering, \ref and citations continue across files; the view updates live while the included file is edited. Not done: \input inside a figure/table environment, and brace-less \input file.

Completed: enable file auto-complete (perhaps using existing vs code Path Autocomplete extension) for \include{...,  \includegraphics and similar. Built in rather than via Path Autocomplete (that extension only works in text editors, not in the visual editor's inputs): \input, \include, \subfile, \includegraphics (respects \graphicspath), \bibliography, \addbibresource, \lstinputlisting and similar suggest matching files from the document's folder, in the "\" box and in the source editors.

