#!/usr/bin/env node
/**
 * cli.js - the program around the loop: flags, banner, prompts, exit codes.
 *
 * WHY THIS FILE EXISTS: `agent.js` is a library - one exported function, no
 * process-level concerns. Everything a *person* needs in order to run it lives
 * here instead:
 *
 *   - argument parsing and --help          (what can I type?)
 *   - the startup banner                   (which key, which model, which policy?)
 *   - the "task ›" input field             (and what to do when there is no TTY)
 *   - the y/N confirmation for commands    (the human in the loop)
 *   - --memory / --hooks / --demo wiring   (the three side doors)
 *   - exit codes and their plain-English meaning
 *
 * Read it top to bottom and you have the whole surface area of the tool. The
 * loop itself is 100 lines in agent.js and does not know this file exists.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chat } from './llm.js';
import { TOOL_NAMES, SANDBOX_LIMITS } from './tools.js';
import { Workspace } from './workspace.js';
import { loadConfig, fingerprint } from './config.js';
import { Memory } from './memory.js';
import { ui } from './ui.js';
import { traceHooks, printHookCatalogue, HOOK_EVENTS } from './hooks.js';
import { runTask } from './agent.js';
import { DEMO_SCRIPT, DEMO_TASK, demoChat, sandboxScorecard } from './demo.js';

/* ------------------------------------------------------------------ *
 * The human in the loop: the y/N prompt CMD_POLICY=ask uses.
 * ------------------------------------------------------------------ */
