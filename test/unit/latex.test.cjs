// Unit tests for the LaTeX core (run against the bundled node build).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../../dist/latex.cjs');

const sampleDir = path.join(__dirname, '..', 'fixtures');
const paper = fs.readFileSync(path.join(sampleDir, 'paper.tex'), 'utf8');
const bib = fs.readFileSync(path.join(sampleDir, 'refs.bib'), 'utf8');
const host = {
  bib,
  images: {
    signal: { kind: 'pdf', uri: 'file:///signal.pdf' },
    'spectrum.png': { kind: 'image', uri: 'file:///spectrum.png' },
    'missing-figure': { kind: 'missing' },
  },
};
const ctx = L.buildContext(paper, host);
const html = L.renderDocument(ctx);
const text = L.stripTags(html);

const kinds = (blocks) => blocks.map((b) => b.kind);

test('splits the body into the expected blocks', () => {
  const k = kinds(ctx.doc.blocks);
  assert.ok(ctx.doc.preamble, 'preamble detected');
  assert.equal(k[0], 'command'); // \maketitle
  assert.ok(k.includes('heading'));
  assert.equal(k.filter((x) => x === 'math').length, 2);
  assert.equal(k.filter((x) => x === 'figure').length, 2);
  assert.equal(k.filter((x) => x === 'table').length, 1);
  assert.equal(k.filter((x) => x === 'list').length, 2);
  assert.ok(k.includes('comment'));
});

test('every block range maps back to its exact source', () => {
  for (const b of ctx.doc.blocks) {
    const src = paper.slice(b.start, b.end);
    assert.equal(src.replace(/[ \t]+$/, ''), src.trim(), `block ${b.kind} has untrimmed range`);
    if (b.kind === 'math' && b.name === 'equation') assert.ok(src.startsWith('\\begin{equation}') && src.endsWith('\\end{equation}'));
    if (b.kind === 'heading') assert.match(src, /^\\(sub)*section/);
  }
});

test('numbers sections, equations, floats and theorems like LaTeX', () => {
  const lbl = (k) => ctx.labels.get(k)?.num;
  assert.equal(lbl('sec:intro'), '1');
  assert.equal(lbl('sec:method'), '2');
  assert.equal(lbl('eq:loss'), '1');
  assert.equal(lbl('eq:grad'), '2');
  assert.equal(lbl('thm:conv'), '1');
  assert.equal(lbl('tab:results'), '1');
  assert.equal(lbl('fig:signal'), '1');
  assert.equal(lbl('fig:pair'), '2');
  assert.equal(lbl('fig:pair-a'), '2a');
  assert.deepEqual([...ctx.headingNums.values()], ['1', '2', '2.1', '2.2']);
});

test('renders references, citations and undefined refs', () => {
  assert.match(text, /Section 2 for details/);
  assert.match(text, /Equation \(1\) and \(2\)/);
  assert.match(text, /Theorem 1 is referenced/);
  assert.match(text, /relativity \[1\]/);
  assert.match(text, /Knuth \[2\] gave us/);
  assert.match(text, /models \[3, 2\]/);
  assert.match(html, /class="ref undef"/);
  assert.match(text, /References\s*\[1\] Albert Einstein\. Zur Elektrodynamik bewegter Körper/);
});

test('renders math with KaTeX, macros and equation tags', () => {
  assert.equal((html.match(/katex-error/g) || []).length, 0, 'no KaTeX errors');
  assert.match(html, /class="katex-display"/);
  assert.match(text, /\(1\)/);
  assert.ok(!/\\argmin|\\norm|\\R\b/.test(text), 'user macros expanded');
});

test('renders the table with booktabs rules and multicolumn', () => {
  assert.match(html, /<table class="tabular">/);
  assert.match(html, /colspan="3"/);
  assert.match(html, /border-top:2px/);
  assert.match(html, /border-bottom:2px/);
  assert.match(text, /Table 1: Accuracy by method\./);
  assert.match(html, /<strong[^>]*><span[^>]*>84\.5<\/span><\/strong>/);
});

