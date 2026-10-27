import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The test runner pipes stdout, so chalk would drop colour without this.
process.env.FORCE_COLOR = '1';
const {
  Hooks, HOOK_EVENTS, HOOK_NAMES, HOOK_SUMMARY,
  hookDetail, hookMeta, printHookCatalogue, traceHooks,
} = await import('../src/hooks.js');
const { runTask } = await import('../src/agent.js');
const { Workspace } = await import('../src/workspace.js');

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
/** Every line a `log` call produced, joined - the catalogue writes many. */
const capture = () => {
  const lines = [];
  const log = (line) => lines.push(String(line));
  return { lines, log, text: () => lines.join('\n') };
};

const quiet = { log: () => {} };
const final = (text) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const toolCall = (id, name, args) => ({
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      role: 'assistant',
      content: `calling ${name}`,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
  }],
});
const scripted = (replies) => {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)];
};
const tempWorkspace = () => new Workspace(fs.mkdtempSync(path.join(os.tmpdir(), 'mca-hooks-')));

/* ------------------------------------------------------------------ *
 * The catalogue: what a student reads on the projector
 * ------------------------------------------------------------------ */

test('every lifecycle hook is documented: icon, colour, when, what it gets, why', () => {
  assert.ok(HOOK_EVENTS.length >= 6, 'a lifecycle worth teaching has more than a couple of moments');
  const seen = new Set();
  for (const event of HOOK_EVENTS) {
    assert.match(event.name, /^[A-Z][A-Za-z]+$/, `${event.name} is not a hook name`);
    assert.equal(seen.has(event.name), false, `${event.name} is listed twice`);
    seen.add(event.name);
    assert.ok(event.icon && event.icon.length > 0, `${event.name} has no icon`);
    assert.match(event.when, /\w/, `${event.name} does not say when it fires`);
    assert.match(event.gets, /\w/, `${event.name} does not say what it receives`);
    assert.match(event.may, /\w/, `${event.name} does not say what it may do`);
    assert.ok(event.why.length > 40, `${event.name} has no real explanation`);
  }
  assert.deepEqual(HOOK_SUMMARY.names, HOOK_NAMES);
  assert.equal(hookMeta('PreToolUse').color, 'yellowBright');
  assert.equal(hookMeta('Nope'), undefined);
});

test('the catalogue prints every hook, with its icon, colour and description', () => {
  const { log, text } = capture();
  printHookCatalogue({ log });
  const out = text();
  const plain = strip(out);

  for (const event of HOOK_EVENTS) {
    assert.ok(plain.includes(event.name), `${event.name} missing from the catalogue`);
    assert.ok(plain.includes(event.icon), `${event.name}'s icon missing`);
    assert.ok(plain.includes(event.when), `${event.name}'s "when" missing`);
    assert.ok(plain.includes(event.may), `${event.name}'s "may" missing`);
    // The explanation is wrapped, so check a phrase from the middle of it too.
    assert.ok(plain.includes(event.why.split(' ').slice(0, 6).join(' ')), `${event.name}'s why is missing`);
  }

  // Colour is real, and it is per event: PreToolUse is the loud one.
  assert.ok(out.includes('\x1b[93m'), 'expected bright yellow for PreToolUse');
  assert.ok(out.includes('\x1b[36m'), 'expected cyan for the headings');
  // In firing order, and with the order line at the end.
  const positions = HOOK_EVENTS.map((e) => plain.indexOf(e.name));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'hooks are not in firing order');
  assert.ok(plain.includes('the order one run fires them'));
  assert.ok(plain.includes('SessionEnd'));
  assert.match(plain, /UserPromptSubmit \(rewrite or block the task\)/);
});

test('the catalogue marks which hooks are attached when given a registry', () => {
  const hooks = new Hooks();
  hooks.on('PreToolUse', () => {});
  const { log, text } = capture();
  printHookCatalogue({ log, hooks });
  const plain = strip(text());
  assert.ok(plain.includes('← attached'), 'an attached hook should be marked');
  assert.equal((plain.match(/← attached/g) ?? []).length, 1);
});

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

test('a typo in a hook name is an error, not a silent no-op', () => {
  const hooks = new Hooks();
  assert.throws(() => hooks.on('PreToolUse ', () => {}), /unknown hook/);
  assert.throws(() => hooks.on('SessionStart', 'not a function'), /needs a function/);
  assert.equal(hooks.has('SessionStart'), false);
  assert.equal(hooks.count('SessionStart'), 0);
});

test('handlers run in order, and the first block ends the event', async () => {
  const hooks = new Hooks();
  const order = [];
  hooks.on('PreToolUse', () => { order.push('first'); });
  hooks.on('PreToolUse', () => { order.push('second'); return { block: true, reason: 'not on my watch' }; });
  hooks.on('PreToolUse', () => { order.push('third'); });

  const outcome = await hooks.run('PreToolUse', { name: 'run_command' });
  assert.deepEqual(order, ['first', 'second'], 'a refusal does not need a second opinion');
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.reason, 'not on my watch');
  assert.equal(outcome.ran, 2);
});

