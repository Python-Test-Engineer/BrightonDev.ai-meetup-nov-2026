/**
 * prompt.js - the system prompt: everything the model is told before it starts.
 *
 * WHY THIS FILE EXISTS: a coding agent's behaviour is set by three pieces of
 * text, and this file owns the first one:
 *
 *   1. the SYSTEM PROMPT (here)         - how to work, and what the tools are for
 *   2. the tool descriptions (tools.js) - when to reach for each tool
 *   3. the error strings (tools.js)     - how to recover from a wrong move
 *
 * Keeping the first one out of the loop is the point: `agent.js` should read as
 * "assemble a request, dispatch what comes back", not as three screens of prose.
 *
 * TWO PARTS, ASSEMBLED AT RUN TIME:
 *   - the standing rules, which never change between runs;
 *   - the memory block (memory.js), which does. It is appended only when the
 *     store has something in it, and the same function reports what it carried
 *     so the console says "memory ← src/memory.md - 2 memories" before step 1.
 *
 * This is prompt engineering you can diff: no template engine, no prompt file
 * loaded at runtime, no variables that only exist in a CMS somewhere.
 */
import { TOOL_NAMES } from './tools.js';
import { ui } from './ui.js';

/**
 * The standing rules. Written in the second person, in the order a run needs
 * them: look first, edit carefully, run what you wrote, stop when done, and
 * save what is worth keeping.
 *
 * Note rule 6: memory is a *tool call*, so a note that was worth keeping shows
 * up in the transcript like any other action - and "task progress" is refused
 * in words, because that is the failure mode of every naive memory feature.
 *
 * @param {string[]} tools the tool names the model may call
 * @returns {string}
 */
export function systemRules(tools = TOOL_NAMES) {
  return `You are a small coding agent working inside a sandboxed folder.

You have tools: ${tools.join(', ')}. Reads may use any path (relative paths start at your workspace root; absolute paths are allowed). Writing is fenced: save, edit and delete only work inside the workspace, and anything else is refused with FORBIDDEN - do not retry it, work inside the workspace instead.

How to work:
1. Look before you write: list_files / read_file before editing.
2. Prefer create_file for new files, edit_file for small changes, write_file only when replacing a whole file.
3. Every edit must use an old_string copied exactly from read_file output.
4. Run what you wrote with run_command and check the exit code. If it fails, read the error, fix it, run again.
5. Do not invent tool results. Stop calling tools when the task is done and reply with a short summary of what you changed.
6. If you learn something that will still be true next week - a command this repo needs, a preference the user stated, a trap you fell into - save it with remember. Never save task progress: "step 3 of 5" is not a memory, and it is worthless to the next run.

Be concise. One tool call per step where possible.`;
}

/**
 * The whole system message for one run: the rules, plus whatever earlier runs
 * left in `memory.md`.
 *
 * Why the memory lives here rather than in the loop: "what the model is told"
 * is one decision, made in one place. What does NOT fit still exists in the file
 * and is one `recall` call away, which is why the digest ends by saying so.
 *
 * @param {{memory?: object|null, log?: Function|null}} [options]
 *   memory  a Memory instance (memory.js); null means no long-term memory
 *   log     optional - when given, the "memory ← ..." line is printed here, next
 *           to the decision it describes, instead of at the call site
 * @returns {string} the content of the `system` message
 */
export function buildSystemPrompt({ memory = null, log = null } = {}) {
  const rules = systemRules();
  if (!memory) return rules;

  const digest = memory.digest();
  if (!digest) return rules;

  const injected = digest.split('\n').filter((line) => line.startsWith('- [')).length;
  log?.(ui.memory(
    `${memory.label} - ${injected} ${injected === 1 ? 'memory' : 'memories'} added to the system prompt`,
  ));

  return `${rules}\n\n${digest}`;
}
