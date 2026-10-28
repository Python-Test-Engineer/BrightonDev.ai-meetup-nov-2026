/**
 * agent.js - the loop. This is the whole agent, and everything else in src/
 * exists to serve it.
 *
 * READ THIS FILE FIRST, AND IN FULL. It is one exported function, ~120 lines of
 * code, and no process concerns: no flags, no colours, no banner, no exit codes.
 * Those live next door, and knowing where they are *not* is half the design.
 *
 *   think -> model call -> tool calls? --+-- no  --> answer, stop
 *            (llm.js)       (tools.js)   |
 *      ^                                 +-- yes --> run each tool,
 *      +--------------------------------------------- append the result
 *
 * THE SEVEN BEATS, once per step:
 *   1. announce the step, and arm the heartbeat          (heartbeat.js)
 *   2. one model call: the entire message array + tools  (llm.js)
 *   3. refuse to dispatch a truncated reply
 *   4. push the assistant message back into history
 *   5. no tool calls  -> print the answer and return
 *   6. each tool call -> dispatch, log, append the result (tools.js)
 *   7. loop
 *
 * THE NINE `hook.run(...)` CALLS are the lifecycle. Each is a named moment where
 * outside code gets a turn; with no hooks attached they cost nothing. The
 * comments below number them; `node src/cli.js --hooks` prints what each is for,
 * and hooks.js is the file to read after this one.
 *
 * WHAT IS NOT HERE, AND WHY: the system prompt is prompt.js (it is prose, and it
 * earns its own file), the demo script is demo.js, the CLI is cli.js, memory is
 * memory.js. Nothing in this file knows a flag name or a colour.
 */
import { chat, sanitizeAssistant } from './llm.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { heartbeat } from './heartbeat.js';
import { Hooks } from './hooks.js';
import { ui } from './ui.js';
import { pathToFileURL } from 'node:url';

/**
 * Run one task to completion.
 *
 * Every dependency is injected, which is why the tests can run the real loop
 * with a fake model and no network:
 *
 * @param {object} options
 * @param {string} options.task             what the user asked for
 * @param {Workspace} options.workspace     where file tools are allowed to work
 * @param {'allow'|'ask'|'deny'} options.commandPolicy
 * @param {number} options.maxSteps         how many model calls the loop may make
 * @param {(args: object) => Promise<object>} options.chatFn   one model request
 * @param {(command: string) => Promise<'allow'|'deny'>} [options.confirm]
 * @param {Hooks|null} [options.hooks]      the lifecycle (hooks.js)
 * @param {Memory|null} [options.memory]    long-term memory (memory.js)
 * @param {object[]} [options.history]      messages from the previous task, when
 *                                          this is a follow-up in a session
 * @param {(line: string) => void} [options.log]  where the run narrates itself
 * @param {number} [options.heartbeatMs]    how often to say "still waiting"
 * @returns {Promise<{ok: boolean, reason?: string, answer?: string,
 *                    messages: object[], steps?: number}>}
 */
export async function runTask({
  task, workspace, commandPolicy, maxSteps, chatFn, confirm,
  hooks = null, memory = null, history = [], log = console.log, heartbeatMs = 5000,
}) {
  const started = Date.now();
  const hook = hooks ?? new Hooks();
  const durationMs = () => Date.now() - started;

  // One task = one run = one step budget: `step` starts at 1 again every call.
  //
  // `history` is the PREVIOUS task's messages, which the CLI carries across an
  // interactive session so a follow-up ("now add tests") still knows what was
  // just built. The system prompt is deliberately NOT carried: it is rebuilt
  // here, so a memory written by the last task is already in front of the model.
  const messages = [
    { role: 'system', content: buildSystemPrompt({ memory, log }) },
    ...history.filter((m) => m.role !== 'system'),
    { role: 'user', content: task },
  ];
  const taskIndex = messages.length - 1;

  // Tools reach the world through this object: the sandbox root, the command
  // policy, the approval callback, and the memory store.
  const ctx = { workspace, commandPolicy, memory, confirm: confirm ?? (async () => 'deny') };

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
    messages[taskIndex] = { role: 'user', content: submitted.task };
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

    // 5. No tool calls means the model is finished: print the answer and return.
    if (calls.length === 0) {
      log('');
      log(ui.answerRule());
      log(ui.answer((message.content ?? '(no answer)').trim()));
      // 8. Stop - the happy ending, and 9. SessionEnd - always last.
      await hook.run('Stop', { answer: message.content ?? '', steps: step, messages });
      await hook.run('SessionEnd', { ok: true, reason: 'answer', steps: step, durationMs: durationMs(), messages });
      return { ok: true, answer: message.content ?? '', messages, steps: step };
    }

    // 6. Dispatch. Results are strings, and every tool_call_id gets a reply.
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
        log(ui.dim(`         \u21b3 PostToolUse hook rewrote the observation (${post.replace.length} chars)`));
      }

      // Every tool_call_id MUST get a matching tool message or the next request is invalid.
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(post.replace ?? result) });
    }
  }

  // 7. The step budget ran out. Failures get a lifecycle too.
  log(ui.error(`stopped: hit the ${maxSteps}-step limit`));
  await hook.run('StepLimit', { steps: maxSteps, messages });
  await hook.run('SessionEnd', { ok: false, reason: 'max_steps', steps: maxSteps, durationMs: durationMs(), messages });
  return { ok: false, reason: 'max_steps', messages };
}

/* ------------------------------------------------------------------ *
 * Entry guard: this file is a library, not a program.
 *
 * Running it directly is a common slip, so it says where the program is
 * instead of doing nothing. There is no import of cli.js here on purpose -
 * the loop must not depend on the thing that runs it.
 * ------------------------------------------------------------------ */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('agent.js is the loop, not the program.');
  console.log('Run the CLI instead:  node src/cli.js --help');
}
