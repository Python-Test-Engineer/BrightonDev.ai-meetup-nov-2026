#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chat, sanitizeAssistant } from './llm.js';
import { TOOL_SCHEMAS, runTool, TOOL_NAMES, SANDBOX_LIMITS } from './tools.js';
import { Workspace } from './workspace.js';
import { loadConfig, fingerprint } from './config.js';
import { ui } from './ui.js';

const SYSTEM_PROMPT = `You are a small coding agent working inside a sandboxed folder.

You have tools: ${TOOL_NAMES.join(', ')}. All paths are relative to your workspace root; absolute paths and ".." are refused.

How to work:
1. Look before you write: list_files / read_file before editing.
2. Prefer create_file for new files, edit_file for small changes, write_file only when replacing a whole file.
3. Every edit must use an old_string copied exactly from read_file output.
4. Run what you wrote with run_command and check the exit code. If it fails, read the error, fix it, run again.
5. Do not invent tool results. Stop calling tools when the task is done and reply with a short summary of what you changed.

Be concise. One tool call per step where possible.`;

/* ------------------------------------------------------------------ *
 * Liveness: a slow model call must not look like a frozen program.
 * ------------------------------------------------------------------ */
function heartbeat(log, everyMs = 5000) {
  const started = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    log(ui.waiting(`  … still waiting for the model (${seconds}s)`));
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * The whole agent: think -> tool call -> result -> repeat -> answer.
 * Nothing here is magic, and that is the point of the demo.
 */
export async function runTask({ task, workspace, commandPolicy, maxSteps, chatFn, confirm, log = console.log, heartbeatMs = 5000 }) {
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
    log(ui.step(step, maxSteps));

    let reply;
    const beat = heartbeat(log, heartbeatMs);
    try {
      reply = await chatFn({ messages, tools: TOOL_SCHEMAS });
    } catch (err) {
      beat.stop();
      log(ui.error(`request failed: ${err.message}`));
      return { ok: false, reason: 'request_failed', messages };
    }
    beat.stop();

    const choice = reply?.choices?.[0] ?? {};
    const message = choice.message ?? {};

    // A truncated reply means half a tool call. Do not dispatch it.
    if (choice.finish_reason === 'length' && !message.tool_calls?.length) {
      messages.push({ role: 'assistant', content: message.content ?? '' });
      messages.push({ role: 'user', content: 'You were cut off by the length limit. Continue with smaller tool calls.' });
      log(ui.warn('reply was truncated - asking the model to continue smaller'));
      continue;
    }

    messages.push(sanitizeAssistant(message));
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (message.content && message.content.trim()) log(ui.think(message.content.trim()));

    if (calls.length === 0) {
      log('');
      log(ui.answerRule());
      log(ui.answer((message.content ?? '(no answer)').trim()));
      return { ok: true, answer: message.content ?? '', messages, steps: step };
    }

    for (const call of calls) {
      const name = call.function?.name ?? '(unnamed)';
      const rawArgs = call.function?.arguments ?? '{}';
      log(ui.tool(name, rawArgs));

      const result = await runTool(name, rawArgs, ctx);
      log(ui.result(result));

      // Every tool_call_id MUST get a matching tool message or the next request is invalid.
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  log(ui.error(`stopped: hit the ${maxSteps}-step limit`));
  return { ok: false, reason: 'max_steps', messages };
}

/* ------------------------------------------------------------------ *
 * Scripted fallback: same loop, same dispatcher, same guards, no network.
 * For when conference wifi decides to test you.
 *
 * Steps s1-s5 are ordinary work. Steps s6-s10 deliberately try to break out
 * of the sandbox, so the refusals are SHOWN rather than described - and the
 * scorecard printed at the end checks they actually happened.
 * ------------------------------------------------------------------ */
function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

export const DEMO_SCRIPT = [
  {
    content: 'Looking first: what is in the workspace, and what does the sandbox allow.',
    tool_calls: [call('s1', 'list_files', { path: '.' })],
  },
  {
    content: 'Creating a script, then running it to check it works.',
    tool_calls: [call('s2', 'create_file', {
      path: 'demo/hello.js',
      content: "const name = 'tiny agent';\nconsole.log(`Hello from a ${name}`);\n",
    })],
  },
  { content: 'Now run it - a real shell, a real exit code.', tool_calls: [call('s3', 'run_command', { command: 'node demo/hello.js' })] },
  {
    content: 'Fixing the copy in the script.',
    tool_calls: [call('s4', 'edit_file', {
      path: 'demo/hello.js',
      old_string: 'Hello from a ${name}',
      new_string: 'Hello from a ${name}, edited by a tool call',
    })],
  },
  { content: 'Re-running to verify the edit.', tool_calls: [call('s5', 'run_command', { command: 'node demo/hello.js' })] },

  // ---- the sandbox, tested instead of described -------------------
  {
    content: 'Now the guards. First a write that tries to climb out of the workspace:',
    tool_calls: [call('s6', 'write_file', { path: '../escape.txt', content: 'this file must never be written' })],
  },
  {
    content: 'Then a read from the home folder, where the private keys live:',
    tool_calls: [call('s7', 'read_file', { path: '~/.ssh/id_rsa' })],
  },
  {
    content: 'A command the deny-list refuses no matter what CMD_POLICY says:',
    tool_calls: [call('s8', 'run_command', { command: 'git push --force origin main' })],
  },
  {
    content: 'A command that asks its own child process for the API key:',
    tool_calls: [call('s9', 'run_command', {
      command: 'node -e "console.log(\'OPENROUTER_API_KEY=\' + (process.env.OPENROUTER_API_KEY ?? \'absent\'))"',
    })],
  },
  {
    content: 'And a command that fails, so the exit code has to explain itself:',
    tool_calls: [call('s10', 'run_command', { command: 'node -e "process.exit(1)"' })],
  },
  {
    content: 'Done. Created demo/hello.js, ran it, edited one string, ran it again (exit 0 both times). '
      + 'Then the sandbox: the ../escape.txt write and the ~/.ssh read were refused before touching disk, '
      + 'git push --force was denied by policy, the child process could not see the API key, and the failing '
      + 'command came back as exit code 1 with an explanation. The scorecard below is checkable, not a claim.',
  },
];

/** One check per guard the demo exercises: the step, and what its result must look like. */
const DEMO_CHECKS = [
  { id: 's6', label: 'file tools stay inside the workspace', expect: /^ERROR: path escapes the workspace/ },
  { id: 's7', label: 'home and system paths are refused', expect: /^ERROR: (home\/environment|absolute)/ },
  { id: 's8', label: 'dangerous commands are denied, whatever the policy', expect: /^DENIED: blocked by policy/ },
  { id: 's9', label: 'the child process cannot see the API key', expect: /OPENROUTER_API_KEY=absent/, show: /OPENROUTER_API_KEY=\S+/ },
  { id: 's10', label: 'run_command reports the real exit code', expect: /^exit code 1\b/ },
];

/** Read the demo's own tool results back and say which guards actually held. */
export function sandboxScorecard(messages) {
  const byId = new Map(
    messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, String(m.content)]),
  );
  const rows = DEMO_CHECKS.map((check) => {
    const got = byId.get(check.id) ?? '(the step never ran)';
    const evidence = String(got).match(check.show ?? check.expect);
    // Show the proof where there is one ("OPENROUTER_API_KEY=absent"), else the result line.
    const seen = (evidence?.[0] ?? String(got).split('\n')[0]).slice(0, 120);
    return { ok: check.expect.test(got), label: check.label, seen };
  });
  return { rows, passed: rows.filter((r) => r.ok).length, total: rows.length };
}

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
    const answer = await new Promise((resolve) => rl.question(`  ${ui.prompt('run?')} ${command} ${ui.dim('[y/N]')} `, resolve));
    rl.close();
    return /^y(es)?$/i.test(answer.trim()) ? 'allow' : 'deny';
  };
}

