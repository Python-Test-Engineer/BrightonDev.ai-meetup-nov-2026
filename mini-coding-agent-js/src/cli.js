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

  node src/cli.js                          live model, type the task in the prompt
  node src/cli.js "task for the agent"     same, task given up front
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

Exit codes:
  0  finished - the model gave a final answer
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

  let task = opts.task || (opts.demo ? DEMO_TASK : '');

  if (!task) {
    // Constraint: an input field needs a terminal - a pipe can never answer it.
    if (!process.stdin.isTTY) {
      console.log(ui.error('stopped: cannot ask for a task because stdin is not a terminal.'));
      console.log(ui.dim('  pass it as an argument instead: node src/cli.js "create hello.js and run it"'));
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
  const hooks = opts.noHooks ? null : traceHooks({ log: console.log });
  if (hooks) {
    console.log(ui.dim(`  ${hooks.attached().length} lifecycle hooks attached - each prints as it fires, e.g.`));
    console.log(ui.hookTrace('🛠️', 'PreToolUse', 'yellowBright', 'before every tool call', 'run_command {"command":"ls"}'));
    console.log(ui.dim('  (--no-hooks hides these; --hooks explains them)\n'));
  }

  // Everything above was configuration. This is the agent.
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