test('a hook that throws is reported and ignored, never fatal', async () => {
  const { log, text } = capture();
  const hooks = new Hooks({ log });
  hooks.on('PostToolUse', () => { throw new Error('this hook is broken'); });
  hooks.on('PostToolUse', () => ({ replace: 'still here' }));

  const outcome = await hooks.run('PostToolUse', { name: 'x', result: 'y' });
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0], /this hook is broken/);
  assert.match(strip(text()), /hook PostToolUse .* threw: this hook is broken - ignored/);
  assert.equal(outcome.replace, 'still here', 'the loop keeps working after a bad hook');
});

test('a note is printed by the registry, and once-hooks detach themselves', async () => {
  const { text, log } = capture();
  const hooks = new Hooks({ log });
  hooks.on('SessionStart', () => ({ note: 'project rules loaded' }), { once: true });

  const first = await hooks.run('SessionStart', {});
  assert.deepEqual(first.notes, ['project rules loaded']);
  assert.match(strip(text()), /📝 SessionStart: project rules loaded/);
  assert.equal(hooks.has('SessionStart'), false, 'a once-hook runs a single time');

  const second = await hooks.run('SessionStart', {});
  assert.equal(second.ran, 0);
});

test('off() detaches by the id on() returned', async () => {
  const hooks = new Hooks();
  let called = 0;
  const id = hooks.on('Stop', () => { called += 1; }, { id: 'my-hook' });
  assert.equal(id, 'my-hook');
  assert.equal(hooks.off('Stop', 'my-hook'), true);
  assert.equal(hooks.off('Stop', 'my-hook'), false);
  await hooks.run('Stop', {});
  assert.equal(called, 0);
});

test('an unknown event cannot be fired either', async () => {
  await assert.rejects(() => new Hooks().run('PreToolUse2', {}), /unknown hook/);
});

test('the trace prints each event as [HOOK:Name] with what it is for', async () => {
  const { log, text } = capture();
  const hooks = traceHooks({ log });
  assert.equal(hooks.attached().length, HOOK_EVENTS.length);

  await hooks.run('PreToolUse', { name: 'run_command', args: '{"command":"ls"}' });
  await hooks.run('SessionEnd', { ok: false, reason: 'max_steps', durationMs: 12 });

  const plain = strip(text());
  // The tag a student greps for, plus the moment's one-liner and this firing's payload.
  assert.match(plain, /🛠️\s+\[HOOK:PreToolUse\] before every tool call - run_command \{"command":"ls"\}/);
  assert.match(plain, /🔒\s+\[HOOK:SessionEnd\] always - every run ends here, finished or not - failed \(max_steps\) in 12ms/);

  // Every moment can be traced without blowing up on a missing field.
  for (const event of HOOK_EVENTS) {
    await hooks.run(event.name, {
      step: 1, maxSteps: 3, messages: [], steps: 2, name: 'tool', result: 'line one\nline two',
    });
    assert.ok(strip(text()).includes(`[HOOK:${event.name}]`), `${event.name} has no [HOOK:...] tag`);
  }
});

test('traceHooks({ explain: false }) prints the tag and payload only', async () => {
  const { log, text } = capture();
  const hooks = traceHooks({ log, explain: false });
  await hooks.run('Stop', { answer: 'done', steps: 3 });
  const plain = strip(text());
  assert.match(plain, /\[HOOK:Stop\] - 3 step\(s\) - done/);
  assert.doesNotMatch(plain, /the model answered and the loop is ending/);
});

test('hookDetail gives every event something useful to print', () => {
  for (const name of HOOK_NAMES) {
    const detail = hookDetail(name, { step: 1, maxSteps: 3, messages: [], steps: 2, name: 't', result: 'r' });
    assert.equal(typeof detail, 'string');
    assert.ok(!/undefined/.test(detail), `${name} printed "undefined": ${detail}`);
  }
});

/* ------------------------------------------------------------------ *
 * The loop: hooks actually changing a run
 * ------------------------------------------------------------------ */

test('PreToolUse can block a tool call, and the model sees it as an observation', async () => {
  const workspace = tempWorkspace();
  const hooks = new Hooks(quiet);
  hooks.on('PreToolUse', ({ name, args }) => (
    name === 'run_command' && /git push/.test(args)
      ? { block: true, reason: 'no pushes from the sandbox' }
      : undefined
  ));

  const seen = [];
  const result = await runTask({
    task: 'push it',
    workspace,
    commandPolicy: 'allow',
    maxSteps: 4,
    hooks,
    log: quiet.log,
    chatFn: scripted([
      toolCall('p1', 'run_command', { command: 'git push origin main' }),
      final('the push was refused'),
    ]),
  });

  const observation = result.messages.find((m) => m.role === 'tool');
  assert.match(observation.content, /^DENIED: a PreToolUse hook blocked this call \(no pushes from the sandbox\)/);
  assert.equal(seen.length, 0);
  // The refusal is an observation like any other: the run still ends on an answer.
  assert.equal(result.ok, true);
});

