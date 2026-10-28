# mini-coding-js

A coding agent in plain Node, built to show what an agent actually is: **an LLM in
a loop with tools and a sandbox**. The only dependency is `chalk`, and it only
draws the coloured output.

The loop itself is one ~200-line file (`src/agent.js`), of which ~120 lines are code:
no flags, no colours, no banner. Everything else - tools, the system prompt, the
sandbox, config, the console palette, lifecycle hooks, long-term memory, the scripted
demo and the CLI - is its own module, and `src/` comes to ~2370 lines. Small enough
to read on a projector, and split so that the file to teach from never grows.

```
        ┌─────────────┐
   ┌───▶│  model call │  system + messages + tools schema
   │    └──────┬──────┘
   │           │ tool_calls?
   │    ┌──────▼──────┐
   │    │  dispatcher │  validate args → run tool → string result
   │    └──────┬──────┘
   └───────────┘        result appended as { role: "tool", tool_call_id }
                │
                └── no tool_calls → final answer, stop
```

## Quickstart

```bash
cd mini-coding-js
npm install                 # one dependency: chalk (coloured output)

# Option A: reuse the .env already at the repo root - it is found automatically.
# Option B: create one at the repo root (or next to this package):
cp ../.env.example ../.env   # then add your OpenRouter key

npm start                  # then type the task at the "task ›" prompt
```

## Configuration at a glance

Everything is one env var, or a flag that overrides it. Vars are read from the
nearest `.env` — this package first, then up the tree to the repo root — and
anything `.env` does not define comes from your shell. **`.env` beats the shell**
on purpose (a stale key exported in `~/.bashrc` would otherwise win), and a CLI
flag beats both.

