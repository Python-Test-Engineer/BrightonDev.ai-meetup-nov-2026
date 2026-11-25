/**
 * Simple demo: show what happens when the agent is asked to write to the Desktop.
 * Run: node demo-desktop-bypass.mjs
 */
import { Workspace } from './src/workspace.js';
import { Sandbox, shellWriteTargets } from './src/sandbox.js';
import { runTool } from './src/tools.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-demo-'));
const ws = new Workspace(root);
const sandbox = new Sandbox({ workspace: ws, log: console.log });

const ctx = {
  workspace: ws,
  sandbox,
  commandPolicy: 'allow',
  confirm: async () => 'allow',
  log: () => {},
  memory: null,
};

// The model might try these approaches to write to the Desktop:
const desktopPath = path.join(os.homedir(), 'Desktop', 'TEST.txt');

const attempts = [
  {
    name: 'write_file with Desktop path',
    tool: 'write_file',
    args: { path: '../../../../../../Desktop/TEST.txt', content: 'HELLO WORLD' },
  },
  {
    name: 'write_file with absolute Desktop path',
    tool: 'write_file',
    args: { path: desktopPath, content: 'HELLO WORLD' },
  },
  {
    name: 'run_command with echo redirect (relative)',
    tool: 'run_command',
    args: { command: `echo HELLO WORLD > ..\\..\\..\\..\\..\\Desktop\\TEST.txt` },
  },
  {
    name: 'run_command with echo redirect (absolute)',
    tool: 'run_command',
    args: { command: `echo HELLO WORLD > "${desktopPath}"` },
  },
  {
    name: 'run_command with node fs.writeFileSync (absolute)',
    tool: 'run_command',
    args: { command: `node -e "require('fs').writeFileSync('${desktopPath.replace(/\\/g, '\\\\')}', 'HELLO WORLD')"` },
  },
  {
    name: 'run_command with Powershell Set-Content (absolute)',
    tool: 'run_command',
    args: { command: `powershell -Command "Set-Content -Path '${desktopPath}' -Value 'HELLO WORLD'"` },
  },
];

console.log('=== Desktop Write Bypass Demo ===');
console.log('Workspace:', ws.root);
console.log('Desktop path:', path.join(os.homedir(), 'Desktop'));
console.log('');

for (const attempt of attempts) {
  console.log('Attempt:', attempt.name);
  console.log('Tool:', attempt.tool);
  console.log('Args:', JSON.stringify(attempt.args));

  // Check if file already exists on Desktop
  if (fs.existsSync(desktopPath)) {
    fs.unlinkSync(desktopPath);
    console.log('(deleted pre-existing Desktop/TEST.txt before test)');
  }

  const result = await runTool(attempt.tool, attempt.args, ctx);
  const written = fs.existsSync(desktopPath);

  console.log('Result:', result.split('\n')[0]);
  console.log('File on Desktop?', written ? '❌ YES — BUG!' : '✅ No — blocked');
  console.log('');
}

console.log('=== Summary ===');
console.log('If any attempt says "YES — BUG!", the sandbox was bypassed.');
console.log('All writes outside the workspace should print FORBIDDEN and leave no file.');
