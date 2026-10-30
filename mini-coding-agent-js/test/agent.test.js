import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTask } from '../src/agent.js';
import { sandboxScorecard, DEMO_SCRIPT } from '../src/demo.js';
import { Workspace } from '../src/workspace.js';

const quiet = () => {};

function scripted(replies) {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)];
}

const toolCall = (id, name, args) => ({
  choices: [{
    finish_reason: 'tool_calls',
    message: { role: 'assistant', content: `calling ${name}`, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  }],
});
const final = (text) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

test('the loop runs tools then stops on a plain answer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-agent-'));
  const workspace = new Workspace(root);

  const chatFn = scripted([
    toolCall('t1', 'create_file', { path: 'app.js', content: 'console.log("hi")' }),
    toolCall('t2', 'run_command', { command: 'node app.js' }),
    final('created app.js and ran it'),
  ]);

  const result = await runTask({ task: 'make a script', workspace, commandPolicy: 'allow', maxSteps: 6, chatFn, log: quiet });

  assert.equal(result.ok, true);
  assert.equal(result.answer, 'created app.js and ran it');
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'console.log("hi")');

  const toolMessages = result.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['t1', 't2']);
  assert.match(toolMessages[1].content, /exit code 0/);
  assert.match(toolMessages[1].content, /hi/);

  // The assistant turns we send back must not carry stray provider fields.
  const allowed = new Set(['content', 'role', 'tool_calls']);
  for (const m of result.messages.filter((x) => x.role === 'assistant')) {
    for (const key of Object.keys(m)) assert.ok(allowed.has(key), `unexpected field ${key} in assistant message`);
  }
});

test('a failing tool result is fed back so the model can correct itself', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-agent-'));
  const workspace = new Workspace(root);

  const chatFn = scripted([
    toolCall('e1', 'edit_file', { path: 'missing.js', old_string: 'a', new_string: 'b' }),
    final('nothing to edit'),
  ]);
  const result = await runTask({ task: 'edit', workspace, commandPolicy: 'deny', maxSteps: 4, chatFn, log: quiet });

  assert.equal(result.ok, true);
  const toolMsg = result.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /^ERROR: no such file/);
});

test('the loop is capped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-agent-'));
  const workspace = new Workspace(root);
  const chatFn = scripted([toolCall('x', 'list_files', { path: '.' })]);

  const result = await runTask({ task: 'loop forever', workspace, commandPolicy: 'deny', maxSteps: 3, chatFn, log: quiet });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_steps');
});

test('a truncated reply is not dispatched as a tool call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-agent-'));
  const workspace = new Workspace(root);
  const chatFn = scripted([
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'I was writing a huge fil' } }] },
    final('ok'),
  ]);
  const result = await runTask({ task: 'x', workspace, commandPolicy: 'deny', maxSteps: 4, chatFn, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(result.messages.filter((m) => m.role === 'tool').length, 0);
});

test('a slow model call says it is still working instead of looking hung', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-agent-'));
  const workspace = new Workspace(root);
  const lines = [];
  const slow = async () => {
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    return final('done');
  };

  const result = await runTask({
    task: 'think about it', workspace, commandPolicy: 'deny', maxSteps: 2,
    chatFn: slow, log: (line) => lines.push(String(line)), heartbeatMs: 25,
  });

  assert.equal(result.ok, true);
  assert.ok(
    lines.some((line) => /still waiting for the model \(\d+s\)/.test(line)),
    `expected a heartbeat line, got: ${lines.join(' | ')}`,
  );
});

test('the scripted demo tries every sandbox guard, and every guard holds', async () => {
  // The workspace lives one level down, so the demo's "../package.json" read has
  // a real sibling file to find without touching the package itself.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-demo-'));
  const root = path.join(base, 'workspace');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(base, 'package.json'), '{ "name": "outside-the-sandbox" }\n', 'utf8');
  const workspace = new Workspace(root);

  let i = 0;
  const demoChat = async () => {
    const message = DEMO_SCRIPT[Math.min(i, DEMO_SCRIPT.length - 1)];
    i += 1;
    return { choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] };
  };

  const result = await runTask({
    task: 'demo', workspace, commandPolicy: 'allow', maxSteps: DEMO_SCRIPT.length + 1, chatFn: demoChat, log: quiet,
  });

  assert.equal(result.ok, true, 'the demo should end on a final answer');
  const { rows, passed, total } = sandboxScorecard(result.messages);
  assert.deepEqual(rows.filter((r) => !r.ok).map((r) => `${r.label} (saw: ${r.seen})`), []);
  assert.equal(passed, total);

  // The escape attempt must not have written anything outside the workspace.
  assert.ok(!fs.existsSync(path.join(root, '..', 'escape.txt')));
  assert.ok(fs.existsSync(path.join(root, 'demo', 'hello.js')));
});