test('PostToolUse can rewrite what the model reads back', async () => {
  const workspace = tempWorkspace();
  const hooks = new Hooks(quiet);
  hooks.on('PostToolUse', ({ result }) => ({ replace: String(result).replace(/sk-or-\S+/, 'sk-or-[redacted]') }));

  const result = await runTask({
    task: 'print the key',
    workspace,
    commandPolicy: 'allow',
    maxSteps: 4,
    hooks,
    log: quiet.log,
    chatFn: scripted([
      // The child process cannot see the key, so fake a leak instead: the hook
      // must rewrite whatever the tool returned, whatever it was.
      toolCall('r1', 'run_command', { command: 'node -e "console.log(\'sk-or-secretvalue\')"' }),
      final('done'),
    ]),
  });

  const observation = result.messages.find((m) => m.role === 'tool').content;
  assert.doesNotMatch(observation, /secretvalue/);
  assert.match(observation, /sk-or-\[redacted\]/);
});

test('UserPromptSubmit can rewrite the task before the model sees it', async () => {
  const workspace = tempWorkspace();
  const hooks = new Hooks(quiet);
  hooks.on('UserPromptSubmit', ({ task }) => ({ task: `${task} (and run the tests)` }));

  const sent = [];
  await runTask({
    task: 'write hello.js',
    workspace,
    commandPolicy: 'deny',
    maxSteps: 2,
    hooks,
    log: quiet.log,
    chatFn: async ({ messages }) => { sent.push(messages[1].content); return final('ok'); },
  });

  assert.deepEqual(sent, ['write hello.js (and run the tests)']);
});

test('SessionStart can refuse to start, and no request is made', async () => {
  const workspace = tempWorkspace();
  const hooks = new Hooks(quiet);
  hooks.on('SessionStart', () => ({ block: true, reason: 'no API key in this session' }));
  const events = [];
  for (const name of HOOK_NAMES) hooks.on(name, () => { events.push(name); }, { id: `see:${name}` });

  let calls = 0;
  const result = await runTask({
    task: 'anything',
    workspace,
    commandPolicy: 'deny',
    maxSteps: 2,
    hooks,
    log: quiet.log,
    chatFn: async () => { calls += 1; return final('nope'); },
  });

  assert.equal(calls, 0, 'the model was never called');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked_by_hook');
  // SessionEnd is the only event the watchers saw: the block ended SessionStart
  // early, so even a plain observer registered after it never ran (a refused
  // event does not need a second opinion), and the run closed at SessionEnd.
  assert.deepEqual(events, ['SessionEnd']);
});

test('a live run fires the whole lifecycle, and SessionEnd always last', async () => {
  const workspace = tempWorkspace();
  const events = [];
  const hooks = new Hooks(quiet);
  for (const name of HOOK_NAMES) {
    hooks.on(name, () => { events.push(name); }, { id: `watch:${name}` });
  }

  const result = await runTask({
    task: 'create a file',
    workspace,
    commandPolicy: 'allow',
    maxSteps: 4,
    hooks,
    log: quiet.log,
    chatFn: scripted([
      toolCall('c1', 'create_file', { path: 'a.js', content: 'console.log(1)' }),
      final('created a.js'),
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(events[0], 'SessionStart');
  assert.equal(events[1], 'UserPromptSubmit');
  assert.equal(events.at(-1), 'SessionEnd');
  assert.equal(events.at(-2), 'Stop');
  assert.deepEqual(
    events.filter((e) => !['PreModel', 'PostModel', 'PreToolUse', 'PostToolUse'].includes(e)),
    ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'],
  );
  assert.equal(fs.readFileSync(path.join(workspace.root, 'a.js'), 'utf8'), 'console.log(1)');
});

test('the step limit fires StepLimit, not Stop, before SessionEnd', async () => {
  const workspace = tempWorkspace();
  const events = [];
  const hooks = new Hooks(quiet);
  for (const name of HOOK_NAMES) hooks.on(name, () => { events.push(name); }, { id: `w:${name}` });

  const result = await runTask({
    task: 'loop forever',
    workspace,
    commandPolicy: 'deny',
    maxSteps: 2,
    hooks,
    log: quiet.log,
    chatFn: scripted([toolCall('x', 'list_files', { path: '.' })]),
  });

  assert.equal(result.reason, 'max_steps');
  assert.equal(events.includes('Stop'), false);
  assert.deepEqual(events.slice(-2), ['StepLimit', 'SessionEnd']);
});

test('a run with no hooks attached behaves exactly as before', async () => {
  const workspace = tempWorkspace();
  const result = await runTask({
    task: 'make a file',
    workspace,
    commandPolicy: 'allow',
    maxSteps: 3,
    log: quiet.log,
    chatFn: scripted([
      toolCall('n1', 'create_file', { path: 'b.js', content: 'x' }),
      final('done'),
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.answer, 'done');
  const observation = result.messages.find((m) => m.role === 'tool').content;
  assert.match(observation, /^created b\.js/);
});
