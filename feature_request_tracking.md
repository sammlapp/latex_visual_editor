
# Feature requests

Table editing: tables are edited in a tabular layout, similar to google sheets, and content can be pasted from excel/google sheets. Enable booktabs by default. Basic formatting like inserting horizontal line-rules and merging/unmerging cells is supported. Columns text alignment and resizing with text wrapping. Table-level controls for size/spacing of elelements. Check-box for longtable  to allow split across tables.

Auto-complete of latex commands or symbols. For instance, when typing \bet should se "beta" as an auto-complete option. 

remove block with an 'x' button shown when hovering over upper-right corner of the block

collapse/expand sections from the header line

drag-drop figure from VS Code Explorer

Problems panel navigation: clicking an item in the Problems panel should go to that position in the open visual editor (split out of the LTeX item below; not done yet).


# Bugs



Cmd+F not availabile for search

buggy cut/ pasting behavior: after pasting text into a block, something goes wrong; exiting the block results in the pasted text being lost; the positioning of the cursor becomes wonky and sometimes jumps to a previous position;  paste shows the text, but then spacebar removes the pasted text, even if I change the cursor position to ensure nothing is highlighted.  

Can't copy/cut content from multiple chunks. Enable shift+click across sections to select multiple sections, with copy/cut enabled

Triple-click to select entire paragraph -> cannot backspace; similarly, cmd+A doesn't select entire chunk (no effect)

when a cell is empty, I can't open the raw latex editor. Thus I can't eg paste latex code or start typing latex code to insert a figure

Typing a space before an existing space glues the next typed word onto the following word: with the cursor after "Special" in "Special relativity", typing " th" gives "Special  threlativity" (rendered "Special threlativity") instead of "Special th relativity". The source now has two spaces, which render as one; the cursor position after that rendered space maps to the end of both source spaces, so the following characters land at the start of the next word. Cause: runIndexToSource in src/webview/main.ts snaps to the end of a collapsed whitespace run.

# Completed

Completed: Citation autocomplete: after typing \citep{ \citet{ , the document bibliography entries are provided as an autocomplete-filtered list. Filters match on author names, citation keys, and title words, with full-word matching rather than split-up characters. For instance "lapp opensoundscape" should match on a bib item for Lapp, ....,2023 "Opensoundscape: an open-source...". Display up to 5-10ish matching items in a pop-up window, or perhaps a side panel. Latex Workshop has a feature like this that works well.

Completed: adding a ref using the menu bar works but then context/focus is removed so I can't continue typing without clicking back into the paragraph.

Completed: underline ltex+ extension grammar/spelling errors in the text (they appear in the "Problems panel" in VS Code as "Infos", and Latex Workspace provides the rendering of them on the document; should be able to toggle on/off. Done: wavy underlines by severity, hover for the message and quick fixes (replacements, add to dictionary…), toggle with the latexVisual.diagnostics.enabled setting, sources chosen with latexVisual.diagnostics.sources (LTeX/LTeX+ and cSpell by default). Not done: going to the position from the Problems panel (listed under feature requests).

Completed: \include should render the input content as read-only, with a click to open source document link/button/symbol. Done for \input and \include: content renders inline and read-only, with an "Open ↗" button (or double-click) to open the file; numbering, \ref and citations continue across files; the view updates live while the included file is edited. Not done: \input inside a figure/table environment, and brace-less \input file.

Completed: enable file auto-complete (perhaps using existing vs code Path Autocomplete extension) for \include{...,  \includegraphics and similar. Built in rather than via Path Autocomplete (that extension only works in text editors, not in the visual editor's inputs): \input, \include, \subfile, \includegraphics (respects \graphicspath), \bibliography, \addbibresource, \lstinputlisting and similar suggest matching files from the document's folder, in the "\" box and in the source editors.

