// Bundles the extension host code, the webview script and a node build of the
// LaTeX core (for unit tests), and copies KaTeX / pdf.js assets into dist/.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/media', { recursive: true });
cpSync('media', 'dist/media', { recursive: true });
mkdirSync('dist/media/katex', { recursive: true });
cpSync('node_modules/katex/dist/katex.min.css', 'dist/media/katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts', 'dist/media/katex/fonts', { recursive: true });
mkdirSync('dist/media/pdfjs', { recursive: true });
cpSync('node_modules/pdfjs-dist/build/pdf.min.js', 'dist/media/pdfjs/pdf.min.js');
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.js', 'dist/media/pdfjs/pdf.worker.min.js');

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18' },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' },
  { ...common, entryPoints: ['src/latex/index.ts'], outfile: 'dist/latex.cjs', platform: 'node', format: 'cjs', target: 'node18' },
];
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
