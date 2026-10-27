import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { runTool, safeEnv } from '../src/tools.js';

function ctx(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-tools-'));
  return { workspace: new Workspace(root), commandPolicy: 'allow', confirm: async () => 'allow', root, ...overrides };
}

test('create_file writes, and refuses to clobber', async () => {
  const c = ctx();
  const first = await runTool('create_file', { path: 'notes/a.txt', content: 'hi' }, c);
  assert.match(first, /^created notes\/a\.txt/);
  assert.equal(fs.readFileSync(path.join(c.root, 'notes', 'a.txt'), 'utf8'), 'hi');

  const second = await runTool('create_file', { path: 'notes/a.txt', content: 'again' }, c);
  assert.match(second, /^ERROR: notes\/a\.txt already exists/);
  assert.equal(fs.readFileSync(path.join(c.root, 'notes', 'a.txt'), 'utf8'), 'hi');
});

test('write_file overwrites', async () => {
  const c = ctx();
  await runTool('create_file', { path: 'x.txt', content: 'one' }, c);
  const out = await runTool('write_file', { path: 'x.txt', content: 'two' }, c);
  assert.match(out, /^overwrote x\.txt/);
  assert.equal(fs.readFileSync(path.join(c.root, 'x.txt'), 'utf8'), 'two');
});

test('edit_file fails loudly on a missing snippet and on ambiguity', async () => {
  const c = ctx();
  await runTool('create_file', { path: 'f.js', content: 'let a = 1;\nlet b = 1;\n' }, c);

  const missing = await runTool('edit_file', { path: 'f.js', old_string: 'let c = 3;', new_string: 'x' }, c);
  assert.match(missing, /^ERROR: old_string not found/);
  assert.equal(fs.readFileSync(path.join(c.root, 'f.js'), 'utf8'), 'let a = 1;\nlet b = 1;\n');

  const ambiguous = await runTool('edit_file', { path: 'f.js', old_string: '= 1;', new_string: '= 2;' }, c);
  assert.match(ambiguous, /appears 2 times/);

  const all = await runTool('edit_file', { path: 'f.js', old_string: '= 1;', new_string: '= 2;', replace_all: true }, c);
  assert.match(all, /2 replacement/);
  assert.equal(fs.readFileSync(path.join(c.root, 'f.js'), 'utf8'), 'let a = 2;\nlet b = 2;\n');

  const one = await runTool('edit_file', { path: 'f.js', old_string: 'let a = 2;', new_string: 'const a = 2;' }, c);
  assert.match(one, /first at line 1/);
});

test('edit_file treats $ replacement patterns literally', async () => {
  const c = ctx();
  await runTool('create_file', { path: 'tpl.txt', content: 'name: PLACEHOLDER' }, c);
  await runTool('edit_file', { path: 'tpl.txt', old_string: 'PLACEHOLDER', new_string: '$& $1' }, c);
  assert.equal(fs.readFileSync(path.join(c.root, 'tpl.txt'), 'utf8'), 'name: $& $1');
});

test('read_file numbers lines and reports the total', async () => {
  const c = ctx();
  await runTool('create_file', { path: 'r.txt', content: 'a\nb\nc' }, c);
  const out = await runTool('read_file', { path: 'r.txt' }, c);
  assert.match(out, /r\.txt \(3 lines\)/);
  assert.match(out, /1\| a/);
  assert.match(out, /3\| c/);

  const paged = await runTool('read_file', { path: 'r.txt', offset: 2, limit: 5 }, c);
  assert.match(paged, /2\| b/);
  assert.doesNotMatch(paged, /1\| a/);
});

test('list_files shows folders and files', async () => {
  const c = ctx();
  await runTool('create_file', { path: 'sub/one.txt', content: 'x' }, c);
  const out = await runTool('list_files', { path: '.' }, c);
  assert.match(out, /sub\//);
  assert.match(out, /sub\/one\.txt/);
});

test('run_command returns the exit code and both streams', async () => {
  const c = ctx();
  const good = await runTool('run_command', { command: 'node -e "console.log(42)"' }, c);
  assert.match(good, /^exit code 0/);
  assert.match(good, /42/);

  const bad = await runTool('run_command', { command: 'node -e "process.exit(7)"' }, c);
  assert.match(bad, /^exit code 7/);
});

test('run_command obeys the policy: deny, ask-denied, hard-blocked', async () => {
  const denied = ctx({ commandPolicy: 'deny' });
  assert.match(await runTool('run_command', { command: 'echo hi' }, denied), /^DENIED/);

  const asked = ctx({ commandPolicy: 'ask', confirm: async () => 'deny' });
  assert.match(await runTool('run_command', { command: 'echo hi' }, asked), /did not approve/);

  const allowed = ctx({ commandPolicy: 'ask', confirm: async () => 'allow' });
  assert.match(await runTool('run_command', { command: 'echo hi' }, allowed), /^exit code 0/);

  const blocked = ctx();
  assert.match(await runTool('run_command', { command: 'git push --force origin main' }, blocked), /^DENIED: blocked by policy/);
});

test('file tools cannot be talked out of the workspace', async () => {
  const c = ctx();
  assert.match(await runTool('write_file', { path: '../escape.txt', content: 'x' }, c), /^ERROR: path escapes the workspace/);
  assert.match(await runTool('read_file', { path: 'C:\\Windows\\win.ini' }, c), /^ERROR: absolute/);
  assert.ok(!fs.existsSync(path.join(c.root, '..', 'escape.txt')));
});

test('the child process gets an allow-list, not the harness environment', async () => {
  const c = ctx();
  process.env.SECRET_CANARY = 'leak-me';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-not-for-the-child';

  try {
    const out = await runTool('run_command', {
      command: 'node -e "console.log(\'CANARY=\' + (process.env.SECRET_CANARY ?? \'absent\') + \' KEY=\' + (process.env.OPENROUTER_API_KEY ?? \'absent\'))"',
    }, c);
    assert.match(out, /^exit code 0/);
    assert.match(out, /CANARY=absent/);
    assert.match(out, /KEY=absent/);
    assert.doesNotMatch(out, /leak-me|not-for-the-child/);

    // PATH survives, or nothing could run at all.
    const pathProbe = await runTool('run_command', {
      command: 'node -e "console.log(process.env.PATH ? \'PATH=present\' : \'PATH=absent\')"',
    }, c);
    assert.match(pathProbe, /PATH=present/);
  } finally {
    delete process.env.SECRET_CANARY;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('safeEnv keeps only the allow-listed names', () => {
  const env = safeEnv({ PATH: '/bin', OPENROUTER_API_KEY: 'nope', HOME: '/home/x', RANDOM_THING: '1' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/x' });
});

test('bad arguments come back as text, not crashes', async () => {
  const c = ctx();
  assert.match(await runTool('nope', {}, c), /unknown tool "nope"/);
  assert.match(await runTool('read_file', { path: 42 }, c), /"path" must be a string/);
  assert.match(await runTool('read_file', '{not json', c), /could not parse arguments/);
  assert.match(await runTool('read_file', { path: 'missing.txt' }, c), /^ERROR: no such file/);
});