function makeConfirm() {
  return async (command) => {
    // No TTY means nobody can answer, and an unanswerable prompt must never
    // become an approval. Piped input degrades to deny.
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

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */
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
  // Everything that is not a flag is the task, so quoting is optional.
  opts.task = words.join(' ').trim();
  return opts;
}

function usage() {
  console.log(`
${ui.title('min-coding-js')} ${ui.dim('- a small coding agent in Node')}

  node src/cli.js                          interactive session: task, then another
  node src/cli.js "task for the agent"     one shot: run that task and exit
  node src/cli.js --demo                   scripted run, no network: the loop AND the sandbox guards
  node src/cli.js "..." --yes              auto-approve commands
  node src/cli.js "..." --allow-commands   same, from a flag
  node src/cli.js "..." --max-steps 6      cap the loop
  node src/cli.js "..." --model anthropic/claude-sonnet-4.5
  node src/cli.js --hooks                  the lifecycle: every hook, icon, colour, why
  node src/cli.js "..." --no-hooks         hide the [HOOK:...] lines (they are on by default)
  node src/cli.js --memory                 print src/memory.md and exactly what it injects, then exit
  node src/cli.js "..." --no-memory        run with no long-term memory at all

${ui.warn('Env: OPENROUTER_API_KEY, OPENROUTER_MODEL, CMD_POLICY=allow|ask|deny, MAX_STEPS, REQUEST_TIMEOUT_MS')}
${ui.warn('     MEMORY_FILE=src/memory.md, MEMORY_MAX_ENTRIES=60, MEMORY_PROMPT_CHARS=1200')}
Files are confined to ./workspace; long-term memory lives in ./src/memory.md. Run "npm test" for the offline test suite.

In a session: type a task, watch it finish, type the next one. Every task starts
again at step 1 and keeps the conversation; /new clears the conversation, /quit exits.

Exit codes:
  0  finished - the model gave a final answer (or the session ended)
  1  the run did not finish: a model request failed (no network, timeout, bad key,
     unknown model slug) or a fatal error was thrown. The red line above says which.
  2  no task: none was given as an argument and stdin is not a terminal, so the
     input field could not be shown.
  3  stopped at the step limit before the model answered - raise --max-steps N.
`);
}

/* ------------------------------------------------------------------ *
 * The three side doors: --hooks, --memory, and the banner
 * ------------------------------------------------------------------ */

/** `--hooks`: the lifecycle, in colour, with no config and no key needed. */
function showHooks() {
  printHookCatalogue({ log: console.log });
  console.log(ui.dim('  Attach one with hooks.on("PreToolUse", fn) and pass it to runTask({ hooks }).'));
  console.log(ui.dim('  A normal run prints each moment as it fires: [HOOK:Name] what it is for.\n'));
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

/** The startup banner: one reproducible header, printed before step 1. */
function banner({ config, workspace, memory, commandPolicy, opts }) {
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
}

/* ------------------------------------------------------------------ *
 * Sessions: one task, then another, without leaving the program.
 *
 * A task is one `runTask` call, and every call starts at step 1 - so the
 * budget resets by construction rather than by bookkeeping. What we carry
 * between tasks is the CONVERSATION, so "now add tests" still knows what was
 * just built. The system prompt is not carried: it is rebuilt inside runTask,
 * which means a memory the last task saved is already in front of the model.
 * ------------------------------------------------------------------ */

/** How much of the previous task's conversation follows into the next one. */
export const MAX_HISTORY = 24;

/** `/quit` and `/new` are the whole command vocabulary; anything else is a task. */
export function interpretCommand(line) {
  const cmd = String(line ?? '').trim().toLowerCase();
  if (cmd === '/quit' || cmd === '/exit') return 'quit';
  if (cmd === '/new') return 'new';
  return 'task';
}

/**
 * Keep the tail of a conversation, without breaking a tool call.
 *
 * A provider rejects a request whose history starts with a `tool` result (no
 * `tool_calls` to answer) or ends with an assistant `tool_calls` and no result,
 * so the cut always lands on a `user` message - the only safe boundary.
 *
 * @param {object[]} messages a finished run's messages (system included)
 * @param {number} [max] how many messages to keep at most
 * @returns {object[]} the conversation to carry into the next task
 */
export function trimHistory(messages, max = MAX_HISTORY) {
  const kept = (messages ?? []).filter((m) => m.role !== 'system');
  let start = Math.max(0, kept.length - Math.max(0, max));
  // Never start on a tool result or an unanswered tool_calls: providers reject it.
  while (start < kept.length && kept[start].role !== 'user') start += 1;
  return start >= kept.length ? [] : kept.slice(start);
}

/** The exit code a single task would have produced, used for the session summary. */
function taskExitCode(result) {
  if (!result.ok && result.reason === 'request_failed') return 1;
  if (!result.ok && result.reason === 'max_steps') return 3;
  return 0;
}

/** One line after each task: what happened, and what to type next. */
function announce(result, carriedMessages) {
  const code = taskExitCode(result);
  const label = result.ok
    ? `answer in ${result.steps} step(s)`
    : `stopped (${result.reason ?? 'unknown'})`;
  const note = code === 0
    ? `${carriedMessages} message(s) carried into the next task`
    : result.reason === 'max_steps'
      ? 'raise it with --max-steps N, or /new for a fresh conversation'
      : 'check the red line above - the session is still alive, so you can try again';

  console.log('');
  console.log(ui.rule('task finished'));
  console.log(`  ${code === 0 ? ui.pass(label) : ui.fail(label)} ${ui.dim(`- ${note}`)}`);
  console.log(ui.dim('  type another task, /new to clear the conversation, /quit to exit'));
  console.log('');
}

/**
 * Read a task, run it, keep the conversation, ask again. Ends on /quit, Ctrl-C
 * or end of input. Returns when the session is over; exit code 0 unless the
 * whole session was impossible to start (handled by the caller).
 *
 * @param {{base: object, opts: object}} args  `base` is everything runTask needs
 *   except the task itself; `opts` is the parsed command line.
 */
export async function runSession({ base, opts }) {
  console.log(ui.dim('\n  interactive session - type a task below (/new clears, /quit exits)\n'));

  let history = [];
  let tasks = 0;

  for (;;) {
    const line = await askTask();
    if (line === null) break;                       // Ctrl-C or end of input

    const command = interpretCommand(line);
    if (command === 'quit') break;
    if (command === 'new') {
      history = [];
      console.log(ui.dim('  new conversation - the workspace and memory.md are untouched\n'));
      continue;
    }

    tasks += 1;
    console.log(ui.note(`\ntask      : ${line}\n`));

    // Every task gets the same budget, the same hooks, the same sandbox - and
    // the conversation so far. The step counter starts at 1 inside runTask.
    const result = await runTask({ ...base, task: line, history });

    history = trimHistory(result.messages);
    if (opts.demo) reportSandbox(result.messages);

    announce(result, history.length);
  }

  console.log(ui.dim(`\n  session over - ${tasks} task(s) run. The workspace and src/memory.md keep everything.`));
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */
async function runCli() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  // Both side doors need no config and no key: they describe the program.
  if (opts.showHooks) return showHooks();

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

  banner({ config, workspace, memory, commandPolicy, opts });

  const chatFn = opts.demo
    ? demoChat()
    : (args) => chat({ apiKey: config.apiKey, model: config.model, timeoutMs: config.requestTimeoutMs, ...args });

  if (!opts.demo && !config.apiKey) {
    console.log(ui.error('\nOPENROUTER_API_KEY is not set. Copy .env.example to .env, or run --demo.'));
    process.exitCode = 1;
    return;
  }

  // A task on the command line (or --demo) means one shot; no task means a
  // session. The hooks are wired first either way, so the trace intro prints
  // once, before the first task of the session.
  const singleTask = opts.task || (opts.demo ? DEMO_TASK : '');
  if (singleTask) console.log(ui.note(`\ntask      : ${singleTask}\n`));

  // The lifecycle trace is ON by default: every demo and every live run prints
  // its nine moments as `[HOOK:Name] what this moment is for`, which is the
  // whole lesson in one grep-able line. --no-hooks silences it; --trace-hooks
  // says the same thing explicitly (it is the documented spelling for "show me").
  const hooks = opts.noHooks ? null : traceHooks({ log: console.log });
  if (hooks) {
    console.log(ui.dim(`  ${hooks.attached().length} lifecycle hooks attached - each prints as it fires, e.g.`));
    console.log(ui.hookTrace('🛠️', 'PreToolUse', 'yellowBright', 'before every tool call', 'run_command {"command":"ls"}'));
    console.log(ui.dim('  (--no-hooks hides these; --hooks explains them)\n'));
  }

  // Everything runTask needs except the task itself: one sandbox, one policy,
  // one memory store, one chatFn, one set of hooks - reused by every task, so a
  // session pays for the banner and the config once.
  const base = {
    workspace,
    commandPolicy,
    maxSteps: opts.maxSteps ?? (opts.demo ? DEMO_SCRIPT.length + 1 : config.maxSteps),
    chatFn,
    confirm: makeConfirm(),
    hooks,
    memory: opts.noMemory ? null : memory,
  };

  // One shot: run the one task, turn the result into an exit code, leave.
  if (singleTask) {
    const result = await runTask({ ...base, task: singleTask });
    process.exitCode = taskExitCode(result);
    // The demo claims the guards hold, so check them against what actually ran.
    if (opts.demo) reportSandbox(result.messages);
    return;
  }

  // No task and no terminal: nothing can answer the prompt. A constraint of the
  // input field, not a failure of the agent - hence exit code 2.
  if (!process.stdin.isTTY) {
    console.log(ui.error('stopped: cannot ask for a task because stdin is not a terminal.'));
    console.log(ui.dim('  pass it as an argument instead: node src/cli.js "create hello.js and run it"'));
    process.exitCode = 2;
    return;
  }

  // Otherwise: a session. Task, answer, task again - each one a fresh runTask,
  // so each one gets its own step budget, and the conversation is carried over.
  await runSession({ base, opts });
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

/* ------------------------------------------------------------------ *
 * Exit
 * ------------------------------------------------------------------ */
/**
 * What this process's own exit code means. A non-zero exit is the last thing
 * anyone reads, so it gets a sentence instead of a number.
 */
const CLI_EXIT_NOTES = {
  1: 'the run did not finish - a model request failed (no network, timeout, bad key, unknown model slug) or a fatal error was caught; the red line above says which, and nothing was retried',
  2: 'no task was given - nothing ran; pass the task as an argument, or drive the prompt from a real terminal',
  3: 'the loop hit the step limit before the model answered - raise it with --max-steps N or MAX_STEPS, or give a smaller task',
};

export async function main() {
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

// Only start when this file is the one that was run, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
