import test from 'node:test';
import assert from 'node:assert/strict';

// The test runner pipes stdout, so chalk would drop colour without this.
process.env.FORCE_COLOR = '1';
const { ui, explainExit } = await import('../src/ui.js');

/** Everything on screen minus the escapes: what a human actually reads. */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('styles become ANSI codes but read back as the original text', () => {
  const out = ui.title('min-coding-js');
  assert.match(out, /\x1b\[1m\x1b\[36m/); // bold + cyan
  assert.equal(strip(out), 'min-coding-js');
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

test('exit code 1 comes with a description, not just a number', () => {
  const failed = strip(ui.result('exit code 1\nstderr: boom'));
  assert.match(failed, /result ← exit code 1\n\s+↳ exit 1: general failure/);
  assert.match(strip(ui.result('exit code 127')), /command not found/);
  assert.match(strip(ui.result('exit code 9009')), /Windows cmd/);
  assert.equal(explainExit(42), 'non-zero exit - the command reported failure; stdout and stderr above say why');
  assert.match(explainExit(137), /SIGKILL/);
});

test('a successful command shows the first line it printed', () => {
  const out = strip(ui.result('exit code 0\nstdout:\nhello there\nsecond line'));
  assert.match(out, /result ← exit code 0\n\s+↳ stdout: hello there/);
  assert.equal(strip(ui.result('exit code 0')), 'result ← exit code 0');
  // A file tool result is not a command, so it gets no stdout line.
  assert.equal(strip(ui.result('created demo/hello.js (64 bytes)')), 'result ← created demo/hello.js (64 bytes)');
});

test('every helper returns a string, so an injected log still works', () => {
  for (const [name, fn] of Object.entries(ui)) {
    assert.equal(typeof fn, 'function', `${name} should be a function`);
    assert.equal(typeof fn('x', 'y'), 'string', `${name} should return a string`);
  }
});
