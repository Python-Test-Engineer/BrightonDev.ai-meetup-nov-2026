import test from 'node:test';
import assert from 'node:assert/strict';

// The test runner pipes stdout, so chalk would drop colour without this.
process.env.FORCE_COLOR = '1';
const { ui } = await import('../src/ui.js');

/** Everything on screen minus the escapes: what a human actually reads. */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('styles become ANSI codes but read back as the original text', () => {
  const out = ui.title('min-coding-agent');
  assert.match(out, /\x1b\[1m\x1b\[36m/); // bold + cyan
  assert.equal(strip(out), 'min-coding-agent');
});

test('text that looks like a colour tag is printed verbatim', () => {
  const out = ui.answer('wrap errors in <red> and reset with </red>');
  assert.doesNotMatch(out, /\x1b\[31m/);
  assert.equal(strip(out), 'wrap errors in <red> and reset with </red>');
});

test('backslashes in paths and JSON are untouched', () => {
  assert.equal(strip(ui.note('C:\\Users\\me\\workspace')), 'C:\\Users\\me\\workspace');
  assert.equal(strip(ui.tool('write_file', '{"content":"a\\nb"}')), 'tool → write_file {"content":"a\\nb"}');
});

test('a failed result is red, a clean one is not', () => {
  assert.match(ui.result('ERROR: no such file'), /\x1b\[31m/);
  assert.match(ui.result('DENIED: blocked by policy'), /\x1b\[31m/);
  assert.match(ui.result('exit code 1\nstderr: boom'), /\x1b\[31m/);
  assert.doesNotMatch(ui.result('exit code 0'), /\x1b\[31m/);
});

test('every helper returns a string, so an injected log still works', () => {
  for (const [name, fn] of Object.entries(ui)) {
    assert.equal(typeof fn, 'function', `${name} should be a function`);
    assert.equal(typeof fn('x', 'y'), 'string', `${name} should return a string`);
  }
});
