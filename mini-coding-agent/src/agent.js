#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chat, sanitizeAssistant } from './llm.js';
import { TOOL_SCHEMAS, runTool, TOOL_NAMES } from './tools.js';
import { Workspace } from './workspace.js';
import { loadConfig, fingerprint } from './config.js';

const paint = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = paint('2');
const bold = paint('1');
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');

const SYSTEM_PROMPT = `You are a small coding agent working inside a sandboxed folder.

You have tools: ${TOOL_NAMES.join(', ')}. All paths are relative to your workspace root; absolute paths and ".." are refused.

How to work:
1. Look before you write: list_files / read_file before editing.
2. Prefer create_file for new files, edit_file for small changes, write_file only when replacing a whole file.
3. Every edit must use an old_string copied exactly from read_file output.
4. Run what you wrote with run_command and check the exit code. If it fails, read the error, fix it, run again.
5. Do not invent tool results. Stop calling tools when the task is done and reply with a short summary of what you changed.

Be concise. One tool call per step where possible.`;

/**
 * The whole agent: think -> tool call -> result -> repeat -> answer.
 * Nothing here is magic, and that is the point of the demo.
 */
export async function runTask({ task, workspace, commandPolicy, maxSteps, chatFn, confirm, log = console.log }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];
  const ctx = {
    workspace,
    commandPolicy,
    confirm: confirm ?? (async () => 'deny'),
  };

  for (let step = 1; step <= maxSteps; step += 1) {
    log('');
    log(dim(`── step ${step}/${maxSteps} ${'─'.repeat(40)}`));

    let reply;
    try {
      reply = await chatFn({ messages, tools: TOOL_SCHEMAS });
    } catch (err) {
      log(red(`request failed: ${err.message}`));
      return { ok: false, reason: 'request_failed', messages };
    }

    const choice = reply?.choices?.[0] ?? {};
    const message = choice.message ?? {};

    // A truncated reply means half a tool call. Do not dispatch it.
    if (choice.finish_reason === 'length' && !message.tool_calls?.length) {
      messages.push({ role: 'assistant', content: message.content ?? '' });
      messages.push({ role: 'user', content: 'You were cut off by the length limit. Continue with smaller tool calls.' });
      log(yellow('reply was truncated - asking the model to continue smaller'));
      continue;
    }

    messages.push(sanitizeAssistant(message));
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (message.content && message.content.trim()) log(cyan(`think: ${message.content.trim()}`));

    if (calls.length === 0) {
      log('');
      log(green(bold('── final answer ' + '─'.repeat(38))));
      log((message.content ?? '(no answer)').trim());
      return { ok: true, answer: message.content ?? '', messages, steps: step };
    }

    for (const call of calls) {
      const name = call.function?.name ?? '(unnamed)';
      const rawArgs = call.function?.arguments ?? '{}';
      log(yellow(`tool → ${name} ${dim(rawArgs)}`));

      const result = await runTool(name, rawArgs, ctx);
      log(dim(`result ← ${result.split('\n')[0].slice(0, 300)}`));

      // Every tool_call_id MUST get a matching tool message or the next request is invalid.
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  log(red(`stopped: hit the ${maxSteps}-step limit`));
  return { ok: false, reason: 'max_steps', messages };
}

/* ------------------------------------------------------------------ *
 * Scripted fallback: same loop, same dispatcher, no network.
 * For when conference wifi decides to test you.
 * ------------------------------------------------------------------ */
function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const DEMO_SCRIPT = [
  {
    content: 'Creating a script, then running it to check it works.',
    tool_calls: [call('c1', 'create_file', {
      path: 'demo/hello.js',
      content: "const name = 'tiny agent';\nconsole.log(`Hello from a ${name}`);\n",
    })],
  },
  { content: 'Now run it.', tool_calls: [call('c2', 'run_command', { command: 'node demo/hello.js' })] },
  {
    content: 'Fixing the copy in the script.',
    tool_calls: [call('c3', 'edit_file', {
      path: 'demo/hello.js',
      old_string: 'Hello from a ${name}',
      new_string: 'Hello from a ${name}, edited by a tool call',
    })],
  },
  { content: 'Re-running to verify the edit.', tool_calls: [call('c4', 'run_command', { command: 'node demo/hello.js' })] },
  {
    content: 'Done. Created demo/hello.js, ran it, edited one string, re-ran it. The exit codes came back 0 both times.',
  },
];

function demoChat() {
  let i = 0;
  return async () => {
    const message = DEMO_SCRIPT[Math.min(i, DEMO_SCRIPT.length - 1)];
    i += 1;
    return {
      choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    };
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function makeConfirm() {
  return async (command) => {
    if (!process.stdin.isTTY) return 'deny';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(`  ${yellow('run?')} ${command} ${dim('[y/N]')} `, resolve));
    rl.close();
    return /^y(es)?$/i.test(answer.trim()) ? 'allow' : 'deny';
  };
}

function parseArgs(argv) {
  const opts = { task: '', demo: false, model: undefined, maxSteps: undefined, policy: undefined, yes: false };
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo') opts.demo = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--max-steps') opts.maxSteps = Number(argv[++i]);
    else if (a === '--allow-commands') opts.policy = 'allow';
    else if (a === '--help' || a === '-h') opts.help = true;
    else words.push(a);
  }
  opts.task = words.join(' ').trim();
  return opts;
}

