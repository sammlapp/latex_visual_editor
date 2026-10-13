import * as path from 'path';
import * as vscode from 'vscode';

const VIEW_TYPE = 'latexVisual.editor';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);
const UNSUPPORTED_EXTS = new Set(['.eps', '.ps', '.tif', '.tiff']);
/** Search order when \includegraphics omits the extension (pdflatex order, plus a few). */
const GRAPHIC_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.eps', '.ps'];

interface ImageInfo {
  uri?: string;
  kind: 'image' | 'pdf' | 'unsupported' | 'missing';
  resolved?: string;
}

interface HostResources {
  images: Record<string, ImageInfo>;
  bib: string;
}

interface PendingEdit {
  offset: number;
  removed: number;
  text: string;
}

export interface RenderStats {
  ms: number;
  kinds: Record<string, number>;
  katexErrors: number;
  renderErrors: number;
  undefinedRefs: number;
  undefinedCites: number;
  images: number;
  textLength: number;
}

class EditorSession {
  private pending: PendingEdit[] = [];
  private resourceKey = '';
  private resources: HostResources = { images: {}, bib: '' };
  private disposables: vscode.Disposable[] = [];
  private testWaiters = new Map<number, (data: unknown) => void>();
  private nextTestId = 1;
  lastStats?: RenderStats;
  errors: string[] = [];
  private renderWaiters: (() => void)[] = [];

