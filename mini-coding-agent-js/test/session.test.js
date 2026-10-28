import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTask } from '../src/agent.js';
import { interpretCommand, trimHistory, MAX_HISTORY } from '../src/cli.js';
import { Workspace } from '../src/workspace.js';
import { Memory } from '../src/memory.js';
import { Hooks } from '../src/hooks.js';

const quiet = () => {};
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mca-session-'));

/** A chatFn that records exactly what the loop sent, and answers immediately. */
function recorder(answer = 'done') {
  const calls = [];
  const chatFn = async ({ messages }) => {
    calls.push(structuredClone(messages));
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] };
  };
  return { chatFn, calls };
}

test('/quit, /exit and /new are commands; anything else is a task', () => {
  assert.equal(interpretCommand('/quit'), 'quit');
  assert.equal(interpretCommand('/exit'), 'quit');
  assert.equal(interpretCommand('  /QUIT '), 'quit');
  assert.equal(interpretCommand('/new'), 'new');
  assert.equal(interpretCommand('/NeW'), 'new');

  assert.equal(interpretCommand('add tests for the parser'), 'task');
  assert.equal(interpretCommand('new'), 'task', 'a bare word is still a task');
  assert.equal(interpretCommand('quit'), 'task');
  assert.equal(interpretCommand(''), 'task');
});

test('history is trimmed to the cap and always starts on a user message', () => {
  const conversation = [
    { role: 'user', content: 'task one' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'one.js' },
    { role: 'assistant', content: 'made one.js' },
    { role: 'user', content: 'task two' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: 'contents' },
    { role: 'assistant', content: 'done two' },
  ];

  const all = trimHistory(conversation, 100);
  assert.equal(all.length, conversation.length, 'nothing dropped under the cap');
  assert.equal(all[0].role, 'user');

  const capped = trimHistory(conversation, 4);
  assert.ok(capped.length <= 4);
  assert.equal(capped[0].role, 'user', 'the cut lands on a user turn, never on a tool result');
  assert.equal(capped.at(-1).content, 'done two');

  assert.deepEqual(trimHistory([]), []);
  assert.deepEqual(trimHistory(null), []);
  assert.equal(MAX_HISTORY, 24);
});

test('a follow-up task sees the previous conversation but a fresh system prompt', async () => {
  const workspace = new Workspace(root());
  const memory = new Memory({ root: workspace.root, now: () => new Date('2026-10-28T10:00:00') });

  const first = recorder('made app.js');
  const one = await runTask({ task: 'create app.js', workspace, commandPolicy: 'allow', maxSteps: 4, chatFn: first.chatFn, memory, log: quiet });
  assert.equal(one.ok, true);

  // The first task learned something; the next system prompt must already say so.
  memory.remember('the app entry point is app.js', { tag: 'fact' });

  const history = trimHistory(one.messages);
  const second = recorder('added tests');
  const two = await runTask({ task: 'now add tests', workspace, commandPolicy: 'allow', maxSteps: 4, chatFn: second.chatFn, memory, history, log: quiet });

  const sent = second.calls[0];
  assert.equal(sent[0].role, 'system');
  assert.match(sent[0].content, /app entry point is app\.js/, 'memory written by task one is in task two');
  assert.equal(sent.filter((m) => m.role === 'system').length, 1, 'exactly one system message');
  assert.ok(sent.some((m) => m.role === 'user' && m.content === 'create app.js'), 'the earlier task is history');
  assert.equal(sent.at(-1).role, 'user');
  assert.equal(sent.at(-1).content, 'now add tests');
  assert.equal(two.ok, true);
});

test('every task starts its own step budget', async () => {
  const workspace = new Workspace(root());
  const steps = [];
  const chatFn = async ({ messages }) => {
    steps.push(messages.length);
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };
  };

  await runTask({ task: 'one', workspace, commandPolicy: 'allow', maxSteps: 4, chatFn, log: quiet });
  const second = await runTask({ task: 'two', workspace, commandPolicy: 'allow', maxSteps: 4, chatFn, log: quiet });

  assert.equal(second.steps, 1, 'the second task is step 1, not step 2 of the first');
});

test('a hook rewriting the task rewrites the new task, not the history', async () => {
  const workspace = new Workspace(root());
  const hooks = new Hooks();
  hooks.on('UserPromptSubmit', () => ({ task: 'the rewritten task' }));

  const rec = recorder('ok');
  const history = [
    { role: 'user', content: 'earlier task' },
    { role: 'assistant', content: 'earlier answer' },
  ];

  await runTask({ task: 'original', workspace, commandPolicy: 'allow', maxSteps: 2, chatFn: rec.chatFn, hooks, history, log: quiet });

  const sent = rec.calls[0];
  assert.equal(sent[1].content, 'earlier task', 'history is untouched');
  assert.equal(sent.at(-1).content, 'the rewritten task');
});
