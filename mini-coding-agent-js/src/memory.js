/**
 * memory.js - long-term memory: the one thing in this harness that survives the
 * process.
 *
 * WHY THIS FILE EXISTS: `messages` (chapter 5 of the explainer) is the agent's
 * memory *within* a run and nothing more. Kill the process and every lesson from
 * that run is gone - including the ones that were expensive to learn ("npm test
 * needs Node 20", "this repo spells it 'Brighton'", "never touch .env"). A real
 * harness keeps a small, human-readable file next to the code and puts a bounded
 * slice of it in front of the model at the start of the next run.
 *
 * WHERE IT LIVES: `src/memory.md`, beside this module - not inside the sandbox.
 * That is deliberate. The file is harness-owned: the agent reaches it only through
 * `remember` and `recall`, never through read_file/write_file, so it cannot be
 * clobbered mid-run and you can open it in your editor and read what it knows.
 * `MEMORY_FILE` moves it (an absolute path points at a shared store).
 *
 * THE DESIGN IN ONE PARAGRAPH: memory.md IS the store. There is no database, no
 * index and no cache - every method reads the file, so hand edits and deletions
 * are picked up on the next call and cannot drift from what the agent believes.
 * The file is plain markdown, one bullet per memory:
 *
 *     - [fact] The demo script lives in workspace/demo/hello.js. _(2026-10-28)_
 *
 * `[tag]` is fact | pref | fix | gotcha, the trailing date is when it was
 * learned, and the bullet is the whole record. That is deliberately the least
 * clever format that still parses: a human can read it, diff it in a PR, or
 * delete a wrong line by hand.
 *
 * THE TWO ACCESS PATHS (both matter, and they cost different things):
 *
 *   1. EAGER - `digest()` renders the newest N entries, capped at a character
 *      budget, and agent.js appends that block to the system prompt at
 *      SessionStart. Cheap, deterministic, and it is what makes the agent feel
 *      like it remembers you. Because it is bounded, it also cannot quietly eat
 *      the context window as the file grows.
 *   2. LAZY - the `recall` tool searches the whole file on demand, for the run
 *      that needs the six-month-old detail that did not fit in the digest.
 *
 * WRITE PATH: the model calls `remember`, which dedupes, trims to a per-entry
 * character cap and keeps only the newest `maxEntries`. That is the same
 * bounded-autonomy argument as `maxSteps`: an unbounded memory file becomes a
 * context leak with a friendly name.
 *
 * EXPORTS: Memory, MEMORY_FILE, MEMORY_TAGS, parseMemory(), formatEntry().
 */
import fs from 'node:fs';
import path from 'node:path';

/** Default filename, relative to the root you hand the store. */
export const MEMORY_FILE = 'src/memory.md';

/** The tags a memory can carry. Anything else is stored as `fact`. */
export const MEMORY_TAGS = ['fact', 'pref', 'fix', 'gotcha'];

const DEFAULTS = {
  maxEntries: 60,       // hard cap on the file: oldest entries are dropped
  maxEntryChars: 300,   // per-memory cap, so one essay cannot dominate the file
  rememberChars: 2000,  // a single `remember` call cannot be bigger than this
  promptChars: 1200,    // budget for the block injected into the system prompt
  promptEntries: 12,    // ...and at most this many newest entries in it
};

const HEADER = [
  '# memory',
  '',
  'Long-term notes this agent keeps between runs. One bullet per memory:',
  '`- [tag] text _(YYYY-MM-DD)_` where tag is fact | pref | fix | gotcha.',
  '',
  'This file IS the store - edit it by hand, delete a wrong line, or commit it.',
  'The agent reads a bounded slice at the start of a run and can search the rest',
  'with the `recall` tool.',
].join('\n');

/** Collapse whitespace, so two copies of "the  same\n thing" are one memory. */
const normalise = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** `2026-10-28`, in local time. Injectable so tests are not clock-dependent. */
function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** One entry as the single line it is stored as. */
export function formatEntry(entry) {
  return `- [${entry.tag}] ${entry.text} _(${entry.date})_`;
}

/**
 * Parse memory.md into entries. Anything that is not a bullet is ignored, which
 * is what makes hand-written prose, headings and comments safe in this file.
 *
 * @param {string} source file contents
 * @returns {{tag: string, text: string, date: string}[]} in file order (oldest first)
 */
export function parseMemory(source) {
  const entries = [];
  for (const line of String(source ?? '').split(/\r?\n/)) {
    // - [tag] text _(YYYY-MM-DD)_   (date optional: hand-added lines are fine)
    const m = line.match(/^\s*[-*]\s*\[([a-z]+)\]\s*(.+?)\s*(?:_\((\d{4}-\d{2}-\d{2})\)_)?\s*$/i);
    if (!m) continue;
    const text = normalise(m[2]);
    if (!text) continue;
    entries.push({ tag: m[1].toLowerCase(), text, date: m[3] ?? 'undated' });
  }
  return entries;
}