| Env var | Default | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` (alias `OPENROUTER_KEY`) | none — required unless `--demo` | the OpenRouter key; never logged, only fingerprinted |
| `OPENROUTER_MODEL` (alias `MODEL`) | `deepseek/deepseek-v4.1-flash-1017` | model slug; bare names like `gpt-5` are expanded to `vendor/model` |
| `OPENROUTER_PROVIDER_PREFIX` | unset | only to force the vendor when the bare-name guess is wrong |
| `CMD_POLICY` | `ask` | `allow` runs shell commands freely, `ask` prompts first, `deny` refuses them |
| `MAX_STEPS` | `12` | ReAct iterations before the loop stops and summarises |
| `REQUEST_TIMEOUT_MS` | `90000` | per model call, so a stalled request fails instead of hanging |
| `WORKSPACE_DIR` | `workspace` | the only folder the file tools may read and write |
| `MEMORY_FILE` | `src/memory.md` | the long-term memory file, relative to the package root (an absolute path points at a shared store) |
| `MEMORY_MAX_ENTRIES` | `60` | hard cap on memories; the oldest are dropped when it is reached |
| `MEMORY_PROMPT_CHARS` | `1200` | budget for the block of memory injected into the system prompt; `0` disables injection (`recall` still works) |

| Flag | Overrides |
|---|---|
| `--model anthropic/claude-sonnet-4.5` | `OPENROUTER_MODEL` |
| `--max-steps 6` | `MAX_STEPS` |
| `--yes` / `-y` / `--allow-commands` | `CMD_POLICY=allow` |
| `--demo` | nothing — scripted run, no network, no key needed |
| `--hooks` | nothing — prints every lifecycle hook (icon, colour, description) and exits |
| `--memory` | nothing — prints `src/memory.md` and the exact block it injects, then exits |
| `--no-memory` | nothing — one run with no long-term memory |
| `--no-hooks` | nothing — silences the `[HOOK:…]` trace lines (they print by default) |
| `--trace-hooks` | nothing — the explicit spelling of the default; harmless |

`src/config.js` resolves all of this and the startup banner prints what won and
where it came from; the details, banner example and alias rules are in
[Configuration and precedence](#configuration-and-precedence) below.

Anything that stops a run early - no task, a missing key, a failed request, the
step limit - is printed in red and sets a non-zero exit code (0 done, 1 request
failed, 2 no task, 3 step limit). The last line of a failed run spells out what
that code means instead of leaving a bare number on screen. While a model call is
in flight the console prints `… still waiting for the model (5s)` every five
seconds and the request is capped at `REQUEST_TIMEOUT_MS` (90s), so a slow
provider never looks like a frozen program.

With no task on the command line the agent takes it from an input field. A blank
line re-asks, Ctrl-C quits, and piped stdin cannot answer it (there is no
terminal), so that path stops in red instead of hanging. For scripts, pass the
task as an argument:

```bash
npm start -- "create hello.js that prints today's date and time, run it, and save its output to hello-output.txt"
```

Nothing else to install: Node 20+ and its built-in `fetch`, `node:child_process`
and `node:test` do the rest.

```bash
node src/cli.js                             live model, task typed at the prompt
node src/cli.js --demo                      # scripted run: the loop AND the sandbox guards
node src/cli.js "task" --yes                # auto-approve commands
node src/cli.js "task" --allow-commands     # same thing, as a flag
node src/cli.js "task" --max-steps 6        # tighter loop
node src/cli.js "task" --model anthropic/claude-sonnet-4.5
node src/cli.js --hooks                     # the lifecycle: every hook, icon, colour, why
node src/cli.js "task" --no-hooks           # silence the [HOOK:...] trace lines
node src/cli.js --memory                    # the memory store, and exactly what it injects
node src/cli.js "task" --no-memory          # one run with nothing remembered
node src/cli.js --help                      # usage summary
npm test                                      # 84 offline tests
```

`--model` beats `.env`, which beats your shell (next section). A bare model name
(`gpt-5`, `deepseek-v4.1-flash-1017`) is normalised to a `vendor/model` slug for you.

## Configuration and precedence

`src/config.js` looks for `.env` in `mini-coding-js/` first, then walks **up** the
directory tree, so the single `.env` at the repository root is picked up too. The
nearest `.env` wins; the path actually used is printed on the startup banner as
`env file : ...`, with `(missing)` appended when nothing was found.

**A value in `.env` beats the same variable exported in your shell.** That is on
purpose: a stale `OPENROUTER_API_KEY` in `~/.bashrc` would otherwise silently win
over the key you just wrote to `.env`. Variables `.env` does not mention still come
from the environment, and `--model` beats both.

The full list of variables and defaults is the table in
[Configuration at a glance](#configuration-at-a-glance) above. Two aliases are
worth repeating: `MODEL=` for `OPENROUTER_MODEL=` (older `.env` files in this repo
use that name) and `OPENROUTER_KEY=` for `OPENROUTER_API_KEY=`.

The startup banner shows both the value and where it came from, and says
`overrode the shell value` when your exported variable differed:

```
min-coding-js
workspace : ...\mini-coding-js\workspace
model     : deepseek/deepseek-v4.1-flash-1017 (from .env, overrode the shell value)
key       : sk-or...aaa5 (73 chars) from .env
env file  : ...\BrightonDev.ai-meetup-nov-2026\.env
commands  : ask
timeout   : 90s per model call
tools     : list_files, read_file, create_file, write_file, edit_file, run_command, remember, recall
memory    : src/memory.md (2 memories, newest 2026-10-28)
```

The key itself is never printed: only its first 5 and last 4 characters.

If `OPENROUTER_MODEL` is a bare name (`deepseek-v4.1-flash-1017`, `gpt-5`), it is
normalised to a `vendor/model` slug for OpenRouter and the banner says so; force a
vendor with `OPENROUTER_PROVIDER_PREFIX=...` if the guess is wrong.

## Files

Read them in that order: the loop first, then the two things it calls on every step,
then the extension points, then the program that runs it.

| File | Lines | What it shows |
|---|---|---|
| `src/agent.js` | ~200 | **the loop** - `runTask`: seven beats, nine hook call sites, one `for`. Nothing else. |
| `src/prompt.js` | ~80 | the system prompt: the standing rules, plus the memory block assembled at run time |
| `src/heartbeat.js` | ~35 | liveness: print "still waiting" every 5 s so a slow call never looks frozen |
| `src/tools.js` | ~415 | tool schemas the model reads + the dispatcher, the deny-list and the env allow-list |
| `src/hooks.js` | ~400 | the lifecycle: nine named moments, the registry, the `--hooks` catalogue and the live trace |
| `src/memory.js` | ~250 | long-term memory: `memory.md` as the store, the bounded digest, search, dedupe and caps |
| `src/demo.js` | ~140 | the scripted model for `--demo`, and the scorecard that checks the sandbox guards held |
| `src/cli.js` | ~350 | **the program** - flags, banner, input field, y/N confirm, `--hooks`/`--memory`, exit codes |
| `src/config.js` | ~195 | `.env` discovery and loading, model + policy + memory config |
| `src/workspace.js` | ~85 | path containment: the sandbox the file tools live in |
| `src/ui.js` | ~150 | the console palette (including every hook colour), plus the plain-English meaning of each exit code |
| `src/llm.js` | ~65 | one HTTP request to OpenRouter (with a timeout), and message sanitising |
| `test/` | ~1290 | offline tests for the loop, the prompt, the hooks, the demo's sandbox checks, the config, the tools, memory, the palette, the input field, the HTTP timeout and the path resolver |
| `src/memory.md` | - | the long-term memory store: markdown, one bullet per memory, readable and editable by hand |
| `workspace/` | - | the agent's only writable folder - everything it makes lands here |

`src/agent.js` is a **library**: it exports `runTask` and does nothing when you run it
(`node src/agent.js` prints where the program is). The program is `src/cli.js`, which
is what `npm start` runs. That split is the point - the file you teach from never
accumulates argument parsing, banners or exit codes.

## Coloured output

`src/ui.js` is the only file that knows about colour. Every line of output is one
`chalk` call in a named helper, so agent.js contains no colour at all:

```js
think: (text) => `${chalk.cyan('think:')} ${text}`
```

| Kind of line | Colour |
|---|---|
| banner title | bold cyan |
| banner labels (`workspace`, `model`, ...) | blue |
| `task ›` input field | green label, white caret |
| `… still waiting for the model (5s)` | bright yellow |
| step headings | blue |
| `think:` | cyan |
| `tool →` name and arguments | yellow / white |
| `result ←` | green, or red when the tool returned `ERROR`/`DENIED`/non-zero exit |
| `↳ stdout: ...` under `exit code 0` | dim - the first line the command printed |
| `↳ exit N: ...` under a failure | dim - what that exit code means in English |
| sandbox scorecard (`✓` / `✗`, `── sandbox checks ──`) | green / red checks, magenta heading |
| lifecycle hook trace (`[HOOK:Name] …`) | each hook's own colour (cyan `SessionStart`, bright yellow `PreToolUse`, green `PostToolUse`, red `SessionEnd`), icons in the margin; on by default |
| `memory ←` (what was carried into this run) | magenta label, white detail |
| final answer heading | bold green |
| warnings | bright yellow |
| failures | red |

Two things keep it honest. chalk styles the exact string it is given, so text from
the model or a tool is never re-read as markup: a file containing `<red>` prints
verbatim, and Windows paths and JSON keep their backslashes. Every helper returns
a string, so `runTask` still accepts an injected `log`. chalk also decides when
not to colour - a pipe, `NO_COLOR`, or `FORCE_COLOR` are all honoured, so
redirecting a run to a file gives clean text.

## The eight tools

Six of them change the workspace. Two change what the *next* process knows about it.

| Tool | Behaviour |
|---|---|
| `list_files` | recursive listing, depth 3 by default (max 6), skips `node_modules`/`.git`/`.venv`/`__pycache__` |
| `read_file` | line-numbered, paged (`offset`, `limit`) |
| `create_file` | **fails** if the file exists - forces the model to edit, not clobber |
| `write_file` | create or overwrite a whole file |
| `edit_file` | exact-snippet replace; 0 matches = error, >1 = error unless `replace_all` |
| `run_command` | shell in the workspace root, 30 s timeout, output capped at 6000 chars, `env` allow-listed, returns `exit code N` + streams |
| `remember` | append one durable note to `src/memory.md` (deduped, capped, dated) - survives the process |
| `recall` | search the whole memory file; the injected digest is only the newest few |

## Lifecycle hooks

The loop is fixed on purpose, but a fixed loop is not extensible: "log every
command", "never let it touch `.env`" and "tell me when it gives up" all used to
mean editing `agent.js`. `src/hooks.js` adds the smallest extension point that
fixes that - **nine named moments where your code gets a turn**, called by the
loop, able to observe, rewrite or block.

```bash
npm start                     # every run prints its lifecycle as [HOOK:Name] lines
npm run trace                 # node src/cli.js --demo (the trace is on by default)
npm run hooks                 # the whole lifecycle, with icons, colour and description
node src/cli.js "task" --no-hooks    # silence the trace lines
```

Every run prints the lifecycle as it happens - one grep-able line per moment, tagged
`[HOOK:Name]`, followed by what that moment is *for* and what this firing carried:

```
  🚀  [HOOK:SessionStart] once, before the first model call - Show the loop, then try to break the sandbox: ...
  ✍️  [HOOK:UserPromptSubmit] once, as the task enters the loop - Show the loop, then try to break the sandbox: ...

