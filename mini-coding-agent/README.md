# mini-coding-agent

A coding agent in about 300 lines of Node, with no dependencies, built to show what
an agent actually is: **an LLM in a loop with tools and a sandbox**.

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
cd min-coding-agent
cp .env.example .env        # add your OpenRouter key
npm start -- "create hello.js that prints today's date and time, run it and save to current folder with a random number between 100 and 999 as hellloNNN.js where NNN is that random number printing out in console location of the file and use that for the saved output as hello-output-NNN.txt"                
```

No install step: there are zero dependencies (Node 20+, uses built-in `fetch`,
`node:child_process`, `node:test`).

```bash
node src/agent.js --demo                      # scripted run, no network, no key
node src/agent.js "task" --yes                # auto-approve commands
node src/agent.js "task" --max-steps 6        # tighter loop
node src/agent.js "task" --model anthropic/claude-sonnet-4.5
node src/agent.js "task"      # read/write only, no shell
npm test                                      # 24 offline tests
```

## Configuration and precedence

`src/config.js` looks for `.env` in `min-coding-agent/` first, then walks **up** the
directory tree, so the single `.env` at the repository root is picked up too. The
nearest `.env` wins; the path actually used is shown on the startup banner as
`env file : ...`.

**A value in `.env` beats the same variable exported in your shell.** That is on
purpose: a stale `OPENROUTER_API_KEY` in `~/.bashrc` would otherwise silently win
over the key you just wrote to `.env`. Variables `.env` does not mention still come
from the environment, and `--model` beats both.

| Variable | Default |
|---|---|
| `OPENROUTER_API_KEY` | required (live mode) |
| `OPENROUTER_MODEL` or `MODEL` | `deepseek/deepseek-v4.1-flash-1017` |
| `CMD_POLICY` | `ask` (`allow` / `ask` / `deny`) |
| `MAX_STEPS` | `12` |
| `WORKSPACE_DIR` | `workspace` |

`MODEL=` is accepted as an alias for `OPENROUTER_MODEL=` (older `.env` files in this
repo use that name); tell-me-what-won precedence is printed on every start.

The startup banner shows both the value and where it came from, and says
`overrode the shell value` when your exported variable differed:

```
model     : deepseek/deepseek-v4.1-flash-1017 (from .env, overrode the shell value)
key       : sk-or...aaa5 (73 chars) from .env, overrode the shell value
```

The key itself is never printed: only its first 5 and last 4 characters.

If `OPENROUTER_MODEL` is a bare name (`deepseek-v4.1-flash-1017`, `gpt-5`), it is
normalised to a `vendor/model` slug for OpenRouter and the banner says so; force a
vendor with `OPENROUTER_PROVIDER_PREFIX=...` if the guess is wrong.

## Files

| File | What it shows |
|---|---|
| `src/agent.js` | the ReAct loop, system prompt, CLI, scripted demo fallback |
| `src/tools.js` | tool schemas the model reads + the dispatcher that runs them |
| `src/workspace.js` | path containment: the sandbox the file tools live in |
| `src/llm.js` | one HTTP request to OpenRouter, and why assistant messages get sanitised |
| `src/config.js` | env / `.env` loading, model + policy config |
| `test/` | offline tests for the loop, the tools and the path resolver |
| `workspace/` | the agent's only writable folder - everything it makes lands here |

## The six tools

| Tool | Behaviour |
|---|---|
| `list_files` | recursive listing, depth-capped, skips `node_modules`/`.git` |
| `read_file` | line-numbered, paged (`offset`, `limit`) |
| `create_file` | **fails** if the file exists - forces the model to edit, not clobber |
| `write_file` | create or overwrite a whole file |
| `edit_file` | exact-snippet replace; 0 matches = error, >1 = error unless `replace_all` |
| `run_command` | shell in the workspace root, 30 s timeout, returns `exit code N` + streams |

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
   which is how the agent knows whether its code actually worked.
6. **Human in the loop.** `CMD_POLICY=ask` (default) stops before every command;
   hard-deny patterns (`rm -rf /`, `git push --force`, `curl | sh`) never run.
7. **Least privilege.** File tools are confined to `workspace/`; absolute paths,
   `..`, `~`, `%VAR%`, UNC paths and home/system folder names are refused before
   any `mkdir` happens.
8. **Bounded autonomy.** `maxSteps` caps the loop; a truncated reply
   (`finish_reason: "length"`) is never dispatched as half a tool call.

## Deliberate limits

- `run_command` is a real shell: it starts in `workspace/` but a command can walk
  out of that folder. The directory is not an OS sandbox - use a container if you
  need actual isolation.
- No context management: long runs will eventually exceed the model's window.
- No streaming, no sub-agents, no retries, no skills, no memory - all of those are
  layers on top of this loop, not replacements for it.

## Talk script (5 minutes)

```bash
node src/agent.js --demo
```

Narrate each line as it prints: *think → tool → result → think*. Then delete
`workspace/demo/hello.js`, run it live with `--yes`, and finish by asking the agent
to do something it will fail at first (e.g. "edit hello.js to use a variable called
`msg`") so the audience sees the error come back as a tool result and the model fix
it on the next iteration.
