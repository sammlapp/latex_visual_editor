// Builds a standalone page that runs the real webview bundle with a mocked
// VS Code API, for visual testing in a browser. Serve the repo root over HTTP
// and open /test/harness/index.html.
import { readFileSync, writeFileSync } from 'fs';
const text = readFileSync('sample/paper.tex', 'utf8');
const bib = readFileSync('sample/refs.bib', 'utf8');
const host = {
  bib,
  images: {
    signal: { kind: 'pdf', uri: '/sample/figures/signal.pdf' },
    'spectrum.png': { kind: 'image', uri: '/sample/figures/spectrum.png' },
    'missing-figure': { kind: 'missing' },
  },
};
const paper = process.argv.includes('--paper');
writeFileSync('test/harness/index.html', `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/media/katex/katex.min.css"><link rel="stylesheet" href="/dist/media/style.css">
<script>
window.__sent = [];
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    window.__sent.push(m);
    if (m.type === 'ready') setTimeout(() => window.postMessage({ type: 'update', text: ${JSON.stringify(text)}, host: ${JSON.stringify(host)}, external: true, changes: [] }, '*'));
    if (m.type === 'error') console.error('WEBVIEW ERROR', m.message);
  },
  getState() { return null; }, setState() {},
});
</script></head>
<body data-pdf-worker="/dist/media/pdfjs/pdf.worker.min.js" data-paper="${paper}">
<script src="/dist/media/pdfjs/pdf.min.js"></script><script src="/dist/webview.js"></script>
${process.argv.includes('--edit') ? `<script>setTimeout(()=>{document.querySelectorAll('.blk-math')[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));},800)</script>` : ''}
</body></html>`);