test('renders figures, subfigures and missing images', () => {
  assert.match(html, /data-pdf="file:\/\/\/signal.pdf"/);
  assert.match(html, /src="file:\/\/\/spectrum.png"/);
  assert.match(html, /style="width:60%"/);
  assert.match(text, /\(a\) PNG version/);
  assert.match(text, /\(b\) A missing file/);
  assert.match(text, /Image not found: missing-figure/);
  assert.match(text, /Figure 2: Two views; panel 2a is a PNG\./);
});

test('renders title block, abstract, theorem, proof, lists, footnotes', () => {
  assert.match(text, /A Visual Tour of LaTeX Rendering/);
  assert.match(text, /Ada Lovelace1/);
  assert.match(text, /Abstract\s*We demonstrate/);
  assert.match(text, /Theorem 1 \(Convergence\)\.\s*If/);
  assert.ok(!text.includes('[htbp]'), 'float placement hidden');
  assert.match(text, /Proof\.\s*Standard/);
  assert.match(html, /<ul class="itemize">/);
  assert.match(html, /<ol class="enumerate" type="1">/);
  assert.match(text, /Footnotes are shown below their paragraph/);
  assert.match(text, /— all rendered inline/);
  assert.match(text, /“quoted”/);
});

test('live preview of a single region resolves numbering', () => {
  const b = ctx.doc.blocks.find((x) => x.kind === 'math' && x.name === 'align');
  const out = L.stripTags(L.renderRange(ctx, b.start, b.end));
  assert.match(out, /\(2\)/);
});

test('handles fragments, nesting and odd inputs without throwing', () => {
  const cases = [
    '', 'plain text only', '$unterminated math', '\\begin{itemize}\\item a', '\\section{', '{{{', '}}}',
    '\\begin{tabular}{|l|r|}\\hline a & b \\\\ \\hline\\end{tabular}', '\\[ x \\]', '$$ y $$ text',
    '\\begin{enumerate}\\item \\begin{itemize}\\item nested\\end{itemize}\\end{enumerate}',
    '\\verb|\\begin{x}| \\% \\$ 100\\%', 'text\n\\begin{equation}a\\end{equation}\ncontinued',
    '\\begin{tabular}{cc}\\multirow{2}{*}{X} & a \\\\ & b \\\\\\end{tabular}',
  ];
  for (const c of cases) {
    const cx = L.buildContext(c, { images: {}, bib: '' });
    assert.doesNotThrow(() => L.renderDocument(cx), c);
  }
  const cx = L.buildContext('text\n\\begin{equation}a\\end{equation}\ncontinued', { images: {}, bib: '' });
  assert.equal(cx.doc.blocks[2].continuation, true);
  const mr = L.renderDocument(L.buildContext('\\begin{tabular}{cc}\\multirow{2}{*}{X} & a \\\\ & b \\\\\\end{tabular}', { images: {}, bib: '' }));
  assert.match(mr, /rowspan="2"/);
  assert.equal((mr.match(/<td/g) || []).length, 3);
});

test('every rendered text run maps back to its source characters', () => {
  const docs = [paper, String.raw`A -- B --- C \`\`q'' \% \& \$ x~y \ldots{} \'e \"o \c{c} \noindent z`, 'line\\\\\nnext \\textbf{b\\emph{i}} {g} % c\n  after'];
  const unesc = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const d of docs) {
    const c = L.buildContext(d, host);
    const out = L.renderDocument(c);
    let n = 0;
    for (const m of out.matchAll(/<span class="r" data-s="(\d+)" data-e="(\d+)">([^<]*)<\/span>/g)) {
      const toks = L.scanRun(d, Number(m[1]), Number(m[2]), c);
      assert.equal(toks.map((t) => t.out).join(''), unesc(m[3]), `run ${m[1]}-${m[2]}`);
      assert.equal(toks[0].s, Number(m[1]));
      assert.equal(toks[toks.length - 1].e, Number(m[2]));
      n++;
    }
    assert.ok(n > 0);
  }
});

test('editable regions cover paragraphs, headings, captions, cells and the title', () => {
  const regions = [...html.matchAll(/data-region="(\w+)" data-s="(\d+)" data-e="(\d+)"/g)].map((m) => m[1]);
  for (const k of ['p', 'h', 'cap', 'cell', 'title', 'fn']) assert.ok(regions.includes(k), `region ${k}`);
  // Display math, figures and tables are not directly editable as text.
  assert.match(html, /class="blk blk-math"[^>]*contenteditable="false"/);
  assert.match(html, /class="blk blk-figure"[^>]*contenteditable="false"/);
  assert.match(html, /class="isl math" contenteditable="false"/);
});