── step 1/12 ────────────────────────────────────────
  🧠  [HOOK:PreModel] before every model call - step 1/12 - 2 messages
  💬  [HOOK:PostModel] after every reply, before anything is dispatched - step 1 - tool_calls
think: Looking first: what is in the workspace, and what does the sandbox allow.
tool → list_files {"path":"."}
  🛠️  [HOOK:PreToolUse] before every tool call - list_files {"path":"."}
result ← .gitkeep  (72b)
  📦  [HOOK:PostToolUse] after every tool call - list_files - .gitkeep  (72b)
...
  🏁  [HOOK:Stop] the model answered and the loop is ending - 11 step(s) - Done. Created demo/hello.js, ...
  🔒  [HOOK:SessionEnd] always - every run ends here, finished or not - ok (answer) in 399ms
```

Each tag is painted in that hook's own colour, so the trace reads like the diagram
in the explainer. `--no-hooks` turns it off when you want the plain loop back.

| # | Hook | Icon | Fires | Can |
|---|---|---|---|---|
| 1 | `SessionStart` | 🚀 | once, before the first model call | refuse to start, or post a note |
| 2 | `UserPromptSubmit` | ✍️ | once, as the task enters the loop | rewrite the task, or block the run |
| 3 | `PreModel` | 🧠 | before every model call | observe (the request is assembled) |
| 4 | `PostModel` | 💬 | after every reply, before dispatch | observe (answer or tool call, visible first) |
| 5 | `PreToolUse` | 🛠️ | before every tool call | **block** - the tool never runs |
| 6 | `PostToolUse` | 📦 | after every tool call | **replace** the observation the model reads |
| 7 | `Stop` | 🏁 | the model answered | observe (summary, cost, notification) |
| 8 | `StepLimit` | ⏳ | the loop hit `maxSteps` | observe (escalate, dump the transcript) |
| 9 | `SessionEnd` | 🔒 | always - finished or not | observe (the last code to run) |

`node src/cli.js --hooks` prints exactly this table, generated from the same
`HOOK_EVENTS` array the loop fires - so the documentation cannot drift from the
code:

```
── lifecycle hooks - 9 moments in one run ──────────────────────
  A hook is a function attached to a named moment in the loop. agent.js calls each
  moment; a hook may observe, rewrite what the model reads, or block a call outright.

  🛠️  PreToolUse       before every tool call
      receives  name, args, step
      may       BLOCK - return { block: true, reason } and the tool never runs
      The one hook that changes what the agent is allowed to do. A permission layer
      lives here: inspect the arguments, refuse the call. ...

