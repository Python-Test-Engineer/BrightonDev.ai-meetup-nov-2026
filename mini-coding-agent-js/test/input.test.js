import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { askTask } from '../src/cli.js';

/** A stand-in terminal: write lines into it, read what was printed back. */
function pipe() {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => { printed += chunk.toString(); });
  return { input, output, printed: () => printed };
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('the input field returns the task, trimmed', async () => {
  const tty = pipe();
  const pending = askTask({ input: tty.input, output: tty.output });
  tty.input.write('  create hello.js and run it  \n');
  assert.equal(await pending, 'create hello.js and run it');
});

test('a blank line re-asks instead of starting an empty run', async () => {
  const tty = pipe();
  const pending = askTask({ input: tty.input, output: tty.output });
  tty.input.write('\n');
  tty.input.write('list the files\n');
  assert.equal(await pending, 'list the files');
  assert.match(strip(tty.printed()), /nothing entered/);
});

test('a closed input stops the field with null, so the caller can say why in red', async () => {
  const tty = pipe();
  const pending = askTask({ input: tty.input, output: tty.output });
  tty.input.end();
  assert.equal(await pending, null);
});