test('citation completion matches whole words across key, authors and title', () => {
  const items = L.citationItems(ctx);
  const keys = (q) => L.filterCompletions(items, q).map((i) => i.key);
  assert.equal(keys('lapp opensoundscape')[0], 'lapp2023opensoundscape');
  assert.equal(keys('opensoundscape lapp')[0], 'lapp2023opensoundscape');
  assert.equal(keys('kitzes')[0], 'kitzes2018'); // first author ranks above a co-author
  assert.ok(keys('kitzes').includes('lapp2023opensoundscape'));
  assert.deepEqual(keys('einstein elektrodynamik'), ['einstein1905']);
  assert.deepEqual(keys('erdos'), ['erdos1947'], 'accents ignored');
  assert.deepEqual(keys('knuth1984'), ['knuth1984'], 'exact key');
  assert.deepEqual(keys('attention need'), ['vaswani2017']);
  assert.deepEqual(keys('2017'), ['vaswani2017'], 'year');
  // Whole-word matching: scattered letters do not match.
  assert.deepEqual(keys('lpp'), []);
  assert.deepEqual(keys('lapp nonsense'), []);
  // Empty query lists cited entries first, in citation order.
  assert.deepEqual(L.filterCompletions(items, '').slice(0, 3).map((i) => i.key), ['einstein1905', 'knuth1984', 'vaswani2017']);
  assert.ok(L.filterCompletions(items, '', 5).length === 5);
});

test('completion context detects the key being typed', () => {
  const at = (s) => L.completionAt(s, s.indexOf('|') === -1 ? s.length : s.indexOf('|'));
  let c = L.completionAt('see \\citep{lapp op', 18);
  assert.equal(c.kind, 'cite');
  assert.equal(c.command, 'citep');
  assert.equal(c.query, 'lapp op');
  c = L.completionAt('\\citet[p.~3]{knuth1984, vas', 27);
  assert.equal(c.query, 'vas');
  assert.equal(c.from, 24);
  c = L.completionAt('\\cite{kn}', 8);
  assert.equal(c.to, 8);
  assert.equal(L.completionAt('\\eqref{eq:', 10).kind, 'ref');
  assert.equal(L.completionAt('\\cite{done} more', 16), null);
  assert.equal(L.completionAt('plain text {', 12), null);
  assert.ok(at);
  const labels = L.filterCompletions(L.labelItems(ctx), 'fig pair').map((i) => i.key);
  assert.deepEqual(labels.slice(0, 2).sort(), ['fig:pair', 'fig:pair-a']);
});

