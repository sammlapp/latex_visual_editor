// Launches VS Code with the extension in development mode (isolated profile)
// and runs suite.cjs inside it.
import { runTests } from '@vscode/test-electron';
import { existsSync, mkdtempSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Set when this runs from inside VS Code's terminal; it would make the editor start as plain node.
delete process.env.ELECTRON_RUN_AS_NODE;
const root = path.resolve('.');
const installed = ['Code', 'Electron'].map((b) => `/Applications/Visual Studio Code.app/Contents/MacOS/${b}`).find(existsSync);
const workspace = mkdtempSync(path.join(tmpdir(), 'latex-visual-ws-'));
cpSync(path.join(root, 'sample'), workspace, { recursive: true });
const userData = mkdtempSync(path.join(tmpdir(), 'latex-visual-user-'));

await runTests({
  ...(installed ? { vscodeExecutablePath: installed } : {}),
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'test/integration/suite.cjs'),
  launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes'],
});