function usage() {
  console.log(`
${bold('min-coding-agent')} - a ~300 line coding agent in Node

  node src/agent.js "task for the agent"     live model, ask before each command
  node src/agent.js --demo                   scripted run, no network
  node src/agent.js "..." --yes              auto-approve commands
  node src/agent.js "..." --allow-commands   same, from a flag
  node src/agent.js "..." --max-steps 6      cap the loop
  node src/agent.js "..." --model anthropic/claude-sonnet-4.5

Env: OPENROUTER_API_KEY, OPENROUTER_MODEL, CMD_POLICY=allow|ask|deny, MAX_STEPS
Files are confined to ./workspace. Run "npm test" for the offline test suite.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const config = loadConfig({ model: opts.model });
  const workspace = new Workspace(config.workspaceRoot);

  // The scripted demo runs a fixed list of harmless commands (verifying its own
  // scratch file), so it may auto-approve; live runs keep the ask policy.
  const commandPolicy = opts.yes || opts.demo ? 'allow' : (opts.policy ?? config.commandPolicy);

  const source = (label, overrode) => (overrode ? `${label}, overrode the shell value` : label);
  console.log(bold(cyan('\nmin-coding-agent')));
  console.log(dim(`workspace : ${workspace.root}`));
  console.log(dim(`model     : ${opts.demo ? 'scripted (no network)' : `${config.model} (from ${source(config.modelSource, config.modelOverrodeShell)})`}`));
  console.log(dim(`key       : ${opts.demo ? '-' : `${fingerprint(config.apiKey)} from ${source(config.apiKeySource, config.apiKeyOverrodeShell)}`}`));
  console.log(dim(`env file  : ${fs.existsSync(config.envFile) ? config.envFile : `${config.envFile} (missing)`}`));
  console.log(dim(`commands  : ${commandPolicy}`));
  console.log(dim(`tools     : ${TOOL_NAMES.join(', ')}`));

  if (!opts.demo && !config.model.includes('/')) {
    console.log(yellow(`warning: model "${config.model}" is not an OpenRouter slug (needs vendor/model). Set OPENROUTER_MODEL in .env.`));
  }
  if (!opts.demo && config.modelNormalised) {
    console.log(dim(`note      : bare model name in config was normalised to "${config.model}"`));
  }

  const chatFn = opts.demo
    ? demoChat()
    : (args) => chat({ apiKey: config.apiKey, model: config.model, ...args });

  if (!opts.demo && !config.apiKey) {
    console.log(red('\nOPENROUTER_API_KEY is not set. Copy .env.example to .env, or run --demo.'));
    process.exitCode = 1;
    return;
  }

  const task = opts.task || (opts.demo ? 'Show the loop: create a script, run it, edit it, run it again.' : '');
  if (!task) return usage();

  console.log(dim(`\ntask      : ${task}\n`));

  const result = await runTask({
    task,
    workspace,
    commandPolicy,
    maxSteps: opts.maxSteps ?? config.maxSteps,
    chatFn,
    confirm: makeConfirm(),
  });

  if (!result.ok && result.reason === 'request_failed') process.exitCode = 1;
  if (!result.ok && result.reason === 'max_steps') process.exitCode = 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(red(`fatal: ${err.stack ?? err.message}`));
    process.exitCode = 1;
  });
}
