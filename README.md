# BrightonDev.ai Meetup — Nov 2026

Live-coding materials for a talk on AI agents and coding agents. Two runnable demo
projects, both calling the OpenRouter chat API, plus the talk's supporting notes.

## Projects

- **`HTML-PAGES/`** — Vanilla HTML + JS demos that call
  `https://openrouter.ai/api/v1/chat/completions` directly from the browser.
  Covers plain chat, RAG (context in the system prompt), tool calling, and
  chat-with-memory.
- **`mini-coding-agent/`** — A minimal single-file Python coding-agent harness
  (uv + `rich`). A real ReAct loop that uses OpenRouter *function calling* to
  write, edit, read and run files in a `work/` scratch dir.

## Notes & support material

- **`HTML-EXPLAINERS/`** — write-ups explaining each HTML page plus the
  talk's supporting PDFs/screenshots.
- **`NOTES-BTN-WEB-DEV-MEETUP.md`** — the talk "slides"/notes.
- **`LINKS.md`** — all links referred to in the talk, and extras.
- **`api.md`** / **`OPENROUTER.txt`** — API key management notes and the
  runtime key file (git-ignored).
- `app-*.png`, `images/` — demo and asset screenshots.

## Getting started

Both demos need an OpenRouter API key and read it from `OPENROUTER.txt` in the
repo root. See **`SETUP.md`** for the full setup: creating that file, serving the
HTML pages over HTTP (required — they won't load from `file://`), running the
Python agent with `uv run agent.py "..."`, and troubleshooting.

## Quick start

```sh
# 1. Add your key (see SETUP.md)
#    OPENROUTER_API_KEY=sk-or-... and MODEL=... in OPENROUTER.txt

# 2. Browser demos (serve from repo root)
python -m http.server 8000
# open http://localhost:8000/HTML-PAGES/01.1-openai.html

# 3. Python coding agent
cd mini-coding-agent
uv run agent.py "write a hello world script and run it"
```
