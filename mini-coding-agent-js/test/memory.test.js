import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory, parseMemory, formatEntry } from '../src/memory.js';
import { Workspace } from '../src/workspace.js';
import { runTool, TOOL_NAMES, TOOL_SCHEMAS } from '../src/tools.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mca-memory-'));
}

/** A Memory in a throwaway folder, with a frozen clock so dates are assertable. */
function memory(options = {}) {
  const root = options.root ?? tempRoot();
  return new Memory({ root, now: () => new Date('2026-10-28T10:00:00'), ...options });
}

test('a memory is written to memory.md and read back', () => {
  const m = memory();
  assert.equal(m.exists, false);
  assert.deepEqual(m.entries(), []);

  const saved = m.remember('The tests run with npm test, no network needed.', { tag: 'fact' });
  assert.equal(saved.ok, true);
  assert.equal(saved.total, 1);

  assert.equal(m.exists, true);
  const body = fs.readFileSync(m.file, 'utf8');
  assert.match(body, /^# memory/m);
  assert.match(body, /- \[fact\] The tests run with npm test, no network needed\. _\(2026-10-28\)_/);
  assert.deepEqual(m.entries(), [
    { tag: 'fact', text: 'The tests run with npm test, no network needed.', date: '2026-10-28' },
  ]);
});

test('memory survives a new process - that is the whole point', () => {
  const root = tempRoot();
  memory({ root }).remember('workspace paths are relative to the workspace root');

  // A second instance sees the same file, with no shared state in memory.
  const next = new Memory({ root });
  assert.equal(next.size, 1);
  assert.match(next.entries()[0].text, /relative to the workspace root/);
});

test('a duplicate is refreshed, not appended twice', () => {
  const root = tempRoot();
  const first = memory({ root });
  first.remember('The demo writes to workspace/demo/hello.js', { tag: 'fact' });

  const later = memory({ root, now: () => new Date('2026-11-02T09:00:00') });
  const again = later.remember('the demo writes to   workspace/demo/hello.js', { tag: 'gotcha' });

  assert.equal(again.duplicate, true);
  assert.equal(again.total, 1);
  assert.equal(later.entries().length, 1);
  assert.equal(later.entries()[0].date, '2026-11-02', 'the date is refreshed');
  assert.equal(later.entries()[0].tag, 'gotcha', 'the tag is refreshed');
});

test('the file is bounded: oldest entries are dropped at maxEntries', () => {
  const m = memory({ maxEntries: 3 });
  for (const n of [1, 2, 3, 4, 5]) m.remember(`memory number ${n}`);

  const kept = m.entries().map((e) => e.text);
  assert.deepEqual(kept, ['memory number 3', 'memory number 4', 'memory number 5']);

  const last = m.remember('memory number 6');
  assert.equal(last.dropped, 1);
  assert.equal(m.size, 3);
});

test('one long memory cannot dominate the file', () => {
  const m = memory({ maxEntryChars: 40 });
  const saved = m.remember('x'.repeat(500));
  assert.equal(saved.entry.text.length, 40);
});

test('an empty or whitespace-only note is refused, not stored', () => {
  const m = memory();
  const saved = m.remember('   \n  ');
  assert.equal(saved.ok, false);
  assert.match(saved.reason, /nothing to remember/);
  assert.equal(m.size, 0);
});

test('the digest is bounded, newest first, and says what it hid', () => {
  const m = memory({ promptEntries: 3, promptChars: 1000 });
  for (const n of [1, 2, 3, 4, 5]) m.remember(`memory number ${n}`);

  const digest = m.digest();
  assert.match(digest, /What you remember from earlier runs/);
  assert.match(digest, /memory number 5/);
  assert.match(digest, /memory number 3/);
  assert.doesNotMatch(digest, /memory number 2/);
  assert.match(digest, /2 older memories not shown/);
  assert.match(digest, /recall/);

  // The character budget is a real ceiling, not a suggestion.
  const small = memory({ promptEntries: 50, promptChars: 120 });
  for (const n of [1, 2, 3, 4, 5]) small.remember(`a memory that is long enough to fill the budget ${n}`);
  const lines = small.digest().split('\n').filter((line) => line.startsWith('- ['));
  assert.ok(lines.length < 5, 'the budget cut the list short');
});

test('an empty digest is empty - no header, no noise', () => {
  assert.equal(memory().digest(), '');
  const m = memory({ promptChars: 0 });
  m.remember('injection is disabled here');
  assert.equal(m.digest(), '', 'MEMORY_PROMPT_CHARS=0 means no block, not an empty heading');
  assert.equal(m.size, 1, 'the memory is still stored for recall');
});

test('search is AND, newest first, and searches the whole file', () => {
  const m = memory();
  m.remember('node 20 is the minimum version');
  m.remember('the node demo script lives in demo/hello.js', { tag: 'fact' });
  m.remember('python is not used in this package', { tag: 'gotcha' });

  const node = m.search('node');
  assert.equal(node.length, 2);
  assert.match(node[0].text, /demo script/, 'newest first');

  const narrow = m.search('node version');
  assert.equal(narrow.length, 1);
  assert.match(narrow[0].text, /minimum version/);

  assert.equal(m.search('kubernetes').length, 0);
  assert.equal(m.search('').length, 3, 'an empty query lists the store');
  assert.equal(m.search('', { limit: 1 }).length, 1);
});

test('forget removes matching entries and leaves the rest alone', () => {
  const m = memory();
  m.remember('the deploy step needs a key');
  m.remember('the tests are offline');
  const { removed, total } = m.forget('deploy');
  assert.equal(removed, 1);
  assert.equal(total, 1);
  assert.equal(m.entries()[0].text, 'the tests are offline');
});

test('memory.md is markdown: prose and hand-written bullets are both fine', () => {
  const parsed = parseMemory([
    '# memory',
    '',
    'Some prose that is not a memory.',
    '- [fact] a dated one _(2025-01-02)_',
    '- [pref] an undated one',
    '* [gotcha] a star bullet works too _(2025-03-04)_',
    '- [fix]   extra   whitespace is collapsed _(2025-05-06)_',
    '- not a tagged bullet, so ignored',
  ].join('\n'));

  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], { tag: 'fact', text: 'a dated one', date: '2025-01-02' });
  assert.deepEqual(parsed[1], { tag: 'pref', text: 'an undated one', date: 'undated' });
  assert.deepEqual(parsed[2], { tag: 'gotcha', text: 'a star bullet works too', date: '2025-03-04' });
  assert.equal(parsed[3].text, 'extra whitespace is collapsed');
});

