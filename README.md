# BrightonDev.ai Meetup — Nov 2026

Live-coding materials for a talk on AI agents and coding agents: browser demos that
call the OpenRouter chat API directly, plus the talk's notes and supporting material.

## Demos

- **`HTML-PAGES/`** — Vanilla HTML + JS demos that call
  `https://openrouter.ai/api/v1/chat/completions` directly from the browser.
  Covers plain chat, RAG (context in the system prompt), tool calling, and
  chat-with-memory. The current pages are `01-basic.html`, `02-rag.html`,
  `03.1-tool-call-anthropic-animation.html`, `03.2-tool-calling.html`,
  `04.1-chat-with-memory-animation.html`, and `04.2-chat-with-memory.html`.
  `anthropic-ui.css` contains their shared visual styles.
- **`main.py`** — placeholder entry point for the uv project (`uv run main.py`).

## Notes & support material

- **`TALK.md`** / **`TALK.html`** — the talk "slides"/notes, in Markdown and as a
  self-contained HTML deck.
- **`HTML-EXPLAINERS/`** — write-ups explaining each HTML page plus the
  talk's supporting PDFs/screenshots.
- **`NOTES-BRIGHTON-DEV-AI.md`**, **`coding_an_agentic_workforce.md`** — talk
  notes and background reading.
- **`LINKS-WITH-DESCRIPTIONS.md`** — all links referred to in the talk, and extras.
- **`HERMES-KEYS-MANGEMENT.md`** / **`OPENROUTER.TXT`** — API key management
  notes and the runtime key file (git-ignored).
- **`why_temp_equal_zero_not_deterministic.md`** — the temperature/`temp=0`
  explainer referenced in the talk.
- `01-REST-API.png`, `qr.png`, `images/` — demo and asset screenshots.

## Getting started

The demos need an OpenRouter API key, read at runtime from `OPENROUTER.txt` in the
repo root. That file is git-ignored; the repo ships a template instead.

**Rename `OPENROUTER_EXAMPLE.TXT` → `OPENROUTER.TXT`** (same folder, repo root) and
put your key and model in it:

```
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
```

See **`SETUP.md`** for the full walkthrough: creating that file, serving the HTML
pages over HTTP (required — they won't load from `file://`), and troubleshooting.

## Quick start

```sh
# 1. Rename the template and add your key (see SETUP.md)
#    OPENROUTER_EXAMPLE.TXT -> OPENROUTER.TXT
#    then fill in OPENROUTER_API_KEY and OPENROUTER_MODEL

# 2. Browser demos (serve from repo root)
python -m http.server 8000
# open http://localhost:8000/HTML-PAGES/01-basic.html

# 3. Talk slides
# open TALK.html in a browser, or read TALK.md
```
