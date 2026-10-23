# Setup for the Brighton Web Dev Meetup demos

Two separate demo projects live in this repo:

- **HTML-PAGES/** — vanilla HTML + JS demos that call the OpenRouter chat API straight from the browser.
- **mini-coding-agent/** — a minimal Python coding-agent harness (uv + `rich` + a real ReAct loop) that uses OpenRouter *function calling* to write, edit, read and run files.

Both share one thing: an OpenRouter API key, read at runtime from `OPENROUTER.txt` in the repo root (this file is git-ignored, so it holds no committed secrets).

---


## 0. Prereqs

Everything is standard, so there's little to install:

- OpenRouter account + API key → https://openrouter.ai/keys
- `uv` for the Python harness → https://docs.astral.sh/uv/ (or just use any venv + `pip install rich` — details below)
- Any modern browser for the HTML demos

No node/npm, no bundler, no build step anywhere.

---

## 1. The shared secret: `OPENROUTER.txt`

Create this file in the **repo root** (it's already git-ignored):

```
OPENROUTER_API_KEY=sk-or-...
MODEL="deepseek/deepseek-v4.1-flash"
```

The parser (both `config.js` and `agent.py`) is forgiving: quotes optional, `#` starts a comment, `KEY=VALUE` lines only. If `OPENROUTER_API_KEY` or `MODEL` is missing, the demos warn / fall back (the Python agent default model is `deepseek/deepseek-v4.1-flash`).

Never commit this file. If a key leaks, revoke it at https://openrouter.ai/keys and mint a new one.

---

## 2. HTML-PAGES — browser demos (JS)

Four standalone pages, no framework, no build. Each is a complete `fetch()` against
`https://openrouter.ai/api/v1/chat/completions`.

| File | Lesson |
|------|--------|
| `01.1-openai.html` | One-shot chat completion. Simplest case. |
| `01.2-openai-rag.html` | RAG-ish: extra context is inlined into the system prompt. |
| `03-openai-tool-calling.html` | Function calling loop (`get_weather`, `get_sum`) with a `tools` schema. |
| `04-chat-with-memory.html` | Multi-turn chat; history persisted to `localStorage`. |

### Run it

The critical gotcha: **`config.js` fetches `../OPENROUTER.txt` over HTTP, so you must serve the pages — double-clicking the file will not work** (a `file://` page can't read a sibling file, and the API request would hit CORS). Two options:

1. VS Code → right-click any `.html` → **Open with Live Server** (needs the Live Server extension).
2. From a terminal, serve the **repo root** (config.js resolves its path relative to the page):

   ```sh
   cd brighton-web-dev-meetup-nov-2026
   python -m http.server 8000
   # then open http://localhost:8000/HTML-PAGES/01.1-openai.html
   ```
   OR double clikc on HTML file

Because the page is served and the key lives in `OPENROUTER.txt`, the `apiKey` input pre-fills automatically — send a request and it works out of the box. You can still type a different key into the field (e.g. a throwaway) to override.

### How config.js works (if you touch it)

- Defines `OPENROUTER_API_URL`, the `../OPENROUTER.txt` path, and optional `X-Title` / `HTTP-Referer` attribution headers.
- Exposes `window.openRouterReady` (a promise) — every page `await`s it before reading `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`.
- There's no backend and no key server-side; the key goes in the `Authorization: Bearer` header straight from the browser. Fine for a local demo.

---

## 3. mini-coding-agent — Python harness

A single-file ReAct agent (`agent.py`, ~180 lines) whose only dependencies are `rich` for console output. The LLM gets the four tool schemas via OpenRouter function calling, and the loop runs

```
think -> emit tool_call -> execute locally -> feed result back -> repeat -> final answer
```

Tools the agent can invoke (all sandboxed to `mini-coding-agent/work/`):

- `write_file(path, content)`
- `edit_file(path, old, new)` — replaces first occurrence
- `read_file(path)`
- `run(command)` — `subprocess` shell cmd, cwd = `work/`

### Run it

```sh
cd mini-coding-agent

# quickest, if you have uv (creates .venv automatically from pyproject.toml)
uv run agent.py "write a hello world script and run it"

# pass nothing to get an interactive prompt
uv run agent.py

# override model / key via env if you don't want to touch OPENROUTER.txt
export OPENROUTER_API_KEY=sk-or-...
export MODEL=openai/gpt-4o-mini
uv run agent.py "fibonacci in python, then run it"
```

### Without uv

`pyproject.toml` only pulls in `rich`. Any of:

```sh
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install rich
python agent.py "hello world"
```

### Key resolution order

1. `OPENROUTER_API_KEY` / `MODEL` env vars, then
2. `../OPENROUTER.txt` (repo root), then
3. agent exits with an error if no key is found anywhere.

### Notes

- `max_steps` defaults to `8` turns (see `agent_loop(prompt, max_steps=8)`) — bump it for longer tasks.
- All agent file I/O is confined to `mini-coding-agent/work/`. `run()` inherits `shell=True` and is **not** sandboxed beyond that — a competent dev's demo box, not a security boundary. Don't run this against untrusted prompts.
- The `work/` dir is a scratchpad; empty it whenever you want a clean slate:
  ```sh
  rm -rf mini-coding-agent/work
  ```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| HTML demo shows "could not load ../OPENROUTER.txt" in the console | You opened the file via `file://`. Serve over HTTP (Live Server or `python -m http.server`). |
| Empty / quote-wrapped model name | `MODEL` needs a provider prefix, e.g. `deepseek/deepseek-v4.1-flash`; `config.js` warns if it's missing. |
| `data.error` in the result box | Bad key, revoked key, or maxed credits — check the message and https://openrouter.ai/activity. |
| `401 invalid key` | Extra spaces/quotes in `OPENROUTER.txt`, or a stale env var overriding it (unset `OPENROUTER_API_KEY`). |
| `402 insufficient credits` | Top up at https://openrouter.ai/credits or mint a key with a higher limit. |
| Agent exits with "No OPENROUTER_API_KEY found" | Create `OPENROUTER.txt` in the repo root, or export the env var. |

Models listed are examples — anything on OpenRouter works (e.g. swap `MODEL` in `OPENROUTER.txt`). Tool calling demos behave best with a model that reliably supports function calling.
