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
  const b = await p.launch({ executablePath: CHROME, headless: 'new' });
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
      c.querySelectorAll('.selected, .synced, .flash').forEach((n) => n.classList.remove('selected', 'synced', 'flash'));
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

  console.log(errs.length ? 'PAGE ERRORS:\n' + errs.join('\n') : 'no page errors');
  console.log('ALL INLINE CHECKS PASSED');
  await b.close();
  server.close();
  if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.stack.split('\n').slice(0, 2).join(' / ')); process.exit(1); });
