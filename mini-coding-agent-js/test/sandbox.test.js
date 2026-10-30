import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { Workspace } from '../src/workspace.js';
import { Sandbox, ACTIONS, ForbiddenError, SANDBOX_DIR } from '../src/sandbox.js';
import { runTool } from '../src/tools.js';

/** A sandbox in a temp dir, with every console line captured for assertions. */
function tmpSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-sandbox-'));
  const lines = [];
  const sandbox = new Sandbox({ workspace: new Workspace(root), log: (line) => lines.push(String(line)) });
  return { sandbox, root, lines, outside: fs.mkdtempSync(path.join(os.tmpdir(), 'mca-outside-')) };
}

/** Strip colour so the assertions do not depend on a TTY. */
const plain = (text) => chalk.level > 0 ? String(text) : String(text);

test('the default sandbox is the workspace folder next to the code', () => {
  const sandbox = new Sandbox({ log: () => {} });
  assert.equal(sandbox.root, fs.realpathSync(SANDBOX_DIR));
  assert.match(sandbox.summary(), /^save, edit, delete - only inside /);
  assert.ok(Sandbox.allowsAction(ACTIONS.DELETE));
  assert.equal(Sandbox.allowsAction('read'), false);
});

test('save, edit and delete work inside the sandbox', () => {
  const { sandbox, root } = tmpSandbox();

  const saved = sandbox.save('notes/a.txt', 'hello');
  assert.equal(saved.rel, 'notes/a.txt');
  assert.equal(saved.bytes, 5);
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'a.txt'), 'utf8'), 'hello');

  const again = sandbox.save('notes/a.txt', 'hello again');
  assert.equal(again.existed, true);

  const removed = sandbox.remove('notes/a.txt');
  assert.equal(removed.dir, false);
  assert.ok(!fs.existsSync(path.join(root, 'notes', 'a.txt')));
});

test('a refused write prints one FORBIDDEN line and touches nothing', () => {
  const { sandbox, outside, lines } = tmpSandbox();
  const target = path.join(outside, 'pwned.txt');

  assert.throws(() => sandbox.save(target, 'nope'), ForbiddenError);
  assert.ok(!fs.existsSync(target), 'nothing was written outside the sandbox');

  assert.equal(lines.length, 1, 'exactly one console line per refusal');
  const line = plain(lines[0]);
  assert.match(line, /FORBIDDEN/);
  assert.match(line, /SAVE/);
  assert.match(line, /pwned\.txt/);
  assert.match(line, /outside the workspace|escapes the workspace/);
  assert.equal(sandbox.refusals, 1);
});

test('FORBIDDEN is printed in bold red capitals when colour is on', () => {
  const { sandbox } = tmpSandbox();
  const paint = chalk.level;
  try {
    chalk.level = 1;
    const [line] = (() => {
      const seen = [];
      sandbox.log = (text) => seen.push(text);
      try { sandbox.save('../escape.txt', 'x'); } catch { /* expected */ }
      return seen;
    })();
    assert.match(line, /\u001b\[1m\u001b\[31mFORBIDDEN\u001b\[39m/, 'bold + red FORBIDDEN');
  } finally {
    chalk.level = paint;
  }
});

test('every escape shape is refused for all three actions', () => {
  const { sandbox } = tmpSandbox();
  const shapes = ['../escape.txt', '..\\escape.txt', 'C:\\Windows\\evil.txt', '~/Desktop/x.txt',
    '%USERPROFILE%\\x.txt', '\\\\server\\share\\x.txt', '/windows/x.txt', 'Desktop/x.txt'];

  for (const action of [ACTIONS.SAVE, ACTIONS.EDIT, ACTIONS.DELETE]) {
    for (const requested of shapes) {
      assert.throws(() => sandbox.check(action, requested), ForbiddenError, `${action} ${requested}`);
    }
  }
  assert.equal(sandbox.refusals, shapes.length * 3);
});

test('deleting the sandbox root itself is refused', () => {
  const { sandbox } = tmpSandbox();
  assert.throws(() => sandbox.remove('.'), ForbiddenError);
  assert.ok(fs.existsSync(sandbox.root));
});

test('deleting a file outside the sandbox is refused, and the file survives', () => {
  const { sandbox, outside } = tmpSandbox();
  const keep = path.join(outside, 'keep.txt');
  fs.writeFileSync(keep, 'still here', 'utf8');

  assert.throws(() => sandbox.remove(keep), ForbiddenError);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'still here');
});

test('an unknown action is a programming error, not a refusal', () => {
  const { sandbox } = tmpSandbox();
  assert.throws(() => sandbox.check('read', 'x.txt'), TypeError);
});

test('the tool layer turns a refusal into a FORBIDDEN observation', async () => {
  const { sandbox, root, lines } = tmpSandbox();
  const ctx = { workspace: sandbox.workspace, sandbox, log: () => {} };

  const result = await runTool('write_file', { path: '../escape.txt', content: 'x' }, ctx);
  assert.match(result, /^FORBIDDEN: SAVE \.\.\/escape\.txt/);
  assert.ok(!fs.existsSync(path.join(root, '..', 'escape.txt')));

  const ok = await runTool('write_file', { path: 'fine.txt', content: 'x' }, ctx);
  assert.match(ok, /^created fine\.txt/);
  assert.equal(lines.length, 1, 'only the refusal printed');
});
