# mini-coding-js

A coding agent in plain Node, built to show what an agent actually is: **an LLM in
a loop with tools and a sandbox**. The only dependency is `chalk`, and it only
draws the coloured output.

The loop itself is one ~410-line file (`src/agent.js`); tools, sandbox, config and
the console theme bring `src/` to ~1200 lines. Small enough to read on a projector
during a talk.

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

| Flag | Overrides |
|---|---|
| `--model anthropic/claude-sonnet-4.5` | `OPENROUTER_MODEL` |
| `--max-steps 6` | `MAX_STEPS` |
| `--yes` / `-y` / `--allow-commands` | `CMD_POLICY=allow` |
| `--demo` | nothing — scripted run, no network, no key needed |

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
node src/agent.js                             live model, task typed at the prompt
node src/agent.js --demo                      # scripted run: the loop AND the sandbox guards
node src/agent.js "task" --yes                # auto-approve commands
node src/agent.js "task" --allow-commands     # same thing, as a flag
node src/agent.js "task" --max-steps 6        # tighter loop
node src/agent.js "task" --model anthropic/claude-sonnet-4.5
node src/agent.js --help                      # usage summary
npm test                                      # 45 offline tests
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
tools     : list_files, read_file, create_file, write_file, edit_file, run_command
```

The key itself is never printed: only its first 5 and last 4 characters.

If `OPENROUTER_MODEL` is a bare name (`deepseek-v4.1-flash-1017`, `gpt-5`), it is
normalised to a `vendor/model` slug for OpenRouter and the banner says so; force a
vendor with `OPENROUTER_PROVIDER_PREFIX=...` if the guess is wrong.

## Files

| File | Lines | What it shows |
|---|---|---|
| `src/agent.js` | ~410 | the ReAct loop, system prompt, CLI, input field, heartbeat, scripted demo + sandbox scorecard |
| `src/tools.js` | ~350 | tool schemas the model reads + the dispatcher, the deny-list and the env allow-list |
| `src/config.js` | ~170 | `.env` discovery and loading, model + policy config |
| `src/workspace.js` | ~85 | path containment: the sandbox the file tools live in |
| `src/ui.js` | ~110 | the console palette, plus the plain-English meaning of each exit code |
| `src/llm.js` | ~65 | one HTTP request to OpenRouter (with a timeout), and message sanitising |
| `test/` | ~610 | offline tests for the loop, the demo's sandbox checks, the config, the tools, the palette, the input field, the HTTP timeout and the path resolver |
| `workspace/` | - | the agent's only writable folder - everything it makes lands here |

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
| final answer heading | bold green |
| warnings | bright yellow |
| failures | red |

Two things keep it honest. chalk styles the exact string it is given, so text from
the model or a tool is never re-read as markup: a file containing `<red>` prints
verbatim, and Windows paths and JSON keep their backslashes. Every helper returns
a string, so `runTask` still accepts an injected `log`. chalk also decides when
not to colour - a pipe, `NO_COLOR`, or `FORCE_COLOR` are all honoured, so
redirecting a run to a file gives clean text.

## The six tools

| Tool | Behaviour |
|---|---|
| `list_files` | recursive listing, depth 3 by default (max 6), skips `node_modules`/`.git`/`.venv`/`__pycache__` |
| `read_file` | line-numbered, paged (`offset`, `limit`) |
| `create_file` | **fails** if the file exists - forces the model to edit, not clobber |
| `write_file` | create or overwrite a whole file |
| `edit_file` | exact-snippet replace; 0 matches = error, >1 = error unless `replace_all` |
| `run_command` | shell in the workspace root, 30 s timeout, output capped at 6000 chars, `env` allow-listed, returns `exit code N` + streams |

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

## Deliberate limits

- `run_command` is a real shell: it starts in `workspace/` but a command can walk
  out of that folder. The directory is not an OS sandbox - use a container if you
  need actual isolation.
- No context management: long runs will eventually exceed the model's window
  (each request is capped at `max_tokens: 2048`).
- No streaming, no sub-agents, no retries, no skills, no memory - all of those are
  layers on top of this loop, not replacements for it.
- With no TTY (piped input, CI) the `ask` policy degrades to deny: an unanswerable
  prompt never becomes an approval.

## Talk script (5 minutes)

```bash
node src/agent.js --demo
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

## Tests

```bash
npm test        # node --test: offline, no key, no network
```

45 tests cover the loop (including truncation and the max-steps stop), the scripted
demo's sandbox checks, `.env` discovery and precedence, every tool's failure modes,
the child-process env allow-list, the path resolver's escape attempts, the palette
(tag escaping, backslashes, red results, exit-code explanations) and the input field
(trimming, blank-line re-prompt, closed input).
