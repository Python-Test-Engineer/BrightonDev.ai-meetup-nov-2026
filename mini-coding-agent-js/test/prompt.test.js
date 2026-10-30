import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemRules, buildSystemPrompt } from '../src/prompt.js';
import { Memory } from '../src/memory.js';
import { TOOL_NAMES } from '../src/tools.js';

function memory(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-prompt-'));
  return new Memory({ root, now: () => new Date('2026-10-28T10:00:00'), ...options });
}

test('the system rules name every tool the model can call', () => {
  const rules = systemRules();
  for (const name of TOOL_NAMES) assert.match(rules, new RegExp(`\\b${name}\\b`));
  assert.match(rules, /Reads may use any path/);
  assert.match(rules, /only work inside the workspace/);
  // Rule 6 is the memory rule: durable facts, never task progress.
  assert.match(rules, /save it with remember/);
  assert.match(rules, /Never save task progress/);
});

test('without memory the system prompt is just the rules', () => {
  assert.equal(buildSystemPrompt(), systemRules());
  assert.equal(buildSystemPrompt({ memory: null }), systemRules());
});

test('memory is appended to the rules, and the console hears about it once', () => {
  const store = memory();
  store.remember('the tests run with npm test', { tag: 'fact' });

  const lines = [];
  const prompt = buildSystemPrompt({ memory: store, log: (line) => lines.push(line) });

  assert.ok(prompt.startsWith(systemRules()), 'the rules come first');
  assert.match(prompt, /## What you remember from earlier runs/);
  assert.match(prompt, /the tests run with npm test/);
  assert.equal(lines.length, 1, 'one line, not one per memory');
  assert.match(lines[0], /1 memory added to the system prompt/);
});

test('an empty or disabled store adds nothing and says nothing', () => {
  const empty = memory();
  const quiet = [];
  assert.equal(buildSystemPrompt({ memory: empty, log: (l) => quiet.push(l) }), systemRules());
  assert.equal(quiet.length, 0, 'no "memory ←" line when there is nothing to carry');

  const disabled = memory({ promptChars: 0 });
  disabled.remember('stored but not injected');
  assert.equal(buildSystemPrompt({ memory: disabled }), systemRules());
});