export class Memory {
  /**
   * @param {{root?: string, file?: string, maxEntries?: number, maxEntryChars?: number,
   *          promptChars?: number, promptEntries?: number, now?: () => Date}} [options]
   *   root   workspace root; a relative `file` resolves against it
   *   file   absolute, or relative to `root`. Default 'memory.md'
   *   now    clock injection for tests
   */
  constructor({ root = process.cwd(), file = MEMORY_FILE, ...options } = {}) {
    this.root = path.resolve(root);
    this.file = path.isAbsolute(file) ? file : path.join(this.root, file);
    this.options = { ...DEFAULTS, ...options };
    this.now = options.now ?? (() => new Date());
  }

  /** What the path looks like in a tool result: workspace-relative when it can be. */
  get label() {
    const rel = path.relative(this.root, this.file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : this.file;
  }

  get exists() {
    return fs.existsSync(this.file);
  }

  /** Always read from disk. A memory module with a cache is a memory module that lies. */
  entries() {
    if (!this.exists) return [];
    return parseMemory(fs.readFileSync(this.file, 'utf8'));
  }

  get size() {
    return this.entries().length;
  }

  save(entries) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = entries.length ? entries.map(formatEntry).join('\n') : '';
    fs.writeFileSync(this.file, `${HEADER}\n\n${body}${body ? '\n' : ''}`, 'utf8');
    return this.file;
  }

  /**
   * Save a memory. Duplicates (same text, case and whitespace ignored) are not
   * appended twice - the date is refreshed instead, because "this is still true"
   * is useful information and a duplicated bullet is not.
   *
   * @returns {{ok: boolean, duplicate?: boolean, dropped?: number, entry: object, total: number, reason?: string}}
   */
  remember(rawText, { tag = 'fact' } = {}) {
    const text = normalise(rawText).slice(0, this.options.rememberChars);
    if (!text) return { ok: false, reason: 'nothing to remember - the note was empty', total: this.size };

    const entry = {
      tag: MEMORY_TAGS.includes(tag) ? tag : 'fact',
      text: text.slice(0, this.options.maxEntryChars),
      date: today(this.now()),
    };

    const entries = this.entries();
    const key = text.toLowerCase();
    const existing = entries.findIndex((e) => e.text.toLowerCase() === key);

    if (existing !== -1) {
      entries[existing] = { ...entries[existing], date: entry.date, tag: entry.tag };
      this.save(entries);
      return { ok: true, duplicate: true, entry: entries[existing], total: entries.length };
    }

    entries.push(entry);
    // Bounded on purpose: keep the newest maxEntries, drop the oldest.
    const dropped = Math.max(0, entries.length - this.options.maxEntries);
    if (dropped) entries.splice(0, dropped);
    this.save(entries);

    return { ok: true, entry, dropped, total: entries.length };
  }

  /** Delete every entry whose text contains `match` (case-insensitive). */
  forget(match) {
    const needle = normalise(match).toLowerCase();
    if (!needle) return { removed: 0, total: this.size };

    const entries = this.entries();
    const kept = entries.filter((e) => !e.text.toLowerCase().includes(needle));
    const removed = entries.length - kept.length;
    if (removed) this.save(kept);
    return { removed, total: kept.length };
  }

  /**
   * Search the whole file - the LAZY access path, behind the `recall` tool.
   * Every word in the query must appear, so "node version" is narrower than
   * "node". Newest first, because a recent fix usually beats an old fact.
   *
   * @returns {{tag: string, text: string, date: string}[]} newest first
   */
  search(query, { limit = 20 } = {}) {
    const words = normalise(query).toLowerCase().split(' ').filter(Boolean);
    const all = this.entries().reverse();
    const hits = words.length
      ? all.filter((e) => words.every((w) => e.text.toLowerCase().includes(w) || e.tag === w))
      : all;
    return hits.slice(0, Math.max(1, Number(limit) || 20));
  }

  /**
   * The block agent.js appends to the system prompt. Bounded twice - by entry
   * count and by characters - and it says what it left out, so a model that
   * needs an older memory knows `recall` exists rather than assuming it is gone.
   *
   * @returns {string} '' when there is nothing to say (no file, no entries)
   */
  digest({ entries = this.options.promptEntries, chars = this.options.promptChars } = {}) {
    const all = this.entries();
    if (!all.length || chars <= 0) return '';

    const newest = all.slice(-Math.max(1, entries)).reverse();
    const lines = [];
    let used = 0;
    for (const entry of newest) {
      const line = formatEntry(entry);
      if (used + line.length + 1 > chars) break;
      lines.push(line);
      used += line.length + 1;
    }

    const hidden = all.length - lines.length;
    const tail = hidden > 0 ? `\n(${hidden} older ${hidden === 1 ? 'memory' : 'memories'} not shown - search ${this.label} with the recall tool)` : '';

    return [
      '## What you remember from earlier runs',
      `These notes live in ${this.label} and were learned before this task started.`,
      'Treat them as strong hints, not facts to trust blindly: the code may have moved on since.',
      ...lines,
      tail.trim() ? tail : '',
    ].filter((line) => line !== '').join('\n');
  }

  /** A one-line summary for the startup banner. */
  summary() {
    const count = this.size;
    return `${this.label} (${count} ${count === 1 ? 'memory' : 'memories'}${count ? `, newest ${this.entries().at(-1).date}` : ''})`;
  }
}
