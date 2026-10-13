// Unit tests for the LaTeX core (run against the bundled node build).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../../dist/latex.cjs');

const sampleDir = path.join(__dirname, '..', '..', 'sample');
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
    assert.equal(src, src.trim(), `block ${b.kind} has untrimmed range`);
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
  assert.match(html, /<strong>84\.5<\/strong>/);
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