  constructor(
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly provider: LatexVisualEditorProvider,
  ) {
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const roots = [
      vscode.Uri.joinPath(provider.context.extensionUri, 'dist'),
      docDir,
      vscode.Uri.joinPath(docDir, '..'),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = this.html();

    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length) this.onDocChange(e);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() !== document.uri.toString() || !panel.visible) return;
        if (e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
        this.post({ type: 'cursor', offset: document.offsetAt(e.selections[0].active) });
      }),
    );
    // Re-read images and .bib files when they change on disk.
    if (document.uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(docDir, '**/*.{bib,png,jpg,jpeg,gif,svg,pdf,eps}'));
      const refresh = () => {
        this.resourceKey = '';
        void this.sendUpdate(true, []);
      };
      watcher.onDidChange(refresh);
      watcher.onDidCreate(refresh);
      watcher.onDidDelete(refresh);
      this.disposables.push(watcher);
    }
    panel.onDidDispose(() => this.dispose());
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.provider.sessions.delete(this);
  }

  post(msg: unknown) {
    return this.panel.webview.postMessage(msg);
  }

  /** Sends a test command to the webview and resolves with its reply. */
  test(msg: Record<string, unknown>): Promise<any> {
    const id = this.nextTestId++;
    return new Promise((resolve) => {
      this.testWaiters.set(id, resolve);
      void this.post({ type: '__test', id, ...msg });
    });
  }

  /** Resolves after the next full render in the webview. */
  waitForRender(): Promise<void> {
    return new Promise((r) => this.renderWaiters.push(r));
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent) {
    const head = this.pending[0];
    const c = e.contentChanges[0];
    const fromWebview = !!head && e.contentChanges.length === 1 && c.rangeOffset === head.offset && c.rangeLength === head.removed && c.text === head.text;
    if (fromWebview) this.pending.shift();
    const changes = e.contentChanges.map((ch) => ({ offset: ch.rangeOffset, removed: ch.rangeLength, inserted: ch.text.length }));
    void this.sendUpdate(!fromWebview, changes);
  }

  private async sendUpdate(external: boolean, changes: { offset: number; removed: number; inserted: number }[]) {
    const text = this.document.getText();
    const host = await this.collectResources(text);
    // The document may have changed while resources were being resolved; the
    // next change event will send a fresh update.
    void this.post({ type: 'update', text: this.document.getText(), host, external, changes });
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready':
        await this.sendUpdate(true, []);
        break;
      case 'edit':
        await this.applyEdit(m.start, m.end, m.text);
        break;
      case 'reveal': {
        const range = new vscode.Range(this.document.positionAt(m.start), this.document.positionAt(m.end));
        const existing = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === this.document.uri.toString());
        const editor = await vscode.window.showTextDocument(this.document, {
          viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside,
          preserveFocus: false,
          selection: range,
        });
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        break;
      }
      case 'openExternal':
        if (typeof m.url === 'string' && /^(https?|mailto):/i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case 'openFile': {
        const base = vscode.Uri.joinPath(this.document.uri, '..');
        const file: string = m.file;
        for (const cand of [file, `${file}.tex`]) {
          const uri = vscode.Uri.joinPath(base, cand);
          if (await exists(uri)) {
            await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
            return;
          }
        }
        void vscode.window.showWarningMessage(`Could not find ${file}`);
        break;
      }
      case 'pickImage':
        await this.pickImage(m.at);
        break;
      case 'rendered':
        this.lastStats = m.stats;
        this.renderWaiters.splice(0).forEach((r) => r());
        break;
      case 'error':
        this.errors.push(m.message);
        this.provider.log(`[webview] ${m.message}`);
        break;
      case '__testResult': {
        const w = this.testWaiters.get(m.id);
        this.testWaiters.delete(m.id);
        w?.(m.data);
        break;
      }
    }
  }

  private async applyEdit(start: number, end: number, text: string) {
    const doc = this.document;
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    // Line endings: the webview works with the text as given by getText().
    this.pending.push({ offset: doc.offsetAt(range.start), removed: doc.offsetAt(range.end) - doc.offsetAt(range.start), text });
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      this.pending = [];
      this.provider.log('Failed to apply edit from visual editor');
      await this.sendUpdate(true, []);
    }
  }

  private async pickImage(at: number) {
    const docDir = vscode.Uri.joinPath(this.document.uri, '..');
    const picked = await vscode.window.showOpenDialog({
      defaultUri: docDir,
      canSelectMany: false,
      openLabel: 'Insert figure',
      filters: { Images: ['png', 'jpg', 'jpeg', 'pdf', 'svg', 'gif', 'eps'] },
    });
    if (!picked?.length) return;
    let rel = path.relative(docDir.fsPath, picked[0].fsPath).split(path.sep).join('/');
    if (rel.startsWith('..') && !rel.startsWith('../')) rel = picked[0].fsPath;
    const name = path.basename(rel, path.extname(rel)).replace(/[^A-Za-z0-9]+/g, '-');
    const tpl = `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.7\\linewidth]{${rel}}\n  \\caption{Caption for ${name}.}\n  \\label{fig:${name}}\n\\end{figure}`;
    // The webview owns insertion so its optimistic copy of the text stays in sync.
    void this.post({ type: 'insertTemplate', at, text: tpl });
  }

  /** Resolves \includegraphics paths and reads .bib files referenced by the document. */
  private async collectResources(text: string): Promise<HostResources> {
    const graphics = new Set<string>();
    for (const m of text.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) graphics.add(m[1].trim());
    const gpaths: string[] = [''];
    const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})*)\s*\}/.exec(text);
    if (gp) for (const m of gp[1].matchAll(/\{([^}]*)\}/g)) gpaths.push(m[1]);
    const bibs: string[] = [];
    for (const m of text.matchAll(/^[^%\n]*\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/gm)) {
      for (const b of m[1].split(',')) if (b.trim()) bibs.push(b.trim().endsWith('.bib') ? b.trim() : `${b.trim()}.bib`);
    }
    const key = JSON.stringify([[...graphics], gpaths, bibs]);
    if (key === this.resourceKey) return this.resources;

    const docDir = vscode.Uri.joinPath(this.document.uri, '..');
    const images: Record<string, ImageInfo> = {};
    await Promise.all(
      [...graphics].map(async (g) => {
        images[g] = await this.resolveGraphic(g, docDir, gpaths);
      }),
    );
    let bib = '';
    for (const b of bibs) {
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(docDir, b));
        bib += new TextDecoder().decode(data) + '\n';
      } catch {
        this.provider.log(`Bibliography file not found: ${b}`);
      }
    }
    this.resourceKey = key;
    this.resources = { images, bib };
    return this.resources;
  }

  private async resolveGraphic(g: string, docDir: vscode.Uri, gpaths: string[]): Promise<ImageInfo> {
    const hasExt = path.extname(g) !== '' && [...GRAPHIC_EXTS, ...IMAGE_EXTS, ...UNSUPPORTED_EXTS].includes(path.extname(g).toLowerCase());
    const exts = hasExt ? [''] : GRAPHIC_EXTS;
    for (const dir of gpaths) {
      for (const ext of exts) {
        const rel = `${dir}${g}${ext}`;
        const uri = path.isAbsolute(rel) ? vscode.Uri.file(rel) : vscode.Uri.joinPath(docDir, rel);
        let stat: vscode.FileStat;
        try {
          stat = await vscode.workspace.fs.stat(uri);
        } catch {
          continue;
        }
        const e = path.extname(uri.path).toLowerCase();
        const kind: ImageInfo['kind'] = e === '.pdf' ? 'pdf' : IMAGE_EXTS.has(e) ? 'image' : 'unsupported';
        const webUri = this.panel.webview.asWebviewUri(uri).toString();
        return { kind, uri: `${webUri}${webUri.includes('?') ? '&' : '?'}v=${stat.mtime}`, resolved: rel };
      }
    }
    return { kind: 'missing' };
  }

  private html(): string {
    const w = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.provider.context.extensionUri, 'dist');
    const asset = (p: string) => w.asWebviewUri(vscode.Uri.joinPath(dist, p)).toString();
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} data: blob: https:`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `font-src ${w.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
      `worker-src blob:`,
      `connect-src ${w.cspSource}`,
    ].join('; ');
    const paper = vscode.workspace.getConfiguration('latexVisual').get<string>('pageStyle') === 'paper';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('media/katex/katex.min.css')}">
