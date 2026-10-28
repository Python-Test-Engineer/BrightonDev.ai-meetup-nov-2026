#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chat, sanitizeAssistant } from './llm.js';
import { TOOL_SCHEMAS, runTool, TOOL_NAMES, SANDBOX_LIMITS } from './tools.js';
import { Workspace } from './workspace.js';
import { loadConfig, fingerprint } from './config.js';
import { ui } from './ui.js';
import { Hooks, traceHooks, printHookCatalogue, HOOK_EVENTS } from './hooks.js';
import { Memory } from './memory.js';

const SYSTEM_PROMPT = `You are a small coding agent working inside a sandboxed folder.

You have tools: ${TOOL_NAMES.join(', ')}. All paths are relative to your workspace root; absolute paths and ".." are refused.

How to work:
1. Look before you write: list_files / read_file before editing.
2. Prefer create_file for new files, edit_file for small changes, write_file only when replacing a whole file.
3. Every edit must use an old_string copied exactly from read_file output.
4. Run what you wrote with run_command and check the exit code. If it fails, read the error, fix it, run again.
5. Do not invent tool results. Stop calling tools when the task is done and reply with a short summary of what you changed.
6. If you learn something that will still be true next week - a command this repo needs, a preference the user stated, a trap you fell into - save it with remember. Never save task progress: "step 3 of 5" is not a memory, and it is worthless to the next run.

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
 *
 * The nine `hook.run(...)` calls below are the lifecycle. Each one is a named
 * moment where outside code gets a turn; with no hooks attached they cost
 * nothing, and `--hooks` prints what each moment is for. Read hooks.js next.
 */
export async function runTask({
  task, workspace, commandPolicy, maxSteps, chatFn, confirm,
  hooks = null, memory = null, log = console.log, heartbeatMs = 5000,
}) {
  const started = Date.now();
  const hook = hooks ?? new Hooks();

  // Long-term memory, read ONCE and pasted into the system prompt. This is the
  // whole trick: memory is not a special channel or a vector database, it is a
  // bounded block of text in the one message the model always receives. What
  // does not fit is still in the file, one `recall` call away - which is why
  // the digest ends with a line saying what it left out.
  const remembered = memory ? memory.digest() : '';
  const messages = [
    { role: 'system', content: remembered ? `${SYSTEM_PROMPT}\n\n${remembered}` : SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];
  if (remembered) {
    const injected = remembered.split('\n').filter((line) => line.startsWith('- [')).length;
    log(ui.memory(`${memory.label} - ${injected} ${injected === 1 ? 'memory' : 'memories'} added to the system prompt`));
  }

  const ctx = {
    workspace,
    commandPolicy,
    memory,
    confirm: confirm ?? (async () => 'deny'),
  };
  const durationMs = () => Date.now() - started;

  // 1. SessionStart - the run exists, nothing has been sent. Project rules, a
  //    transcript file and any budget check belong here; a hook may also refuse
  //    to start at all, which is the cheapest way to enforce a precondition.
  const opening = await hook.run('SessionStart', {
    task, workspace: workspace.root, config: { commandPolicy, maxSteps }, log,
  });
  if (opening.blocked) {
    log(ui.error(`stopped before the first request: ${opening.reason}`));
    await hook.run('SessionEnd', { ok: false, reason: 'blocked', steps: 0, durationMs: durationMs(), messages });
    return { ok: false, reason: 'blocked_by_hook', messages };
  }

  // 2. UserPromptSubmit - the last moment before the model sees the task, and
  //    the first place a harness gets an opinion: rewrite it, or refuse it.
  const submitted = await hook.run('UserPromptSubmit', { task });
  if (submitted.blocked) {
    log(ui.error(`stopped: ${submitted.reason}`));
    await hook.run('SessionEnd', { ok: false, reason: 'blocked', steps: 0, durationMs: durationMs(), messages });
    return { ok: false, reason: 'blocked_by_hook', messages };
  }
  if (submitted.task !== null) {
    log(ui.dim(`  UserPromptSubmit hook rewrote the task: ${submitted.task}`));
    messages[1] = { role: 'user', content: submitted.task };
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    log('');
    log(ui.step(step, maxSteps));

    // 3. PreModel - the request is assembled and about to go over the wire.
    await hook.run('PreModel', { step, maxSteps, messages, tools: TOOL_SCHEMAS });

    let reply;
    const beat = heartbeat(log, heartbeatMs);
    try {
      reply = await chatFn({ messages, tools: TOOL_SCHEMAS });
    } catch (err) {
      beat.stop();
      log(ui.error(`request failed: ${err.message}`));
      await hook.run('SessionEnd', { ok: false, reason: 'request_failed', steps: step, durationMs: durationMs(), messages });
      return { ok: false, reason: 'request_failed', messages };
    }
    beat.stop();

    const choice = reply?.choices?.[0] ?? {};
    const message = choice.message ?? {};

    // 4. PostModel - text came back; an answer or a tool call, visible here first.
    await hook.run('PostModel', { step, message, finishReason: choice.finish_reason });

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
      // 7. Stop - the happy ending, and 9. SessionEnd - always last.
      await hook.run('Stop', { answer: message.content ?? '', steps: step, messages });
      await hook.run('SessionEnd', { ok: true, reason: 'answer', steps: step, durationMs: durationMs(), messages });
      return { ok: true, answer: message.content ?? '', messages, steps: step };
    }

    for (const call of calls) {
      const name = call.function?.name ?? '(unnamed)';
      const rawArgs = call.function?.arguments ?? '{}';
      log(ui.tool(name, rawArgs));

      // 5. PreToolUse - the one hook that changes what the agent may do. A
      //    refusal is returned to the model as an observation, exactly like any
      //    other failed tool, so it can pick another route on the next step.
      const pre = await hook.run('PreToolUse', { name, args: rawArgs, step });
      const result = pre.blocked
        ? `DENIED: a PreToolUse hook blocked this call (${pre.reason}). Try another approach.`
        : await runTool(name, rawArgs, ctx);
      log(ui.result(result));

      // 6. PostToolUse - the model reads back whatever this returns, which is
      //    how a secret gets redacted or a huge output gets capped.
      const post = await hook.run('PostToolUse', {
        name, result, step, ok: !/^(ERROR|DENIED)\b/.test(result),
      });
      if (post.replace !== null) {
        log(ui.dim(`         ↳ PostToolUse hook rewrote the observation (${post.replace.length} chars)`));
      }

      // Every tool_call_id MUST get a matching tool message or the next request is invalid.
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(post.replace ?? result) });
    }
  }

  log(ui.error(`stopped: hit the ${maxSteps}-step limit`));
  // 8. StepLimit - failures get a lifecycle too.
  await hook.run('StepLimit', { steps: maxSteps, messages });
  await hook.run('SessionEnd', { ok: false, reason: 'max_steps', steps: maxSteps, durationMs: durationMs(), messages });
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
      content: "const agent = 'tiny agent';\nconsole.log(`Hello from a ${agent}`);\n",
    })],
  },
  { content: 'Now run it - a real shell, a real exit code.', tool_calls: [call('s3', 'run_command', { command: 'node demo/hello.js' })] },
  {
    content: 'Fixing the copy in the script.',
    tool_calls: [call('s4', 'edit_file', {
      path: 'demo/hello.js',
      old_string: 'Hello from a ${agent}',
      new_string: 'Hello from a ${agent}, edited by a tool call',
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

  // ---- the only two steps whose effect survives this process ---------
  {
    content: 'Saving one durable fact, the way a later run would find it again:',
    tool_calls: [call('s11', 'remember', {
      text: 'The sandbox demo script lives at demo/hello.js and is safe to regenerate with create_file.',
      tag: 'fact',
    })],
  },
  {
    content: 'Reading memory back the lazy way - the same file the system prompt was built from:',
    tool_calls: [call('s12', 'recall', { query: 'demo' })],
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
  const opts = {
    task: '', demo: false, model: undefined, maxSteps: undefined, policy: undefined,
    yes: false, showHooks: false, traceHooks: false, noHooks: false,
    showMemory: false, noMemory: false,
  };
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo') opts.demo = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--max-steps') opts.maxSteps = Number(argv[++i]);
    else if (a === '--allow-commands') opts.policy = 'allow';
    else if (a === '--hooks') opts.showHooks = true;
    else if (a === '--memory') opts.showMemory = true;
    else if (a === '--no-memory') opts.noMemory = true;
    else if (a === '--trace-hooks') opts.traceHooks = true;
    else if (a === '--no-hooks') opts.noHooks = true;
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
  node src/agent.js --hooks                  the lifecycle: every hook, icon, colour, why
  node src/agent.js "..." --no-hooks         hide the [HOOK:...] lines (they are on by default)
  node src/agent.js --memory                 print memory.md and exactly what it injects, then exit
  node src/agent.js "..." --no-memory        run with no long-term memory at all

${ui.warn('Env: OPENROUTER_API_KEY, OPENROUTER_MODEL, CMD_POLICY=allow|ask|deny, MAX_STEPS, REQUEST_TIMEOUT_MS')}
${ui.warn('     MEMORY_FILE=src/memory.md, MEMORY_MAX_ENTRIES=60, MEMORY_PROMPT_CHARS=1200')}
Files are confined to ./workspace; long-term memory lives in ./src/memory.md. Run "npm test" for the offline test suite.

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

  // The lifecycle needs no config and no key: it is a description of the loop,
  // and printing it here is the fastest way to answer "what can I hook into?".
  if (opts.showHooks) {
    printHookCatalogue({ log: console.log });
    console.log(ui.dim('  Attach one with hooks.on("PreToolUse", fn) and pass it to runTask({ hooks }).'));
    console.log(ui.dim('  A normal run prints each moment as it fires: [HOOK:Name] what it is for.\n'));
    return;
  }

  const config = loadConfig({ model: opts.model });
  const workspace = new Workspace(config.workspaceRoot);
  const memory = new Memory({
    // root = the package, so the label reads "src/memory.md" rather than an
    // absolute path. The file itself comes from config and may be absolute.
    root: config.projectRoot,
    file: config.memoryFile,
    maxEntries: config.memoryMaxEntries,
    promptChars: config.memoryPromptChars,
  });

  // "What does it remember?" is answered by printing a markdown file, not by
  // asking a model. That is the point of keeping memory in a file you can diff.
  if (opts.showMemory) return showMemory(memory, config);

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
  kv('memory', opts.noMemory ? 'off (--no-memory)' : memory.summary());
  kv('hooks', opts.noHooks
    ? `${HOOK_EVENTS.length} available, not printed (--no-hooks)`
    : `on: each of the ${HOOK_EVENTS.length} prints as [HOOK:name] - see --hooks, silence with --no-hooks`);

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

  // The lifecycle trace is ON by default: every demo and every live run prints
  // its nine moments as `[HOOK:Name] what this moment is for`, which is the
  // whole lesson in one grep-able line. --no-hooks silences it; --trace-hooks
  // says the same thing explicitly (it is the documented spelling for "show me").
  const tracing = !opts.noHooks;
  const hooks = tracing ? traceHooks({ log: console.log }) : null;
  if (hooks) {
    console.log(ui.dim(`  ${hooks.attached().length} lifecycle hooks attached - each prints as it fires, e.g.`));
    console.log(ui.hookTrace('🛠️', 'PreToolUse', 'yellowBright', 'before every tool call', 'run_command {"command":"ls"}'));
    console.log(ui.dim('  (--no-hooks hides these; --hooks explains them)\n'));
  }

  const result = await runTask({
    task,
    workspace,
    commandPolicy,
    maxSteps: opts.maxSteps ?? (opts.demo ? DEMO_SCRIPT.length + 1 : config.maxSteps),
    chatFn,
    confirm: makeConfirm(),
    hooks,
    memory: opts.noMemory ? null : memory,
  });

  if (!result.ok && result.reason === 'request_failed') process.exitCode = 1;
  if (!result.ok && result.reason === 'max_steps') process.exitCode = 3;

  // The demo claims the guards hold, so check them against what actually ran.
  if (opts.demo) reportSandbox(result.messages);
}

/**
 * `--memory`: print the store, and exactly what the model is told about it.
 * Two numbers matter on stage - how many memories exist, and how many characters
 * of them the system prompt actually receives.
 */
function showMemory(memory, config) {
  const entries = memory.entries();
  const digest = memory.digest();
  const injected = digest ? digest.split('\n').filter((line) => line.startsWith('- [')).length : 0;

  console.log(ui.title('\nmin-coding-js · memory'));
  console.log(ui.kv('file', memory.file));
  console.log(ui.kv('exists', memory.exists ? 'yes' : 'no - nothing remembered yet'));
  console.log(ui.kv('entries', `${entries.length} (cap ${config.memoryMaxEntries}, 300 chars each)`));
  console.log(ui.kv('injected', config.memoryPromptChars === 0
    ? 'nothing - MEMORY_PROMPT_CHARS=0, the recall tool still works'
    : `${injected} newest, ${digest.length} of ${config.memoryPromptChars} chars`));

  if (digest) {
    console.log('');
    console.log(ui.rule('what the system prompt gets'));
    console.log(ui.dim(digest));
  }
  if (entries.length) {
    console.log('');
    console.log(ui.rule(`the whole file - ${memory.label}`));
    console.log(ui.dim(fs.readFileSync(memory.file, 'utf8').trim()));
  }
  console.log('');
  console.log(ui.dim('  The model writes to it with the remember tool and searches it with recall;'));
  console.log(ui.dim('  you can edit or delete any line by hand. --no-memory turns it off for a run.'));
  console.log('');
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