── the order one run fires them ────────────────────────────────
  1. SessionStart
  2. UserPromptSubmit
  3. [ PreModel → PostModel → PreToolUse → PostToolUse ]
  4. Stop | StepLimit
  5. SessionEnd
```

### Writing one

```js
import { runTask } from './agent.js';
import { Hooks, printHookCatalogue } from './hooks.js';

const hooks = new Hooks({ log: console.log });     // log = where broken-hook warnings go

// A permission layer: four tools, one folder, no surprises.
hooks.on('PreToolUse', ({ name, args }) => {
  if (name === 'run_command' && /(^|\s)(rm|del|format|shutdown)\b/.test(args)) {
    return { block: true, reason: 'destructive commands are not allowed here' };
  }
  return { note: `${name} was checked` };          // observe-only, and it prints
});

// Never let a key reach the model, whatever a command printed.
hooks.on('PostToolUse', ({ result }) => ({
  replace: String(result).replace(/sk-or-\S+/g, 'sk-or-[redacted]'),
}));

// Failures get a lifecycle too.
hooks.on('SessionEnd', ({ ok, reason, durationMs }) => ({ note: `run ${ok ? 'ok' : `failed (${reason})`} in ${durationMs}ms` }));

printHookCatalogue({ hooks });                     // mark what is attached
await runTask({ task, workspace, commandPolicy, maxSteps, chatFn, hooks });
```

Three rules hold it together:

1. **Observe, rewrite, or block - return nothing and the run is untouched.**
   `{ block: true, reason }` and `{ replace }` are the only two things that change
   the run; everything else is a note.
2. **A hook that throws is reported and ignored.** One broken hook must not take
   the loop with it - above all, every `tool_call_id` still gets a tool result, or
   the next request is invalid.
3. **A blocked tool call is an observation, not an exception.** The refusal goes
   back to the model as `DENIED: a PreToolUse hook blocked this call (...)`, so it
   can pick another route on the next step. The loop never crashes on a "no".

The trace at the top of this section is that mechanism at work: one observer per
event, registered by `traceHooks()`. The CLI attaches it by default - a `Hooks`
with nine observers, passed to `runTask` - and `--no-hooks` leaves it off.

## Long-term memory

`messages` is the agent's memory *within* a run and nothing more. Kill the process
and everything it learned is gone — including the expensive lessons ("the tests are
offline", "this repo spells it `Brighton`", "`git push --force` is refused"). A real
harness keeps a small file and puts a bounded slice of it in front of the model at
the start of the next run. That file is `src/memory.md` — beside the code, not inside the
sandbox, so you can open it in your editor and the agent can only reach it through the
`remember` tool. `src/memory.js` is the ~245 lines that read and write it.

```bash
npm start                      # a run starts by injecting the newest memories
node src/cli.js --memory     # the file, and exactly what the prompt gets
node src/cli.js "..." --no-memory   # amnesia, for one run
```

The store is markdown, one bullet per memory, and the bullet *is* the record:

```markdown
# memory

