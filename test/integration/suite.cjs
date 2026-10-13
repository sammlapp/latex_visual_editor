// Runs inside VS Code: opens sample/paper.tex in the visual editor and drives
// the real webview through its test hooks.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

exports.run = async function () {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`  ✓ ${name}`);
    } catch (e) {
      results.push(`  ✗ ${name}: ${e.message}`);
    }
  };

  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'latex-visual-editor');
  const { provider } = await ext.activate();
  const ws = vscode.workspace.workspaceFolders[0].uri;
  const uri = vscode.Uri.joinPath(ws, 'paper.tex');

  await vscode.commands.executeCommand('latexVisual.open', uri);
  const session = await until(() => provider.sessionFor(uri), 'editor session');
  await until(() => session.lastStats, 'first render');

  await check('opens as a custom editor tab', async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab.input instanceof vscode.TabInputCustom, 'custom tab');
    assert.equal(tab.input.viewType, 'latexVisual.editor');
  });

  await check('renders all block kinds without errors', async () => {
    const s = session.lastStats;
    for (const k of ['heading', 'paragraph', 'math', 'figure', 'table', 'list', 'env', 'command', 'preamble']) assert.ok(s.kinds[k] > 0, `missing ${k}: ${JSON.stringify(s.kinds)}`);
    assert.equal(s.katexErrors, 0, 'KaTeX errors');
    assert.equal(s.renderErrors, 0, 'render errors');
    assert.equal(s.undefinedRefs, 1, 'exactly the intentional undefined ref');
    assert.equal(s.undefinedCites, 0, '.bib resolved by the host');
    assert.deepEqual(session.errors, [], 'webview errors');
  });

  await check('resolves images and PDF figures through the host', async () => {
    const html = await session.test({ action: 'html' });
    assert.match(html, /img class="graphic" src="https:\/\/[^"]*spectrum\.png\?v=\d+/);
    assert.match(html, /data-pdf="https:\/\/[^"]*signal\.pdf\?v=\d+/);
    assert.match(html, /Image not found: missing-figure/);
    // Give pdf.js time to rasterise, then confirm no failures.
    const after = await until(async () => {
      const h = await session.test({ action: 'html' });
      return /Could not render PDF|pdf-graphic[^>]*src="data:image\/png/.test(h) && h;
    }, 'pdf.js rasterisation', 20000);
    assert.ok(!/Could not render PDF/.test(after), 'pdf.js rendered the PDF: ' + (after.match(/Could not render PDF[^<]*/) || [''])[0]);
  });

  const doc = await vscode.workspace.openTextDocument(uri);

  await check('editing a block in the webview updates the document', async () => {
    const before = doc.getText();
    const res = await session.test({ action: 'editBlock', selector: '.blk-heading', index: 0, text: '\\section{Overview}\\label{sec:intro}', replace: true });
    assert.ok(res.ok, JSON.stringify(res));
    await until(() => doc.getText().includes('\\section{Overview}'), 'document edit');
    assert.equal(doc.getText(), before.replace('\\section{Introduction}\\label{sec:intro}', '\\section{Overview}\\label{sec:intro}'));
    assert.ok(doc.isDirty, 'document marked dirty');
  });

  await check('edits from the webview are recognised as its own (no editor reset)', async () => {
    const res = await session.test({ action: 'editBlock', selector: '.blk-paragraph', index: 1, text: ' Appended.' });
    assert.ok(res.ok, JSON.stringify(res));
    await until(() => doc.getText().includes('all\nrendered inline.\\footnote{Footnotes are shown below their paragraph.} Appended.'), 'append edit');
  });

  await check('typing inline in the rendered text edits the source', async () => {
    const res = await session.test({ action: 'typeAt', after: 'Special relativity', text: ' theory 100%' });
    assert.ok(res.ok, JSON.stringify(res));
    await until(() => doc.getText().includes('Special relativity theory 100\\%~\\cite{einstein1905}'), 'typed text in document');
    const html = await session.test({ action: 'html' });
    assert.match(html, /Special relativity theory 100%/);
  });

  await check('undo from the visual editor reverts typing', async () => {
    const before = doc.getText();
    await vscode.commands.executeCommand('undo');
    await until(() => doc.getText() !== before, 'undo applied');
    assert.ok(!doc.getText().includes('theory 100\\%'), 'typing undone');
    await vscode.commands.executeCommand('redo');
    await until(() => doc.getText().includes('theory 100\\%'), 'redo applied');
  });

  await check('inserting a block from the toolbar', async () => {
    const res = await session.test({ action: 'insert', template: 'equation' });
    assert.ok(res.ok, 'editor opened on the new block');
    await until(() => doc.getText().includes('\\label{eq:new}'), 'inserted equation');
  });

  await check('external text edits re-render the webview', async () => {
    const e = new vscode.WorkspaceEdit();
    const off = doc.getText().indexOf('\\subsection{Results}');
    e.replace(uri, new vscode.Range(doc.positionAt(off), doc.positionAt(off + '\\subsection{Results}'.length)), '\\subsection{Findings}');
    const rendered = session.waitForRender();
    await vscode.workspace.applyEdit(e);
    await rendered;
    const html = await session.test({ action: 'html' });
    assert.match(html, /Findings/);
  });

  await check('undo goes through the normal document history', async () => {
    await vscode.commands.executeCommand('undo');
    await until(() => doc.getText().includes('\\subsection{Results}'), 'undo applied');
  });

  await check('saving writes the file', async () => {
    await doc.save();
    const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    assert.ok(disk.includes('\\section{Overview}'));
  });

  console.log('\nIntegration results:\n' + results.join('\n') + '\n');
  if (results.some((r) => r.includes('✗'))) throw new Error('integration checks failed');
};
