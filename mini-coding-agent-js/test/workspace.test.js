import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace, PathError } from '../src/workspace.js';

function tmpWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-ws-'));
  return new Workspace(root);
}

test('resolves legitimate workspace paths', () => {
  const ws = tmpWorkspace();
  for (const p of ['hello.js', 'notes/ok.txt', 'a/b/c/deep.md', './x.txt']) {
    const { abs, rel } = ws.resolve(p);
    assert.ok(abs.startsWith(ws.root), `${p} should stay inside`);
    assert.ok(!rel.startsWith('..'));
  }
  assert.equal(ws.resolve('.').rel, '.');
});

test('refuses every escape shape', () => {
  const ws = tmpWorkspace();
  const blocked = [
    '../escape.txt',
    '..\\escape.txt',
    'a/../../escape.txt',
    'notes/../../../escape.txt',
    'C:\\Users\\me\\escape.txt',
    'C:escape.txt',
    '\\\\server\\share\\x.txt',
    '//server/share/x.txt',
    '/windows/x.txt',
    '~/Desktop/notes.txt',
    '%USERPROFILE%\\Desktop\\x',
    '$HOME/notes.txt',
    'Users/me/notes.txt',
    'Desktop/notes.txt',
    'Documents/plan.md',
    'appdata/local/x',
  ];
  for (const p of blocked) {
    assert.throws(() => ws.resolve(p), PathError, `should refuse: ${p}`);
  }
  assert.ok(!fs.existsSync(path.join(ws.root, '~')), 'no "~" folder created');
  assert.ok(!fs.existsSync(path.join(ws.root, 'Desktop')), 'no Desktop folder created');
});

test('a symlinked folder cannot smuggle a path outside the root', () => {
  const ws = tmpWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-out-'));
  try {
    fs.symlinkSync(outside, path.join(ws.root, 'link'), 'junction');
  } catch {
    return; // junctions need rights on some Windows setups; skip quietly
  }
  assert.throws(() => ws.resolve('link/leak.txt'), PathError);
});