test('\\input and \\include render the other file read-only, continuing numbering', () => {
  const main = [
    '\\documentclass{article}',
    '\\newcommand{\\R}{\\mathbb{R}}',
    '\\begin{document}',
    '\\section{One}',
    'See Section~\\ref{sec:two}, Eq.~\\eqref{eq:two} and \\cite{knuth1984}.',
    '',
    '\\input{chapters/two}',
    '',
    '\\section{Three}',
    'Back in the main file \\cite{einstein1905}.',
    '\\begin{equation} y = 1 \\end{equation}',
    '\\include{missing}',
    '\\end{document}',
  ].join('\n');
  const two = [
    '\\section{Two}\\label{sec:two}',
    'Included text with $x \\in \\R$ and \\cite{vaswani2017, knuth1984}.\\footnote{From the chapter.}',
    '\\begin{equation} x = 2 \\label{eq:two} \\end{equation}',
    '\\input{chapters/two}',
  ].join('\n');
  const h = { bib, images: {}, includes: { 'chapters/two': two, missing: null } };
  const c = L.buildContext(main, h);
  const out = L.renderDocument(c);
  const inputAt = main.indexOf('\\input');

  // Numbering and labels continue through the included file.
  assert.deepEqual(c.headings.map((x) => x.num), ['1', '2', '3']);
  assert.deepEqual(c.labels.get('sec:two'), { num: '2', kind: 'section', target: inputAt });
  assert.equal(c.labels.get('eq:two').num, '1');
  assert.match(c.mathSrc.get(main.indexOf('\\begin{equation}')), /\\tag\{2\}/, 'the main file\'s equation after the include is (2)');
  // Citations are numbered in reading order across files.
  assert.deepEqual(c.citeOrder, ['knuth1984', 'vaswani2017', 'einstein1905']);

  const inc = /<div class="include-body"[^>]*>([\s\S]*?)<\/div><\/div><div class="blk blk-heading"/.exec(out);
  assert.ok(inc, 'include body rendered');
  const body = inc[1];
  assert.match(L.stripTags(body), /Included text with/);
  assert.match(body, /class="katex"/, 'preamble macros apply in the included file');
  assert.match(L.stripTags(body), /\[2, 1\]/);
  assert.match(L.stripTags(body), /From the chapter/);
  // Nothing inside is editable or carries offsets into the main document...
  assert.doesNotMatch(body, /data-(start|end|s|e)="|contenteditable="true"|class="(blk|ed)[ "]/);
  // ...and the self-include stops instead of recursing.
  assert.equal((body.match(/class="include-body"/g) ?? []).length, 0);
  assert.match(out, /class="blk blk-command include"[^>]*data-start="\d+"/);
  assert.match(out, /data-file="chapters\/two"/);
  assert.match(out, /\\include\{missing\} · file not found/);

  // Without the host's file contents it is a link, as before.
  assert.match(L.renderDocument(L.buildContext(main, { bib, images: {} })), /class="blk blk-command input"/);
});

test('file completion for \\input, \\includegraphics and \\bibliography', () => {
  const at = (s) => L.completionAt(s.replace('|', ''), s.indexOf('|') === -1 ? s.length : s.indexOf('|'));
  let c = at('\\includegraphics[width=0.5\\linewidth]{figures/sp');
  assert.deepEqual([c.kind, c.command, c.query], ['file', 'includegraphics', 'figures/sp']);
  c = at('\\input{chap|ters/one} more');
  assert.deepEqual([c.kind, c.query, c.to], ['file', 'chap', '\\input{chapters/one'.length], 'replaces the whole path');
  c = at('\\bibliography{refs,ot');
  assert.deepEqual([c.query, c.from], ['ot', '\\bibliography{refs,'.length], 'bibliography lists split at commas');
  assert.equal(at('\\includegraphics{my figure').query, 'my figure', 'paths may contain spaces');
  assert.equal(at('\\inputminted{python}{sc').query, 'sc');
  assert.equal(at('\\includegraphics{done.png} and'), null);

  const files = ['paper.tex', 'chapters/one.tex', 'chapters/two.tex', 'figures/spectrum.png', 'figures/signal.pdf', 'refs.bib', 'notes.txt'];
  const keys = (cmd, q, gp) => L.filterCompletions(L.fileItems(files, cmd, gp), q, 10).map((i) => i.key);
  assert.deepEqual(keys('input', ''), ['paper', 'chapters/one', 'chapters/two'], '.tex files without extension, shallow first');
  assert.deepEqual(keys('input', 'two'), ['chapters/two']);
  assert.deepEqual(keys('includegraphics', 'spec'), ['figures/spectrum.png']);
  assert.deepEqual(keys('includegraphics', 'sig', ['figures/']), ['signal.pdf', 'figures/signal.pdf'], 'relative to \\graphicspath first');
  assert.deepEqual(keys('bibliography', ''), ['refs']);
  assert.deepEqual(keys('addbibresource', ''), ['refs.bib']);
  assert.ok(keys('lstinputlisting', 'notes').includes('notes.txt'));
});

test('table model: parse, edit and write back tabular environments', () => {
  const src = [
    '\\documentclass{article}',
    '\\usepackage{amsmath}',
    '\\begin{document}',
    '\\begin{table}[htbp]',
    '  \\centering',
    '  \\begin{tabular}{l|cc}',
    '    \\toprule',
    '    Method & A & B \\\\',
    '    \\midrule',
    '    \\multicolumn{2}{c}{Both} & 3 \\\\',
    '    Ours % best',
    '    & 1 & 2 \\\\[2pt]',
    '    \\bottomrule',
    '  \\end{tabular}',
    '  \\caption{Results.}\\label{tab:r}',
    '\\end{table}',
    '\\end{document}',
  ].join('\n');
  const at = src.indexOf('Both');
  const m = L.findTableAt(src, at);
  assert.equal(m.env, 'tabular');
  assert.deepEqual(m.cols.map((c) => c.pre + c.core), ['l', '|c', 'c']);
  assert.deepEqual(m.rows.map((r) => r.cells.map((c) => c.src)), [['Method', 'A', 'B'], ['Both', '3'], ['Ours % best', '1', '2']]);
  assert.deepEqual(m.rows.map((r) => r.pre), ['\\toprule', '\\midrule', '']);
  assert.equal(m.rows[2].end, '\\\\[2pt]');
  assert.equal(m.tail, '\\bottomrule');
  assert.deepEqual(L.cellPosAt(m, at), { row: 1, col: 0, index: 0 });
  assert.equal(src.slice(m.rows[0].cells[1].start, m.rows[0].cells[1].end), 'A');

  // Writing back keeps every cell, and a comment never swallows the next cell or the row end.
  const out = L.serializeTable(m);
  const again = L.parseTable(out.src, 0);
  assert.deepEqual(again.rows.map((r) => r.cells.map((c) => c.src)), m.rows.map((r) => r.cells.map((c) => c.src)));
  assert.match(out.src, /Ours % best\n\s+& 1 & 2 \\\\\[2pt\]/);
  assert.equal(out.src.slice(out.cells[1][1], out.cells[1][1] + 1), '3', 'cell offsets point at the contents');
  assert.ok(out.src.startsWith('\\begin{tabular}{l|cc}\n    \\toprule\n    Method & A & B \\\\\n'));

  const fresh = () => L.findTableAt(src, at);
  const cells = (x) => x.rows.map((r) => r.cells.map((c) => (c.span > 1 ? `${c.src}*${c.span}` : c.src)));
  let x = fresh();
  assert.deepEqual(L.insertRow(x, 0, true), { row: 1, col: 0 });
  assert.deepEqual(cells(x)[1], ['', '', '']);
  assert.deepEqual(x.rows.map((r) => r.pre), ['\\toprule', '\\midrule', '', ''], 'new body row goes below the header rule');
  x = fresh();
  L.insertCol(x, 0, true);
  assert.deepEqual(cells(x), [['Method', '', 'A', 'B'], ['Both*3', '3'], ['Ours % best', '', '1', '2']], 'spans widen across an inserted column');
  assert.deepEqual(x.cols.map((c) => c.pre + c.core), ['l', 'l', '|c', 'c']);
  x = fresh();
  L.insertCol(x, 0, false);
  assert.deepEqual(cells(x)[0], ['', 'Method', 'A', 'B']);
  x = fresh();
  L.deleteCol(x, 1);
  assert.deepEqual(cells(x), [['Method', 'B'], ['Both', '3'], ['Ours % best', '2']]);
  assert.equal(x.rows[1].cells[0].mcSpec, undefined, 'a span of one is a plain cell again');
  x = fresh();
  L.deleteRow(x, 0);
  assert.deepEqual(x.rows.map((r) => r.pre), ['\\midrule', '']);
  x = fresh();
  assert.ok(L.mergeCells(x, 0, 1, 2));
  assert.deepEqual(cells(x)[0], ['Method', 'A B*2']);
  assert.equal(x.rows[0].cells[1].mcSpec, 'c', 'the | belongs to the column on its left, which keeps drawing it');
  x = fresh();
  L.splitCell(x, 1, 1);
  assert.deepEqual(cells(x)[1], ['Both', '', '3']);
  x = fresh();
  assert.equal(L.hasRule(x, 2), false);
  assert.equal(L.toggleRule(x, 2), true);
  assert.equal(x.rows[2].pre, '\\midrule');
  L.toggleRule(x, 3);
  assert.equal(x.tail, '', 'bottom rule removed');
  x = fresh();
  L.setColAlign(x, 0, 'r');
  assert.equal(x.cols[0].core, 'r');
  assert.equal(L.setColWidth(x, 0, '0.3\\linewidth'), true, 'a right-aligned wrapped column needs the array package');
  assert.equal(x.cols[0].pre + x.cols[0].core, '>{\\raggedleft\\arraybackslash}p{0.3\\linewidth}');
  assert.deepEqual(L.colInfo(x.cols[0]), { align: 'r', width: '0.3\\linewidth' });
  L.setColAlign(x, 0, 'c');
  assert.equal(x.cols[0].pre + x.cols[0].core, '>{\\centering\\arraybackslash}p{0.3\\linewidth}');
  L.setColWidth(x, 0, null);
  assert.equal(x.cols[0].pre + x.cols[0].core, 'c');
  x = fresh();
  L.setBooktabs(x, false);
  assert.deepEqual([...x.rows.map((r) => r.pre), x.tail], ['\\hline', '\\hline', '', '\\hline']);
  L.setBooktabs(x, true);
  assert.deepEqual([...x.rows.map((r) => r.pre), x.tail], ['\\toprule', '\\midrule', '', '\\bottomrule']);
  assert.equal(x.cols[1].pre, '', 'booktabs drops vertical rules');
  x = fresh();
  const end = L.fillCells(x, { row: 2, col: 1 }, [['7', '8', '9'], ['x', 'y', 'z']]);
  assert.deepEqual(cells(x).slice(2), [['Ours % best', '7', '8', '9'], ['', 'x', 'y', 'z']]);
  assert.deepEqual(end, { row: 3, col: 3 });
  assert.equal(x.cols.length, 4);

  // Floats: settings and longtable.
  const c = L.buildContext(src, { bib: '', images: {} });
  const float = L.tableContainer(c.doc.blocks, m);
  assert.equal(float.kind, 'table');
  const ed = L.setFloatSetting(src, float, 'size', 'small');
  const withSmall = src.slice(0, ed.start) + ed.text + src.slice(ed.end);
  assert.match(withSmall, /\\centering\n  \\small\n  \\begin\{tabular\}/);
  const f2 = L.tableContainer(L.buildContext(withSmall, { bib: '', images: {} }).doc.blocks, L.findTableAt(withSmall, withSmall.indexOf('Both')));
  assert.deepEqual(Object.keys(L.floatSettings(withSmall, f2.innerStart, f2.innerEnd)), ['size']);
  const rm = L.setFloatSetting(withSmall, f2, 'size', null);
  assert.equal(withSmall.slice(0, rm.start) + rm.text + withSmall.slice(rm.end), src, 'removing the setting restores the source');
  assert.match(L.renderDocument(L.buildContext(withSmall, { bib: '', images: {} })), /<figure class="float tab" style="font-size:0.9em"/);

  const lt = L.floatToLongtable(src, float, m);
  const ltDoc = src.slice(0, lt.start) + lt.text + src.slice(lt.end);
  assert.match(lt.text, /^\\begin\{longtable\}\{l\|cc\}\n  \\caption\{Results\.\}\\label\{tab:r\} \\\\\n  \\toprule/);
  const ltc = L.buildContext(ltDoc, { bib: '', images: {} });
  assert.equal(ltc.labels.get('tab:r').num, '1', 'longtable captions are numbered');
  assert.match(L.stripTags(L.renderDocument(ltc)), /Table 1: Results\./);
  const back = L.longtableToFloat(ltDoc, L.findTableAt(ltDoc, ltDoc.indexOf('Both')));
  const backDoc = ltDoc.slice(0, back.start) + back.text + ltDoc.slice(back.end);
  assert.match(back.text, /^\\begin\{table\}\[htbp\]\n  \\centering\n  \\begin\{tabular\}\{l\|cc\}[\s\S]*\\end\{tabular\}\n  \\caption\{Results\.\}\n  \\label\{tab:r\}\n\\end\{table\}$/);
  assert.equal(L.buildContext(backDoc, { bib: '', images: {} }).labels.get('tab:r').num, '1');

  assert.equal(L.ensurePackage(src, 'amsmath'), null);
  const pk = L.ensurePackage(src, 'booktabs');
  assert.equal(src.slice(0, pk.start) + pk.text + src.slice(pk.end), src.replace('\\usepackage{amsmath}', '\\usepackage{amsmath}\n\\usepackage{booktabs}'));
  assert.deepEqual(L.parseTsv('a\tb\n"multi\nline"\t"say ""hi"""\n'), [['a', 'b'], ['multi line', 'say "hi"']]);
});