test('a hand edit is picked up immediately - the file is the store, not a cache', () => {
  const m = memory();
  m.remember('first');
  fs.writeFileSync(m.file, fs.readFileSync(m.file, 'utf8') + '- [fact] added by hand _(2026-01-01)_\n');

  assert.equal(m.size, 2);
  assert.ok(m.entries().some((e) => e.text === 'added by hand'));
});

test('the path label is relative to the root, and an absolute file is honoured', () => {
  const root = tempRoot();
  assert.equal(memory({ root }).label, 'src/memory.md');
  assert.equal(memory({ root, file: 'notes/mem.md' }).label, 'notes/mem.md');

  const outside = path.join(tempRoot(), 'shared-memory.md');
  const shared = memory({ root, file: outside });
  shared.remember('a shared store outside the workspace');
  assert.ok(fs.existsSync(outside));
});

/* ---- the two tools ------------------------------------------------- */

test('remember and recall are tools the model can call', async () => {
  assert.ok(TOOL_NAMES.includes('remember'));
  assert.ok(TOOL_NAMES.includes('recall'));
  assert.ok(TOOL_SCHEMAS.some((t) => t.function.name === 'remember' && t.function.parameters.required.includes('text')));

  const root = tempRoot();
  const ctx = {
    workspace: new Workspace(root),
    memory: memory({ root }),
    commandPolicy: 'allow',
    confirm: async () => 'allow',
  };

  const saved = await runTool('remember', { text: 'the sandbox demo lives in demo/hello.js', tag: 'fact' }, ctx);
  assert.match(saved, /^remembered in src\/memory\.md \(1 total\): - \[fact\] the sandbox demo lives/);

  const twice = await runTool('remember', { text: 'the sandbox demo lives in demo/hello.js' }, ctx);
  assert.match(twice, /^already remembered/);
  assert.equal(ctx.memory.size, 1);

  const hit = await runTool('recall', { query: 'demo' }, ctx);
  assert.match(hit, /^1 of 1 memories in src\/memory\.md/);
  assert.match(hit, /demo\/hello\.js/);

  const miss = await runTool('recall', { query: 'kubernetes' }, ctx);
  assert.match(miss, /no memories .* match "kubernetes" \(1 stored\)/);
});

test('with no memory store, the tools say so instead of throwing', async () => {
  const ctx = {
    workspace: new Workspace(tempRoot()),
    commandPolicy: 'allow',
    confirm: async () => 'allow',
  };
  assert.match(await runTool('remember', { text: 'x' }, ctx), /^ERROR: no memory store/);
  assert.match(await runTool('recall', { query: 'x' }, ctx), /^ERROR: no memory store/);
});

test('formatEntry round-trips through the parser', () => {
  const entry = { tag: 'pref', text: 'keep it plain', date: '2026-10-28' };
  assert.deepEqual(parseMemory(formatEntry(entry)), [entry]);
});