Long-term notes this agent keeps between runs. One bullet per memory:
`- [tag] text _(YYYY-MM-DD)_` where tag is fact | pref | fix | gotcha.

This file IS the store - edit it by hand, delete a wrong line, or commit it.
The agent reads a bounded slice at the start of a run and can search the rest
with the `recall` tool.

- [fact] The sandbox demo script lives at demo/hello.js and is safe to regenerate with create_file. _(2026-10-28)_
```

Three things follow from "the file is the store", and all three are deliberate:

1. **No cache, no index, no drift.** Every method reads the file. A hand edit, a
   deletion or a `git checkout` is picked up by the next call — there is no state
   that can disagree with the text on disk.
2. **It diffs like code.** `src/memory.md` is a normal file in the repo: it shows up in
   `git status`, it diffs cleanly, and a memory can be reviewed or deleted in a pull
   request. Point `MEMORY_FILE` at an absolute path to share one store across checkouts.
3. **You can audit it.** `--memory` prints the file and the injected block, so
   "what does it remember about me?" is a `cat`, not an interrogation.

There are two access paths, because they cost different things:

| Path | What it is | Cost |
|---|---|---|
| **eager** — `digest()` | the newest 12 entries, capped at 1200 chars, appended to the system prompt by `runTask` | fixed: it cannot grow with the file, so it cannot eat the context window |
| **lazy** — `recall` | a search over the whole file, on demand | one tool call, only when needed |

The digest always ends by saying what it left out, which is the difference between
"this is all I know" and "this is what fits — ask for the rest":

```
## What you remember from earlier runs
These notes live in src/memory.md and were learned before this task started.
Treat them as strong hints, not facts to trust blindly: the code may have moved on since.
- [gotcha] create_file refuses to overwrite, so re-running the demo fails at step 2. _(2026-10-24)_
- [fix] The demo script lives at demo/hello.js; delete it before a clean demo run. _(2026-10-28)_
- [pref] The user wants console output, not files, for anything under three lines. _(2026-10-28)_
(9 older memories not shown - search src/memory.md with the recall tool)
```

```js
// agent.js - the whole integration, at the top of runTask
const messages = [
  { role: 'system', content: buildSystemPrompt({ memory, log }) },  // rules + memory (prompt.js)
  { role: 'user', content: task },
];
const ctx = { workspace, commandPolicy, memory, confirm };
```

```js
// memory.js - a write is deduped, capped and dated, then the file is rewritten
remember(rawText, { tag = 'fact' } = {}) {
  const text = normalise(rawText).slice(0, this.options.rememberChars);
  const entry = { tag, text, date: today(this.now()) };

  const entries = this.entries();
  const key = text.toLowerCase();
  const existing = entries.findIndex((e) => e.text.toLowerCase() === key);
  if (existing !== -1) {                      // same note again: refresh the date
    entries[existing] = { ...entries[existing], date: entry.date, tag: entry.tag };
    this.save(entries);
    return { ok: true, duplicate: true, entry: entries[existing], total: entries.length };
  }

  entries.push(entry);
  const dropped = Math.max(0, entries.length - this.options.maxEntries);  // bounded, like maxSteps
  if (dropped) entries.splice(0, dropped);
  this.save(entries);
  return { ok: true, entry, dropped, total: entries.length };
}
```

A write from the model looks like this in the console, and the second run of the
same demo says `already remembered` instead of adding a duplicate:

```
tool → remember {"text":"The sandbox demo script lives at demo/hello.js and is safe to regenerate with create_file.","tag":"fact"}
result ← remembered in src/memory.md (3 total): - [fact] The sandbox demo script lives at demo/hello.js and is safe to regenerate with create_file. _(2026-10-28)_
```

The caps are the same argument as `maxSteps`, one level up: an unbounded memory file
is a context leak with a friendly name. `MEMORY_MAX_ENTRIES` (60) drops the oldest,
`MEMORY_PROMPT_CHARS` (1200) bounds the injection, 300 chars bound one entry, and
`MEMORY_PROMPT_CHARS=0` turns injection off while leaving `recall` working — which is
exactly the "retrieval instead of stuffing" trade-off, available as an env var.

What memory here is *not*: no embeddings, no vector search, no summarising, no write
on every turn. A model that writes a memory every step is a model filling your
context with its own diary. The system prompt says it plainly — durable facts only,
never task progress — and `remember` is a deliberate tool call, so it shows up in the
transcript like everything else.

## The AI principles it demonstrates

1. **Tool calling is the model's only ability to act.** The model cannot touch a
   file; it emits JSON naming a tool, and the harness executes it. Read
   `src/tools.js` top-to-bottom - the schema descriptions *are* prompt engineering.
2. **The loop is the agent.** Remove the `for` in `runTask` and you have a chatbot.
   Keep it and the model can look, act, observe, and try again.
3. **Everything is messages.** `messages` is the agent's whole working memory;
   the tool result string is what the model "sees". Nothing else carries state.
4. **Errors are observations, not crashes.** A failed edit comes back as
   `ERROR: old_string not found...` and the model corrects itself on the next
   step. Tool exceptions are caught in `runTool` and returned as text.
5. **Exit codes close the loop.** `run_command` reports `exit code 0` vs `1`,
   which is how the agent knows whether its code actually worked. Every non-zero
   code is printed with what it means (`127` = not on PATH, `137` = killed,
   `9009` = Windows "not recognised as a program"), so the audience is never left
   decoding a number.
6. **Human in the loop.** `CMD_POLICY=ask` (default) stops before every command;
   hard-deny patterns (`rm -rf /`, `del /s`, `format`, `shutdown`,
   `git push --force`, `curl | sh`, fork bombs) never run, whatever the policy says.
7. **Least privilege.** File tools are confined to `workspace/`; absolute paths,
   `..`, `~`, `%VAR%`, UNC paths and home/system folder names are refused before
   any `mkdir` happens. The child process gets a 13-name env allow-list rather than
   `process.env`, so a command cannot echo `OPENROUTER_API_KEY` into the transcript.
8. **Bounded autonomy.** `maxSteps` caps the loop; a truncated reply
   (`finish_reason: "length"`) is never dispatched as half a tool call - the model
   is told to continue with smaller calls instead.
9. **Extension points belong at named moments.** `src/hooks.js` gives nine of them
   (`SessionStart` … `SessionEnd`) and the loop calls all nine. Your code never
   edits the loop, and a hook that misbehaves is reported rather than fatal: that is
   the shape every real agent harness grows, at a size you can read in one sitting.
10. **Memory is a file, not a mystery.** `src/memory.js` keeps `memory.md`, injects a
    bounded slice of it into the system prompt and lets the model search the rest
    with `recall`. Durable facts only, capped in three places, identical across runs
    and readable by a human — the opposite of a stateful service you cannot inspect.

## Deliberate limits

- `run_command` is a real shell: it starts in `workspace/` but a command can walk
  out of that folder. The directory is not an OS sandbox - use a container if you
  need actual isolation.
- No context management: long runs will eventually exceed the model's window
  (each request is capped at `max_tokens: 2048`). The memory digest is bounded, but
  the `messages` array is not.
- No streaming, no sub-agents, no retries, no skills - all of those are layers on
  top of this loop, not replacements for it. `src/hooks.js` is the one extension
  point that IS here, and it is deliberately small: nine events, no configuration
  file, no plugin loading.
- Memory is one markdown file with substring search: no embeddings, no vector
  store, no automatic summarising, no write on every turn. It is the smallest thing
  that actually persists - and the honest answer to "why did it remember that?" is
  `node src/cli.js --memory`.
- With no TTY (piped input, CI) the `ask` policy degrades to deny: an unanswerable
  prompt never becomes an approval.

## Talk script (5 minutes)

```bash
node src/cli.js --demo
```

Narrate each line as it prints: *think → tool → result → think*. Then the demo
turns on the sandbox: a `../escape.txt` write and a `~/.ssh/id_rsa` read are
refused, `git push --force` is denied, a child process is asked for the API key and
finds nothing, and a failing command comes back as `exit code 1` with its meaning
spelled out. The run ends with a `sandbox checks` scorecard built from those same
tool results - and the process exits non-zero if any check regressed.

Then delete `workspace/demo/hello.js`, run it live with `--yes`, and finish by
asking the agent to do something it will fail at first (e.g. "edit hello.js to use
a variable called `msg`") so the audience sees the error come back as a tool result
and the model fix it on the next iteration.

With two minutes left, `node src/cli.js --hooks` puts the lifecycle on screen
(nine moments, icons, colours, one sentence each) &mdash; and the run you have just
watched printed the same nine as `[HOOK:Name]` lines, so the slide and the console
already agree. That is the "how would you extend this?" question, answered.

Then run the demo a second time: the banner says how many memories are on disk and a
`memory ← src/memory.md - 2 memories added to the system prompt` line appears before step 1,
because the `remember` call from the previous run outlived the process.
`node src/cli.js --memory` prints the file and the exact block the prompt received;
`--no-memory` gives you the amnesia run for comparison.

## Tests

```bash
npm test        # node --test: offline, no key, no network
```

84 tests cover the loop (including truncation and the max-steps stop), the lifecycle
hooks (every event documented, blocking, replacing, a throwing hook, the order a run
fires them in), the scripted demo's sandbox checks, `.env` discovery and precedence,
every tool's failure modes, the child-process env allow-list, the path resolver's
escape attempts, the palette (tag escaping, backslashes, red results, exit-code
explanations, the hook colours) and the input field (trimming, blank-line re-prompt,
closed input) - and long-term memory: a note surviving a second process, dedupe with a
refreshed date, the entry cap dropping the oldest, per-entry truncation, the digest
staying inside its character budget and saying what it hid, injection disabled by
`MEMORY_PROMPT_CHARS=0`, AND-search ordering, `forget`, hand-edited bullet parsing, an
absolute `MEMORY_FILE`, and the `remember`/`recall` tools with and without a store.