/* ------------------------------------------------------------------ *
 * The input field: with no task on the command line, ask for one.
 * ------------------------------------------------------------------ */
export async function askTask({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) });
  // Ctrl-C closes the field; the caller then stops with a red note.
  rl.on('SIGINT', () => rl.close());
  rl.setPrompt(`  ${ui.field('task')} `);

  try {
    // An async iterator queues lines properly. `rl.question()` does not: two
    // lines arriving in one chunk would resolve the first and drop the second.
    rl.prompt();
    for await (const raw of rl) {
      const task = String(raw).trim();
      if (task) return task;
      output.write(`  ${ui.warn('nothing entered - type a task, or press Ctrl-C to quit')}\n`);
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
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
${ui.title('min-coding-js')} ${ui.dim('- a small coding agent in Node')}

  node src/agent.js                          live model, type the task in the prompt
  node src/agent.js "task for the agent"     same, task given up front
  node src/agent.js --demo                   scripted run, no network: the loop AND the sandbox guards
  node src/agent.js "..." --yes              auto-approve commands
  node src/agent.js "..." --allow-commands   same, from a flag
  node src/agent.js "..." --max-steps 6      cap the loop
  node src/agent.js "..." --model anthropic/claude-sonnet-4.5

${ui.warn('Env: OPENROUTER_API_KEY, OPENROUTER_MODEL, CMD_POLICY=allow|ask|deny, MAX_STEPS, REQUEST_TIMEOUT_MS')}
Files are confined to ./workspace. Run "npm test" for the offline test suite.

Exit codes:
  0  finished - the model gave a final answer
  1  the run did not finish: a model request failed (no network, timeout, bad key,
     unknown model slug) or a fatal error was thrown. The red line above says which.
  2  no task: none was given as an argument and stdin is not a terminal, so the
     input field could not be shown.
  3  stopped at the step limit before the model answered - raise --max-steps N.
`);
}

async function runCli() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const config = loadConfig({ model: opts.model });
  const workspace = new Workspace(config.workspaceRoot);

  // The scripted demo runs a fixed list of harmless commands (verifying its own
  // scratch file), so it may auto-approve; live runs keep the ask policy.
  const commandPolicy = opts.yes || opts.demo ? 'allow' : (opts.policy ?? config.commandPolicy);

  const source = (label, overrode) => (overrode ? `${label}, overrode the shell value` : label);
  const kv = (label, value) => console.log(ui.kv(label, value));
  console.log(ui.title('\nmin-coding-js'));
  kv('workspace', workspace.root);
  kv('model', opts.demo ? 'scripted (no network)' : `${config.model} (from ${source(config.modelSource, config.modelOverrodeShell)})`);
  kv('key', opts.demo ? '-' : `${fingerprint(config.apiKey)} from ${source(config.apiKeySource, config.apiKeyOverrodeShell)}`);
  kv('env file', fs.existsSync(config.envFile) ? config.envFile : `${config.envFile} (missing)`);
  kv('commands', commandPolicy);
  kv('timeout', `${Math.round(config.requestTimeoutMs / 1000)}s per model call`);
  kv('tools', TOOL_NAMES.join(', '));

  if (!opts.demo && !config.model.includes('/')) {
    console.log(ui.warn(`warning: model "${config.model}" is not an OpenRouter slug (needs vendor/model). Set OPENROUTER_MODEL in .env.`));
  }
  if (!opts.demo && config.modelNormalised) {
    console.log(ui.note(`note      : bare model name in config was normalised to "${config.model}"`));
  }

  const chatFn = opts.demo
    ? demoChat()
    : (args) => chat({ apiKey: config.apiKey, model: config.model, timeoutMs: config.requestTimeoutMs, ...args });

  if (!opts.demo && !config.apiKey) {
    console.log(ui.error('\nOPENROUTER_API_KEY is not set. Copy .env.example to .env, or run --demo.'));
    process.exitCode = 1;
    return;
  }

  let task = opts.task || (opts.demo ? 'Show the loop, then try to break the sandbox: create a script, run it, edit it, run it again, then attempt a path escape, a home-folder read, a force push and an API-key echo.' : '');

  if (!task) {
    // Constraint: an input field needs a terminal - a pipe can never answer it.
    if (!process.stdin.isTTY) {
      console.log(ui.error('stopped: cannot ask for a task because stdin is not a terminal.'));
      console.log(ui.dim('  pass it as an argument instead: node src/agent.js "create hello.js and run it"'));
      process.exitCode = 2;
      return;
    }
    console.log(ui.dim('\n  no task on the command line - type one below (Ctrl-C to quit)\n'));
    task = await askTask();
    if (!task) {
      console.log(ui.error('\nstopped: no task given (nothing entered, or the input closed)'));
      process.exitCode = 2;
      return;
    }
  }

  console.log(ui.note(`\ntask      : ${task}\n`));

  const result = await runTask({
    task,
    workspace,
    commandPolicy,
    maxSteps: opts.maxSteps ?? (opts.demo ? DEMO_SCRIPT.length + 1 : config.maxSteps),
    chatFn,
    confirm: makeConfirm(),
  });

  if (!result.ok && result.reason === 'request_failed') process.exitCode = 1;
  if (!result.ok && result.reason === 'max_steps') process.exitCode = 3;

  // The demo claims the guards hold, so check them against what actually ran.
  if (opts.demo) reportSandbox(result.messages);
}

/** Print which sandbox guards the demo exercised, and whether each one held. */
function reportSandbox(messages) {
  const { rows, passed, total } = sandboxScorecard(messages);
  console.log('');
  console.log(ui.rule('sandbox checks'));
  for (const row of rows) {
    console.log(`  ${row.ok ? ui.pass(row.label) : ui.fail(row.label)} ${ui.dim(`- ${row.seen}`)}`);
  }
  console.log('');
  console.log(ui.dim(
    `  also enforced, not demoed above: ${SANDBOX_LIMITS.maxOutput}-char output cap per command, `
    + `${SANDBOX_LIMITS.timeoutMs / 1000}s command timeout, ${SANDBOX_LIMITS.denyPatterns} hard-deny patterns, `
    + `a ${SANDBOX_LIMITS.envKeys}-variable env allow-list, and the 'ask'/'deny' command policies.`,
  ));
  console.log('');
  console.log(passed === total
    ? ui.pass(`${passed}/${total} sandbox checks held`)
    : ui.fail(`${passed}/${total} sandbox checks held - the guard above needs a look`));

  if (passed !== total) process.exitCode = 1;
}

/**
 * What this process's own exit code means. A non-zero exit is the last thing
 * anyone reads, so it gets a sentence instead of a number.
 */
const CLI_EXIT_NOTES = {
  1: 'the run did not finish - a model request failed (no network, timeout, bad key, unknown model slug) or a fatal error was caught; the red line above says which, and nothing was retried',
  2: 'no task was given - nothing ran; pass the task as an argument, or drive the prompt from a real terminal',
  3: 'the loop hit the step limit before the model answered - raise it with --max-steps N or MAX_STEPS, or give a smaller task',
};

async function main() {
  try {
    await runCli();
  } catch (err) {
    console.error(ui.error(`fatal: ${err.stack ?? err.message}`));
    process.exitCode = 1;
  }

  const code = process.exitCode ?? 0;
  if (code !== 0) {
    console.log('');
    console.log(ui.exitNote(code, CLI_EXIT_NOTES[code]));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
