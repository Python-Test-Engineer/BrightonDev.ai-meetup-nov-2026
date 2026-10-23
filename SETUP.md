# Setup for the BrightonDev.ai Meetup demos

Everything in this repo is a **browser** demo: vanilla HTML + JS that calls the
OpenRouter chat API straight from the page. No backend, no build step.

One shared thing: an OpenRouter API key, read at runtime from `OPENROUTER.txt` in
the repo root. That file is git-ignored, so it holds no committed secrets — the
repo ships a template, `OPENROUTER_EXAMPLE.TXT`, that you rename to
`OPENROUTER.txt`.

---

## 0. Prereqs

- OpenRouter account + API key → https://openrouter.ai/keys
- Any modern browser
- Python (only to serve the pages over HTTP — `python -m http.server`)

No node/npm, no bundler, no build step anywhere.

---

## 1. The shared secret: rename the template to `OPENROUTER.txt`

The repo contains a committed template:

```
OPENROUTER_EXAMPLE.TXT
```

**Rename (or copy) it to `OPENROUTER.TXT` in the same folder — the repo root.** The
demos only read `OPENROUTER.txt`, so without the rename they'll warn that no key
was found. On Windows, Explorer may hide the extension, so check the name lands as
`OPENROUTER.TXT` and not `OPENROUTER.TXT.txt`.

Then edit the file to hold your real values:

```
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
```

`OPENROUTER_MODEL` needs a provider prefix (`vendor/model`), e.g.
`deepseek/deepseek-v4.1-flash` or `openai/gpt-4o-mini`. A bare `MODEL=` line is
also accepted as a legacy alias; `OPENROUTER_MODEL` wins when both are present.

The parser (`config.js`) is forgiving: quotes optional, `#` starts a comment, only
`KEY=VALUE` lines are read.

Never commit `OPENROUTER.txt`. If a key leaks, revoke it at
https://openrouter.ai/keys and mint a new one.

---

## 2. HTML-PAGES — browser demos (JS)

Six standalone pages, no framework, no build. Each is a complete `fetch()` against
`https://openrouter.ai/api/v1/chat/completions`, and all of them read
`../OPENROUTER.txt` through `config.js`.

| File | Lesson |
|------|--------|
| `01.1-basic.html` | One-shot chat completion. Simplest case. |
| `02-rag.html` | RAG-ish: extra context is inlined into the system prompt. |
| `03.0-tool-call-anthropic-animation.html` | Animated walkthrough of a tool-calling round trip. |
| `03.1-tool-calling.html` | Function calling loop (`get_weather`, `get_sum`) with a `tools` schema. |
| `04.1-chat-with-memory-animation.html` | Animated explainer for multi-turn memory. |
| `04.2-chat-with-memory.html` | Multi-turn chat; history persisted to `localStorage`. |

### Run it

The critical gotcha: **`config.js` fetches `../OPENROUTER.txt` over HTTP, so you must serve the pages — double-clicking the file will not work** (a `file://` page can't read a sibling file, and the API request would hit CORS). Two options:

1. VS Code → right-click any `.html` → **Open with Live Server** (needs the Live Server extension).
2. From a terminal, serve the **repo root** (config.js resolves its path relative to the page):

   ```sh
   cd BrightonDev.ai-meetup-nov-2026
   python -m http.server 8000
   # then open http://localhost:8000/HTML-PAGES/01.1-basic.html
   ```

Because the page is served and the key lives in `OPENROUTER.txt`, the `apiKey` input pre-fills automatically — send a request and it works out of the box. You can still type a different key into the field (e.g. a throwaway) to override.

### How config.js works (if you touch it)

- Defines `OPENROUTER_API_URL`, the `../OPENROUTER.txt` path, and optional `X-Title` / `HTTP-Referer` attribution headers.
- Exposes `window.openRouterReady` (a promise) — every page `await`s it before reading `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`.
- There's no backend and no key server-side; the key goes in the `Authorization` header straight from the browser. Fine for a local demo.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Console: "could not load ../OPENROUTER.txt" | You opened the file via `file://`. Serve over HTTP (Live Server or `python -m http.server`). |
| Console: no `OPENROUTER_API_KEY` found | The template wasn't renamed — the file must be exactly `OPENROUTER.TXT` in the repo root. |
| Empty / quote-wrapped model name | `OPENROUTER_MODEL` needs a provider prefix, e.g. `deepseek/deepseek-v4.1-flash`; `config.js` warns if it's missing. |
| `data.error` in the result box | Bad key, revoked key, or maxed credits — check the message and https://openrouter.ai/activity. |
| `401 invalid key` | Extra spaces/quotes in `OPENROUTER.txt`. |
| `402 insufficient credits` | Top up at https://openrouter.ai/credits or mint a key with a higher limit. |

Models listed are examples — anything on OpenRouter works (swap `OPENROUTER_MODEL`
in `OPENROUTER.txt`). Tool calling demos behave best with a model that reliably
supports function calling.
