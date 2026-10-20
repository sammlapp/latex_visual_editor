// Drives the real webview bundle in Chrome (via test/harness) with real
// keyboard input and checks the resulting LaTeX source. After each step the
// incrementally-updated DOM must equal a fresh render of the new source.
// Run: npm run test:browser   (uses the locally installed Google Chrome)
const p = require('puppeteer-core');
const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'dist/latex.cjs'));
const FIX = path.join(ROOT, 'test/fixtures/');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(process.execPath, [path.join(ROOT, 'test/harness/make.mjs'), '--paper'], { cwd: ROOT });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.pdf': 'application/pdf', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(0);
const URL_BASE = `http://localhost:${server.address().port}`;
const original = fs.readFileSync(FIX + 'paper.tex', 'utf8');
const host = { bib: fs.readFileSync(FIX + 'refs.bib', 'utf8'), images: { signal: { kind: 'pdf', uri: '/test/fixtures/figures/signal.pdf' }, 'spectrum.png': { kind: 'image', uri: '/test/fixtures/figures/spectrum.png' }, 'missing-figure': { kind: 'missing' } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await p.launch({ executablePath: CHROME, headless: 'new', args: process.env.CI ? ['--no-sandbox'] : [] });
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errs.push(m.text()); });
  await pg.setViewport({ width: 1000, height: 1100 });
  await pg.goto(URL_BASE + '/test/harness/index.html');
  await pg.waitForSelector('.blk-paragraph');
  let doc = original;
  const sync = async () => {
    await sleep(350);
    const sent = await pg.evaluate(() => window.__sent.splice(0));
    for (const m of sent) if (m.type === 'edit') doc = doc.slice(0, m.start) + m.text + doc.slice(m.end);
    return doc;
  };
  // Put the caret right after `needle` in rendered text (optionally inside a selector).
  const caretAfter = (needle, sel = '.r') => pg.evaluate((needle, sel) => {
    const run = [...document.querySelectorAll(sel)].find((r) => r.textContent.includes(needle));
    if (!run) throw new Error('not found: ' + needle);
    const node = run.classList.contains('r') ? run.firstChild : [...run.querySelectorAll('.r')].find((r) => r.textContent.includes(needle)).firstChild;
    const range = document.createRange();
    range.setStart(node, node.textContent.indexOf(needle) + needle.length);
    document.getElementById('doc').focus();
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  }, needle, sel);
  const selectText = (needle) => pg.evaluate((needle) => {
    const run = [...document.querySelectorAll('.r')].find((r) => r.textContent.includes(needle));
    const node = run.firstChild; const i = node.textContent.indexOf(needle);
    const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + needle.length);
    document.getElementById('doc').focus();
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  }, needle);
  // The DOM after incremental edits must equal a fresh render of the same source.
  const consistent = async (label) => {
    const live = await pg.evaluate(() => {
      const c = document.getElementById('doc').cloneNode(true);
      c.querySelectorAll('.add-block, .phantom, .editor').forEach((n) => n.remove());
      c.querySelectorAll('.selected, .synced, .flash, .tab-active, .tab-cur').forEach((n) => n.classList.remove('selected', 'synced', 'flash', 'tab-active', 'tab-cur'));
      c.querySelectorAll('img[data-pdf]').forEach((n) => { n.removeAttribute('src'); n.classList.remove('loading'); });
      c.querySelectorAll('[class=""]').forEach((n) => n.removeAttribute('class'));
      return c.innerHTML;
    });
    const tpl = await pg.evaluate((html) => { const d = document.createElement('div'); d.innerHTML = html; d.querySelectorAll('[class=""]').forEach((n) => n.removeAttribute('class')); return d.innerHTML; }, L.renderDocument(L.buildContext(doc, host)));
    if (live !== tpl) {
      let k = 0; while (live[k] === tpl[k]) k++;
      throw new Error(`${label}: DOM diverged from fresh render at ${k}:\n live: ${live.slice(k - 80, k + 120)}\n want: ${tpl.slice(k - 80, k + 120)}`);
    }
  };

  // 1. Type in the middle of a paragraph.
  await caretAfter('Special relativity');
  await pg.keyboard.type(' theory');
  await sync();
  assert.ok(doc.includes('Special relativity theory~\\cite{einstein1905}'), '1 typed text');
  await consistent('after typing');

  // 2. Backspace.
  for (let k = 0; k < 3; k++) await pg.keyboard.press('Backspace');
  await sync();
  assert.ok(doc.includes('Special relativity the~\\cite'), '2 backspace');
  await consistent('after backspace');
  // caret is still in place: keep typing
  await pg.keyboard.type('ory');
  await sync();
  assert.ok(doc.includes('Special relativity theory~\\cite'), '2b caret kept');

  // 3. Special characters are escaped.
  await caretAfter('rely on ');
  await pg.keyboard.type('50% & more ');
  await sync();
  assert.ok(doc.includes('rely on 50\\% \\& more \\emph{attention}'), '3 escaping: ' + doc.slice(doc.indexOf('rely on'), doc.indexOf('rely on') + 40));
  await consistent('after escapes');

  // 4. Bold a word with ⌘B, then type inside the bold text.
  await selectText('Modern');
  await pg.keyboard.down('Meta'); await pg.keyboard.press('b'); await pg.keyboard.up('Meta');
  await sync();
  assert.ok(doc.includes('\\textbf{Modern} models'), '4 bold');
  await consistent('after bold');

  // 5. Enter splits a paragraph; Backspace at its start merges it back.
  await caretAfter(' for details, ');
  await pg.keyboard.press('Enter');
  await sync();
  assert.ok(/for details, \n\nand\n\\textbf\{bold\}/.test(doc), '5 split: ' + JSON.stringify(doc.slice(doc.indexOf('for details'), doc.indexOf('for details') + 30)));
  await consistent('after split');
  await pg.keyboard.press('Backspace');
  await sync();
  assert.ok(doc.includes('for details, and\n\\textbf{bold}'), '5 merge: ' + JSON.stringify(doc.slice(doc.indexOf('for details'), doc.indexOf('for details') + 30)));
  await consistent('after merge');

  // 6. Typing $ opens the math popover.
  await caretAfter('numbered automatically');
  await pg.keyboard.type(' with $');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('x^2');
  await sleep(50);
  const pv = await pg.$eval('.popover-preview', (e) => e.textContent);
  assert.ok(pv.includes('x'), '6 popover preview');
  await pg.keyboard.press('Enter');
  await sync();
  assert.ok(doc.includes('numbered automatically with $x^2$.'), '6 math inserted');
  await consistent('after math');
  await pg.keyboard.type(' ok');
  await sync();
  assert.ok(doc.includes('with $x^2$ ok.'), '6b caret after math');

  // 7. Enter at the end of a paragraph → new paragraph.
  await caretAfter('are numbered automatically with ');
  await pg.keyboard.press('End');
  await pg.evaluate(() => { const p = [...document.querySelectorAll('p.ed')].find((p) => p.textContent.includes('numbered automatically')); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('.phantom');
  await pg.keyboard.type('A brand new paragraph.');
  await sync();
  assert.ok(doc.includes('ok.\n\nA brand new paragraph.\n\n\\begin{theorem}'), '7 new paragraph: ' + JSON.stringify(doc.slice(doc.indexOf('ok.'), doc.indexOf('ok.') + 50)));
  await consistent('after new paragraph');

  // 7b. Math inserted at the very end of a paragraph: keep typing after it.
  await pg.evaluate(() => { const p = [...document.querySelectorAll('p.ed')].find((p) => p.textContent.includes('A brand new paragraph.')); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await pg.keyboard.type(' $');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('y');
  await pg.keyboard.press('Enter');
  await sleep(50);
  await pg.keyboard.type(' after');
  await sync();
  assert.ok(doc.includes('A brand new paragraph. $y$ after\n'), '7b typing after trailing math: ' + JSON.stringify(doc.slice(doc.indexOf('A brand new'), doc.indexOf('A brand new') + 45)));
  await consistent('after trailing math');

  // 7c. A paragraph ending in a citation: click to its right and type.
  // Remove the final '.' so the paragraph ends with the citation.
  await pg.evaluate(() => { const p = [...document.querySelectorAll('p.ed')].find((p) => p.textContent.includes('Standard; see')); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); p.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await pg.keyboard.press('Backspace');
  await sync();
  assert.ok(doc.includes('Standard; see \\cite{knuth1984}\n'), '7c setup: ' + JSON.stringify(doc.slice(doc.indexOf('Standard;'), doc.indexOf('Standard;') + 40)));
  await pg.evaluate(() => getSelection().removeAllRanges());
  const box = await pg.evaluate(() => { const p = [...document.querySelectorAll('p.ed')].find((p) => p.textContent.includes('Standard; see')); const isl = [...p.querySelectorAll('.isl')].pop(); isl.scrollIntoView({ block: 'center' }); const r = isl.getBoundingClientRect(); return { x: r.right + 40, y: r.top + r.height / 2 }; });
  await pg.mouse.click(box.x, box.y);
  await pg.keyboard.type(' and more');
  await sync();
  assert.ok(doc.includes('Standard; see \\cite{knuth1984} and more\n'), '7c typing after clicked citation: ' + JSON.stringify(doc.slice(doc.indexOf('Standard;'), doc.indexOf('Standard;') + 50)));
  await consistent('after clicking past citation');

  // 7d. Citation completion: typing \citep{lapp open shows the bibliography entry.
  await caretAfter('rely on 50% & more ');
  await pg.keyboard.type('(see \\');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('citep{lapp open');
  await pg.waitForSelector('.complete .cmp.active');
  const first = await pg.$eval('.complete .cmp.active b', (b) => b.textContent);
  assert.equal(first, 'lapp2023opensoundscape', '7d top suggestion');
  await pg.keyboard.press('Enter');
  await sleep(50);
  await pg.keyboard.type(') ');
  await sync();
  assert.ok(doc.includes('rely on 50\\% \\& more (see \\citep{lapp2023opensoundscape}) \\emph{attention}'), '7d cite inserted: ' + JSON.stringify(doc.slice(doc.indexOf('rely on'), doc.indexOf('rely on') + 80)));
  await consistent('after cite completion');

  // 7e. Toolbar Cite: Tab adds a second key; typing continues afterwards (focus kept).
  await caretAfter('are numbered automatically with ');
  await pg.click('button[data-action="cite"]');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('einstein');
  await pg.waitForSelector('.complete .cmp.active');
  await pg.keyboard.press('Tab');
  await pg.keyboard.type('texbook');
  await sleep(30);
  await pg.keyboard.press('Enter');
  await sleep(50);
  await pg.keyboard.type('and ');
  await sync();
  assert.ok(doc.includes('automatically with \\cite{einstein1905, knuth1984}and $x^2$'), '7e toolbar cite: ' + JSON.stringify(doc.slice(doc.indexOf('automatically with'), doc.indexOf('automatically with') + 60)));

  // 7f. Toolbar Ref after a word: tied with ~, equations become \eqref, and typing continues.
  await caretAfter('The gradient update is given by');
  await pg.click('button[data-action="ref"]');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('loss');
  await pg.waitForSelector('.complete .cmp.active');
  await pg.keyboard.press('Enter');
  await sleep(50);
  await pg.keyboard.type(' again');
  await sync();
  assert.ok(doc.includes('The gradient update is given by~\\eqref{eq:loss} again'), '7f toolbar ref: ' + JSON.stringify(doc.slice(doc.indexOf('The gradient update'), doc.indexOf('The gradient update') + 60)));
  await consistent('after ref completion');

  // 7g. Completion inside the block source editor.
  await pg.evaluate(() => { const p = [...document.querySelectorAll('.blk-paragraph')].find((b) => b.textContent.includes('A brand new paragraph')); p.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); });
  await pg.click('#gutter');
  await pg.waitForSelector('.editor textarea');
  await pg.evaluate(() => { const t = document.querySelector('.editor textarea'); t.setSelectionRange(t.value.length, t.value.length); });
  await pg.keyboard.type(' \\citet{companion');
  await pg.waitForSelector('.complete .cmp.active');
  await pg.keyboard.press('Enter');
  const edited = await pg.$eval('.editor textarea', (t) => t.value);
  assert.ok(edited.endsWith('\\citet{goossens1994}'), '7g source editor completion: ' + edited.slice(-40));
  await pg.keyboard.press('Escape');
  await sync();
  await consistent('after source editor completion');

  // 8. Headings, captions and table cells are editable.
  await caretAfter('Introduction', '.ed[data-region="h"] .r');
  await pg.keyboard.type(' and Motivation');
  await caretAfter('Accuracy by method', '.ed[data-region="cap"] .r');
  await pg.keyboard.type(' (higher is better)');
  await caretAfter('84.5', '.ed[data-region="cell"] .r');
  await pg.keyboard.type('0');
  await sync();
  assert.ok(doc.includes('\\section{Introduction and Motivation}\\label{sec:intro}'), '8 heading');
  assert.ok(doc.includes('\\caption{Accuracy by method (higher is better).}'), '8 caption');
  assert.ok(doc.includes('\\textbf{84.50}'), '8 cell');
  await consistent('after heading/caption/cell');

  // 9. Enter at the end of a list item starts a new item.
  await pg.evaluate(() => { const p = [...document.querySelectorAll('p.ed')].find((p) => p.textContent.includes('Second numbered point')); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('Third point.');
  await sync();
  assert.ok(doc.includes('\\item Second numbered point.\n  \\item Third point.\n\\end{enumerate}'), '9 list item: ' + JSON.stringify(doc.slice(doc.indexOf('Second numbered'), doc.indexOf('Second numbered') + 60)));
  await consistent('after list item');

  // 10. Undo request goes to the host.
  await pg.keyboard.down('Meta'); await pg.keyboard.press('z'); await pg.keyboard.up('Meta');
  const sent = await pg.evaluate(() => window.__sent.splice(0));
  assert.ok(sent.some((m) => m.type === 'undo'), '10 undo forwarded');

  // 11. Clicking inline math opens its source editor; clicking a ref jumps instead.
  await pg.click('.ed .isl.math');
  await pg.waitForSelector('.editor.inline-editor textarea');
  const src = await pg.$eval('.editor textarea', (t) => t.value);
  assert.ok(src.startsWith('$') && src.endsWith('$'), '11 inline math source: ' + src);
  await pg.keyboard.press('Escape');
  await sleep(100);
  await consistent('after inline math editor');

  // 12. Deleting a selection across formatting keeps braces balanced.
  await pg.evaluate(() => {
    const runs = [...document.querySelectorAll('.r')];
    const a = runs.find((r) => r.textContent.includes('bold')); const z = runs.find((r) => r.textContent.startsWith(', ') && r.previousElementSibling?.tagName === 'EM');
    const range = document.createRange(); range.setStart(a.firstChild, 2); range.setEnd(z.firstChild, 2);
    document.getElementById('doc').focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  });
  await pg.keyboard.press('Backspace');
  await sync();
  assert.ok(doc.includes('for details, and\n\\textbf{bo}\\texttt{monospace}'), '12 cross-format delete: ' + JSON.stringify(doc.slice(doc.indexOf('for details'), doc.indexOf('for details') + 60)));
  await consistent('after cross-format delete');

  // 13. Diagnostics (LTeX etc.) are underlined, follow edits, and offer the server's quick fixes on hover.
  await sync();
  const diagAt = (word) => ({ start: doc.indexOf(word), end: doc.indexOf(word) + word.length, text: word });
  await pg.evaluate((items) => window.postMessage({ type: 'diagnostics', batch: 7, items }, '*'), [
    { ...diagAt('relativity'), severity: 'info', message: 'Possible spelling mistake found.', source: 'LTeX', code: 'MORFOLOGIK_RULE_EN_US' },
    { ...diagAt('Results'), severity: 'warning', message: 'Heading word.', source: 'LTeX' },
  ]);
  await sleep(50);
  const drawn = () => pg.evaluate(() => ['info', 'warning'].map((k) => [...(CSS.highlights.get(`diag-${k}`) ?? [])].map((r) => r.toString()).join('|')));
  assert.deepEqual(await drawn(), ['relativity', 'Results'], '13 underlines drawn');
  await caretAfter('Speci');
  await pg.keyboard.type('xyz');
  await sleep(50);
  { const d = await drawn(); assert.deepEqual(d, ['relativity', 'Results'], '13 underlines follow typing before them: ' + JSON.stringify(d)); }
  await sync();
  const rect = await pg.evaluate(() => { const r = [...CSS.highlights.get('diag-info')][0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await pg.mouse.move(rect.x, rect.y);
  await pg.waitForSelector('.diag-pop', { timeout: 2000 });
  assert.match(await pg.$eval('.diag-pop', (p) => p.textContent), /Possible spelling mistake found\.LTeX · MORFOLOGIK_RULE_EN_US/);
  const req = (await pg.evaluate(() => window.__sent.splice(0))).find((m) => m.type === 'codeActions');
  assert.ok(req && req.batch === 7 && req.index === 0, '13 fixes requested for the hovered diagnostic: ' + JSON.stringify(req));
  await pg.evaluate((id) => window.postMessage({ type: 'codeActionsResult', id, items: [{ title: "Use 'relativistic'", preferred: true }, { title: "Add 'relativity' to dictionary", preferred: false }] }, '*'), req.id);
  await pg.waitForSelector('.diag-fix.preferred');
  await pg.click('.diag-fix:not(.preferred)');
  const applied = (await pg.evaluate(() => window.__sent.splice(0))).find((m) => m.type === 'applyCodeAction');
  assert.equal(applied?.index, 1, '13 chosen fix applied by the host');
  assert.equal(await pg.$('.diag-pop'), null, '13 popup closed');
  // Typing inside a flagged word drops its underline until the server checks again.
  await caretAfter('Resul');
  await pg.keyboard.type('x');
  await sleep(50);
  assert.deepEqual(await drawn(), ['relativity', ''], '13 edited diagnostic removed');
  await sync();
  assert.ok(doc.includes('Specixyzal relativity') && doc.includes('\\subsection{Resulxts}'), '13 edits');
  await consistent('after diagnostics');

  // 14. File paths complete inside \includegraphics{…} (the host supplies the folder's files;
  // the fixture's \graphicspath{{figures/}} makes the short path the first suggestion).
  await sync();
  await caretAfter('Specixyzal');
  await pg.keyboard.type('\\');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('includegraphics{spec');
  await pg.waitForFunction(() => window.__sent.some((m) => m.type === 'listFiles'));
  await pg.evaluate(() => window.postMessage({ type: 'files', files: ['paper.tex', 'figures/spectrum.png', 'figures/signal.pdf', 'refs.bib'] }, '*'));
  await pg.waitForFunction(() => document.querySelector('.complete .cmp.active b')?.textContent === 'spectrum.png');
  assert.deepEqual(await pg.$$eval('.complete .cmp b', (bs) => bs.map((b) => b.textContent)), ['spectrum.png', 'figures/spectrum.png'], '14 only matching graphics offered');
  await pg.keyboard.press('Enter');
  await sync();
  assert.ok(doc.includes('Specixyzal\\includegraphics{spectrum.png} relativity'), '14 path inserted: ' + JSON.stringify(doc.slice(doc.indexOf('Specixyzal'), doc.indexOf('Specixyzal') + 60)));
  await consistent('after file completion');

  // 14b. Paste and cut arrive as clipboard events (VS Code uses execCommand) and edit the source.
  await sync();
  await caretAfter('Specixyzal');
  await pg.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', ' 50% more');
    dt.setData('text/html', '<b>ignored</b>');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sync();
  assert.ok(doc.includes('Specixyzal 50\\% more\\includegraphics'), '14b paste: ' + JSON.stringify(doc.slice(doc.indexOf('Specixyzal'), doc.indexOf('Specixyzal') + 40)));
  await selectText(' more');
  const cutText = await pg.evaluate(() => {
    const dt = new DataTransfer();
    document.activeElement.dispatchEvent(new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
  await sync();
  assert.equal(cutText, ' more', '14b cut copies the text');
  assert.ok(doc.includes('Specixyzal 50\\%\\includegraphics'), '14b cut removed it from the source');
  await consistent('after paste/cut');

  // 14c. The × on a hovered block deletes it (a list item's only paragraph deletes the item).
  await sync();
  const hoverDelete = async (sel, text) => {
    const box = await pg.evaluate((sel, text) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    }, sel, text);
    await pg.mouse.move(box.x, box.y);
    await pg.waitForSelector('#del-block', { visible: true });
    await pg.click('#del-block');
    await sync();
  };
  await hoverDelete('li .blk-paragraph', 'First numbered point');
  assert.ok(doc.includes('\\begin{enumerate}\n  \\item Second numbered point.'), '14c list item deleted: ' + JSON.stringify(doc.slice(doc.indexOf('\\begin{enumerate}'), doc.indexOf('\\begin{enumerate}') + 50)));
  assert.match(await pg.$eval('.toast', (t) => t.textContent), /Deleted list item\.Undo/);
  await pg.click('.toast button');
  assert.ok((await pg.evaluate(() => window.__sent.splice(0))).some((m) => m.type === 'undo'), '14c toast undo forwarded');
  await consistent('after deleting an item');
  await hoverDelete('.blk-comment', 'hidden in the output');
  assert.ok(doc.includes('\\end{enumerate}\n\n\\bibliographystyle{plain}'), '14c comment block and its line deleted: ' + JSON.stringify(doc.slice(doc.indexOf('\\end{enumerate}'), doc.indexOf('\\end{enumerate}') + 40)));
  await consistent('after deleting a block');
  const preBox = await pg.evaluate(() => { const r = document.querySelector('.blk-preamble'); r.scrollIntoView(); const b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; });
  await pg.mouse.move(preBox.x, preBox.y);
  assert.equal(await pg.$eval('#del-block', (b) => getComputedStyle(b).display), 'none', '14c the preamble cannot be deleted');

  // 15. Table editing: the table bar appears in a cell, and edits rewrite the tabular.
  await sync();
  const tableSrc = () => doc.slice(doc.indexOf('\\begin{table}'), doc.indexOf('\\end{table}') + 11);
  await caretAfter('Baseline');
  await pg.waitForSelector('#table-bar:not([hidden])');
  assert.ok(await pg.$eval('#table-bar [data-t="booktabs"]', (c) => c.checked), '15 booktabs detected');
  assert.ok(await pg.$('table.tab-active td.tab-cur'), '15 grid shown on the active table');
  await pg.click('#table-bar [data-t="row-below"]');
  await pg.keyboard.type('New');
  await pg.keyboard.press('Tab');
  await pg.keyboard.type('x');
  await sync();
  assert.ok(tableSrc().includes('Baseline & 71.2 & 1.0 \\\\\n    New & x & \\\\\n    Ours'), '15 row inserted and filled: ' + JSON.stringify(tableSrc()));
  await consistent('after row insert');
  await pg.click('#table-bar [data-t="align-r"]');
  await sync();
  assert.ok(tableSrc().includes('\\begin{tabular}{lrc}'), '15 column right-aligned');
  // Paste a 2×2 block copied from a spreadsheet into the new row's last cell: adds a column and a row.
  await caretAfter('x', 'td .r');
  await pg.keyboard.press('Tab');
  await pg.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '5%\t6\n7\t8\n');
    // A paste event without beforeinput, as VS Code's execCommand('paste') produces.
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sync();
  assert.ok(tableSrc().includes('{lrcc}') && tableSrc().includes('New & x & 5\\% & 6 \\\\\n    Ours & \\textbf{84.50} & 7 & 8 \\\\'), '15 pasted grid: ' + JSON.stringify(tableSrc()));
  await consistent('after paste');
  // Merge two cells by selecting across them, then split again.
  await pg.evaluate(() => {
    const runs = [...document.querySelectorAll('td .r')];
    const a = runs.find((r) => r.textContent.trim() === 'New'); const b = runs.find((r) => r.textContent.trim() === 'x');
    const range = document.createRange(); range.setStart(a.firstChild, 0); range.setEnd(b.firstChild, 1);
    document.getElementById('doc').focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  });
  await pg.click('#table-bar [data-t="merge"]');
  await sync();
  assert.ok(tableSrc().includes('\\multicolumn{2}{l}{New x} & 5\\%'), '15 merged: ' + tableSrc());
  await pg.click('#table-bar [data-t="split"]');
  await sync();
  assert.ok(tableSrc().includes('New x & & 5\\%'), '15 split: ' + tableSrc());
  await consistent('after merge/split');
  // Float settings and longtable.
  await pg.select('#table-bar select[data-t="size"]', 'small');
  await sync();
  assert.ok(tableSrc().includes('\\centering\n  \\small\n'), '15 font size: ' + tableSrc());
  await consistent('after font size');
  await caretAfter('Baseline');
  await pg.click('#table-bar [data-t="longtable"]');
  await sync();
  assert.ok(doc.includes('\\usepackage{longtable}') && /\\begin\{longtable\}\{lrcc\}\n  \\caption\{[^}]*\}\n?\s*\\label\{tab:results\} \\\\/.test(doc), '15 longtable: ' + doc.slice(doc.indexOf('\\begin{longtable}'), doc.indexOf('\\begin{longtable}') + 120));
  await consistent('after longtable');
  await pg.click('#table-bar [data-t="longtable"]');
  await sync();
  assert.ok(/\\begin\{table\}\[htbp\]\n  \\centering\n  \\begin\{tabular\}\{lrcc\}/.test(doc) && !doc.includes('\\begin{longtable}'), '15 back to a float');
  await consistent('after table float again');

  // 16. Command completion: in running text (the \\ box) and in a source editor.
  await sync();
  await caretAfter('Specixyzal');
  await pg.keyboard.type('\\');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('bet');
  await pg.waitForFunction(() => document.querySelector('.complete .cmp.active b')?.textContent === '\\beta');
  assert.ok(await pg.$('.complete .cmp.active .cmp-prev .katex'), '16 math symbols show a preview');
  await pg.keyboard.press('Enter');
  await sync();
  assert.ok(doc.includes('Specixyzal$\\beta$'), '16 math symbol wrapped in $ in text: ' + JSON.stringify(doc.slice(doc.indexOf('Specixyzal'), doc.indexOf('Specixyzal') + 30)));
  await caretAfter('Specixyzal');
  await pg.keyboard.type('\\');
  await pg.waitForSelector('.popover textarea');
  await pg.keyboard.type('textb');
  await pg.waitForFunction(() => document.querySelector('.complete .cmp.active b')?.textContent === '\\textbf{}');
  await pg.keyboard.press('Enter');
  assert.deepEqual(await pg.$eval('.popover textarea', (t) => [t.value, t.selectionStart]), ['\\textbf{}', 8], '16 caret inside the braces');
  await pg.keyboard.type('bold');
  await pg.keyboard.press('Enter');
  await sync();
  assert.ok(doc.includes('Specixyzal\\textbf{bold}$\\beta$'), '16 command with argument');
  await consistent('after command completion');
  // Source editor: environments get their \\end, and Enter after \\item is a newline.
  const para = await pg.evaluate(() => { const el = [...document.querySelectorAll('.blk-paragraph')].find((e) => e.textContent.includes('Specixyzal')); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 8 }; });
  await pg.mouse.move(para.x, para.y);
  await pg.waitForSelector('#gutter', { visible: true });
  await pg.click('#gutter');
  await pg.waitForSelector('.editor textarea');
  await pg.evaluate(() => { const t = document.querySelector('.editor textarea'); t.setSelectionRange(t.value.length, t.value.length); });
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('\\begin{ite');
  await pg.waitForFunction(() => document.querySelector('.complete .cmp.active b')?.textContent === 'itemize');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('\\item');
  await pg.waitForFunction(() => document.querySelector('.complete .cmp.active b')?.textContent === '\\item');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('Point');
  const val = await pg.$eval('.editor textarea', (t) => t.value);
  assert.ok(val.endsWith('\n\\begin{itemize}\n  \\item\nPoint\n\\end{itemize}'), '16 environment completed: ' + JSON.stringify(val.slice(-60)));
  await pg.keyboard.press('Escape');
  await sync();
  assert.ok(doc.includes('\\begin{itemize}\n  \\item\nPoint\n\\end{itemize}'), '16 saved');
  await consistent('after source editor completion');

  // 17. The \\ box opens just below the caret, also in an empty paragraph or an empty table cell.
  for (const where of ['paragraph', 'cell']) {
    if (where === 'paragraph') {
      await caretAfter('Specixyzal');
      await pg.evaluate(() => { const p = getSelection().focusNode.parentElement.closest('.ed'); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
      await pg.keyboard.press('Enter');
    } else {
      await pg.evaluate(() => { const ed = [...document.querySelectorAll('.ed[data-region="cell"]')].find((e) => e.dataset.s === e.dataset.e); ed.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.setStart(ed, 0); document.getElementById('doc').focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    }
    const target = await pg.evaluate(() => getSelection().focusNode.closest?.('.ed')?.getBoundingClientRect().bottom ?? getSelection().focusNode.parentElement.closest('.ed').getBoundingClientRect().bottom);
    await pg.keyboard.type('\\');
    await pg.waitForSelector('.popover');
    const top = await pg.$eval('.popover', (p) => p.getBoundingClientRect().top);
    assert.ok(top > target - 30 && top < target + 30, `17 box below the empty ${where}: box ${Math.round(top)}, ${where} bottom ${Math.round(target)}`);
    await pg.keyboard.press('Escape');
    await sleep(100);
  }
  await sync();
  await consistent('after empty-region boxes');

  console.log(errs.length ? 'PAGE ERRORS:\n' + errs.join('\n') : 'no page errors');
  console.log('ALL INLINE CHECKS PASSED');
  await b.close();
  server.close();
  if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.stack.split('\n').slice(0, 2).join(' / ')); process.exit(1); });