<link rel="stylesheet" href="${asset('media/style.css')}">
<title>LaTeX Visual Editor</title>
</head>
<body data-pdf-worker="${asset('media/pdfjs/pdf.worker.min.js')}" data-paper="${paper}">
<script nonce="${nonce}" src="${asset('media/pdfjs/pdf.min.js')}"></script>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export class LatexVisualEditorProvider implements vscode.CustomTextEditorProvider {
  readonly sessions = new Set<EditorSession>();
  private output = vscode.window.createOutputChannel('LaTeX Visual Editor');

  constructor(readonly context: vscode.ExtensionContext) {}

  log(msg: string) {
    this.output.appendLine(msg);
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    this.sessions.add(new EditorSession(document, panel, this));
  }

  sessionFor(uri: vscode.Uri): EditorSession | undefined {
    return [...this.sessions].find((s) => s.document.uri.toString() === uri.toString());
  }

  activeSession(): EditorSession | undefined {
    return [...this.sessions].find((s) => s.panel.active) ?? [...this.sessions][0];
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new LatexVisualEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('latexVisual.open', (uri?: vscode.Uri) => openVisual(uri, false)),
    vscode.commands.registerCommand('latexVisual.openToSide', (uri?: vscode.Uri) => openVisual(uri, true)),
    vscode.commands.registerCommand('latexVisual.showSource', async () => {
      const s = provider.activeSession();
      if (s) await vscode.window.showTextDocument(s.document, vscode.ViewColumn.Beside);
    }),
  );
  return { provider };
}

async function openVisual(uri: vscode.Uri | undefined, toSide: boolean) {
  uri ??= vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    void vscode.window.showInformationMessage('Open a .tex file first.');
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, toSide ? vscode.ViewColumn.Beside : undefined);
}

export function deactivate() {}
