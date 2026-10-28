/**
 * demo.js - the scripted fallback: the same loop, the same dispatcher, the same
 * guards, no network. For when conference wifi decides to test you.
 *
 * WHY THIS FILE EXISTS: a live coding agent needs a key, a model and a network.
 * A talk needs none of those. `demoChat()` is a fake model that returns a fixed
 * list of replies, so `--demo` exercises every real seam - the loop, the hook
 * call sites, the tool dispatcher, the sandbox refusals, the memory tools -
 * without one HTTP request.
 *
 * THE SCRIPT HAS THREE PARTS, on purpose:
 *   steps 1-5   ordinary work: create, run, edit, run again
 *   steps 6-10  deliberate escapes: path traversal, a home-folder read, a force
 *               push, an API-key echo, a failing command
 *   steps 11-12 the only two calls whose effect survives the process: remember
 *               and recall
 *
 * The refusals are SHOWN rather than described, and `sandboxScorecard()` reads
 * the run's own tool results back to prove each guard actually held - a claim
 * you can check, printed by the program, instead of a slide that says "trust me".
 */

/** One OpenAI-shaped tool call: `{ id, type, function: { name, arguments } }`. */
function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** The task the demo prints in its banner when none was given. */
export const DEMO_TASK = 'Show the loop, then try to break the sandbox: create a script, run it, edit it, '
  + 'run it again, then attempt a path escape, a home-folder read, a force push and an API-key echo.';

/** What the fake model says, in order. Each entry becomes one assistant message. */
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

/**
 * A `chatFn` with the same shape as the real one (`{ choices: [{ message }] }`),
 * so it can be handed to `runTask` unchanged. It walks DEMO_SCRIPT once and then
 * repeats the final answer, which is what lets the loop take its `calls.length
 * === 0` exit.
 */
export function demoChat() {
  let i = 0;
  return async () => {
    const message = DEMO_SCRIPT[Math.min(i, DEMO_SCRIPT.length - 1)];
    i += 1;
    return {
      choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    };
  };
}
