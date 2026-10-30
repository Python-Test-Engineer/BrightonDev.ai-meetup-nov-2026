import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { Sandbox, shellWriteTargets } from '../src/sandbox.js';
import { runTool } from '../src/tools.js';

function tmpSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-shell-'));
  const lines = [];
  const sandbox = new Sandbox({ workspace: new Workspace(root), log: (line) => lines.push(String(line)) });
  return { sandbox, root, lines };
}

test('the write targets of a command line are found', () => {
  const cases = [
    ['copy a.txt C:\\Users\\me\\Desktop\\a.txt', [{ verb: 'copy', target: 'C:\\Users\\me\\Desktop\\a.txt' }]],
    ['cp -r src /tmp/out', [{ verb: 'cp', target: '/tmp/out' }]],
    ['echo hi > out.txt', [{ verb: 'redirect', target: 'out.txt' }]],
    ['node build.js 2> errors.log', [{ verb: 'redirect', target: 'errors.log' }]],
    ['type a.txt >> "C:\\Temp\\all files.txt"', [{ verb: 'redirect', target: 'C:\\Temp\\all files.txt' }]],
    ['del /q old.txt', [{ verb: 'del', target: 'old.txt' }]],
    ['robocopy src C:\\Backup /MIR', [{ verb: 'robocopy', target: 'C:\\Backup' }]],
    ['curl -o C:\\Temp\\x.zip https://example.com/x.zip', [{ verb: 'curl', target: 'C:\\Temp\\x.zip' }]],
    ['mkdir -p build/lib', [{ verb: 'mkdir', target: 'build/lib' }]],
    ['cd sub && copy a.txt b.txt', [{ verb: 'copy', target: 'b.txt' }]],
  ];

  for (const [command, expected] of cases) {
    assert.deepEqual(shellWriteTargets(command), expected, command);
  }
});

test('a command that writes inside the sandbox is allowed', () => {
  const { sandbox, root } = tmpSandbox();
  assert.deepEqual(sandbox.checkCommand('echo hi > notes.txt').targets, [{ verb: 'redirect', target: 'notes.txt' }]);
  assert.deepEqual(sandbox.checkCommand('copy a.txt b.txt').targets, [{ verb: 'copy', target: 'b.txt' }]);
  assert.equal(sandbox.refusals, 0);
  assert.ok(fs.existsSync(root));
});

test('a shell copy to the Desktop is refused before it runs', async () => {
  const { sandbox, root, lines } = tmpSandbox();
  const ctx = { workspace: sandbox.workspace, sandbox, commandPolicy: 'allow', confirm: async () => 'allow', log: () => {} };
  await runTool('write_file', { path: 'hello.txt', content: 'hi' }, ctx);

  const dest = path.join(os.tmpdir(), 'copied-outside.txt');
  const result = await runTool('run_command', { command: `copy hello.txt "${dest}"` }, ctx);

  assert.match(result, /^FORBIDDEN: COMMAND COPY /);
  assert.ok(!fs.existsSync(dest), 'nothing was copied out');
  assert.equal(lines.length, 1, 'one FORBIDDEN line for the refusal');
  assert.match(lines[0], /FORBIDDEN/);
});

test('a redirect outside the sandbox is refused too', async () => {
  const { sandbox } = tmpSandbox();
  assert.throws(() => sandbox.checkCommand('echo pwned > C:\\Windows\\Temp\\pwned.txt'), /COMMAND REDIRECT/);
  assert.throws(() => sandbox.checkCommand('del ..\\..\\keep.txt'), /COMMAND DEL/);
});

test('quoted arguments keep their spaces', () => {
  const [target] = shellWriteTargets('copy a.txt "C:\\Program Files\\my app\\a.txt"');
  assert.equal(target.target, 'C:\\Program Files\\my app\\a.txt');
});
