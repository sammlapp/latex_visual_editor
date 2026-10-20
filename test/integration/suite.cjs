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

  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'swan-latex-visual-editor');
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
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await until(() => doc.getText() !== before, 'undo applied');
    assert.ok(!doc.getText().includes('theory 100\\%'), 'typing undone');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
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
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await until(() => doc.getText().includes('\\subsection{Results}'), 'undo applied');
  });

  await check('saving writes the file', async () => {
    await doc.save();
    const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    assert.ok(disk.includes('\\section{Overview}'));
  });

  // A small two-file document for \input and diagnostics.
  const mainUri = vscode.Uri.joinPath(ws, 'main.tex');
  const chapUri = vscode.Uri.joinPath(ws, 'chapters', 'intro.tex');
  await vscode.workspace.fs.writeFile(chapUri, Buffer.from('\\section{Included}\\label{sec:inc}\nText from the chapter file.\n'));
  await vscode.workspace.fs.writeFile(mainUri, Buffer.from('\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\nSee Section~\\ref{sec:inc}. A mispelled word.\n\\end{document}\n'));
  await vscode.commands.executeCommand('latexVisual.open', mainUri);
  const main = await until(() => provider.sessionFor(mainUri), 'main.tex session');
  await until(async () => /Text from the chapter file/.test(await main.test({ action: 'html' })), 'included file rendered');

  await check('\\input renders the included file read-only, with refs into it', async () => {
    const html = await main.test({ action: 'html' });
    assert.match(html, /class="include-body"/);
    assert.match(html, /<span class="secnum" contenteditable="false">1<\/span><span class="ro"/);
    assert.match(html, /title="sec:inc">1</, 'reference resolved to the included section');
    assert.match(html, /data-file="chapters\/intro"/);
  });

  await check('edits to the included file update the visual editor live', async () => {
    const chap = await vscode.workspace.openTextDocument(chapUri);
    const e = new vscode.WorkspaceEdit();
    e.insert(chapUri, chap.positionAt(chap.getText().length), 'Freshly added sentence.\n');
    await vscode.workspace.applyEdit(e);
    await until(async () => /Freshly added sentence/.test(await main.test({ action: 'html' })), 'live include refresh', 5000);
  });

  await check('path completion lists the files next to the document', async () => {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(ws, 'paper.aux'), Buffer.from(''));
    const files = await main.test({ action: 'files' });
    for (const f of ['main.tex', 'paper.tex', 'refs.bib', 'chapters/intro.tex', 'figures/spectrum.png', 'figures/signal.pdf']) assert.ok(files.includes(f), `${f} in ${JSON.stringify(files)}`);
    assert.ok(!files.includes('paper.aux'), 'build output skipped');
  });

  await check('LTeX diagnostics are underlined and their quick fixes apply', async () => {
    const mdoc = await vscode.workspace.openTextDocument(mainUri);
    const at = mdoc.getText().indexOf('mispelled');
    const range = new vscode.Range(mdoc.positionAt(at), mdoc.positionAt(at + 'mispelled'.length));
    const coll = vscode.languages.createDiagnosticCollection('test-ltex');
    const ltex = new vscode.Diagnostic(range, "Possible spelling mistake found.", vscode.DiagnosticSeverity.Information);
    ltex.source = 'LTeX';
    const other = new vscode.Diagnostic(range, 'Compiler noise', vscode.DiagnosticSeverity.Error);
    other.source = 'LaTeX';
    coll.set(mainUri, [ltex, other]);
    const fix = vscode.languages.registerCodeActionsProvider({ pattern: '**/main.tex' }, {
      provideCodeActions(doc, r, c) {
        if (!c.diagnostics.some((d) => d.source === 'LTeX')) return [];
        const a = new vscode.CodeAction("Use 'misspelled'", vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, r, 'misspelled');
        a.diagnostics = [ltex];
        a.isPreferred = true;
        return [a];
      },
    });
    try {
      const drawn = await until(async () => {
        const d = await main.test({ action: 'diagnostics' });
        return d.drawn.length && d;
      }, 'underline drawn', 5000);
      assert.ok(drawn.supported, 'CSS Custom Highlight API available');
      assert.deepEqual(drawn.drawn.map((x) => [x.text, x.severity]), [['mispelled', 'info']], 'only the LTeX diagnostic is shown');
      const res = await main.test({ action: 'diagFixes', index: 0, apply: 0 });
      assert.deepEqual(res.fixes, [{ title: "Use 'misspelled'", preferred: true }]);
      await until(() => mdoc.getText().includes('A misspelled word.'), 'quick fix applied');
      await until(async () => /A misspelled word\./.test(await main.test({ action: 'html' })), 'fix rendered');
    } finally {
      fix.dispose();
      coll.dispose();
    }
  });

  console.log('\nIntegration results:\n' + results.join('\n') + '\n');
  if (results.some((r) => r.includes('✗'))) throw new Error('integration checks failed');
};
