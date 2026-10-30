/**
 * sandbox.js - the write boundary: save, edit and delete, and nothing else.
 *
 * WHY THIS FILE EXISTS: workspace.js answers "does this path stay inside the
 * root?", which every READ also needs. This file answers a narrower, louder
 * question: may the agent *change* this file at all? A read that leaves the
 * sandbox is a bad idea; a write or a delete that leaves it is the incident.
 * So the three mutating actions - save, edit, delete - get their own gate, and
 * every refusal prints one line in bold red capitals:
 *
 *     ⛔ FORBIDDEN SAVE  ../escape.txt  - path escapes the workspace: ../escape.txt
 *
 * That line goes to the same console stream as the [HOOK:Name] lifecycle trace,
 * so on stage the refusal is part of the run's narration rather than an
 * exception that scrolled past in a stack trace. The path policy itself is
 * workspace.js's - this module never re-implements it, it only decides which
 * actions are sandboxed and what happens when one is refused.
 *
 * THE CONTRACT: `check()` returns `{ abs, rel }` or throws ForbiddenError (after
 * printing). Everything that writes goes through it, so "was this allowed?"
 * has exactly one answer in the whole program.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Workspace, PathError } from './workspace.js';
import { ui } from './ui.js';

/** The default sandbox: `mini-coding-agent-js/workspace`, next to the code. */
export const SANDBOX_DIR = path.resolve(import.meta.dirname, '..', 'workspace');

/** The only three things a sandboxed agent may do to a file. */
export const ACTIONS = Object.freeze({
  SAVE: 'save',
  EDIT: 'edit',
  DELETE: 'delete',
});

const ALLOWED = new Set(Object.values(ACTIONS));

/** A refusal: thrown after the FORBIDDEN line has been printed. */
export class ForbiddenError extends Error {
  constructor(action, requested, reason) {
    // The same shape as the console line, so the model's observation and the
    // human's terminal say the same thing: "SAVE ../x - path escapes ...".
    super(`${String(action).toUpperCase()} ${requested} - ${reason}`);
    this.name = 'ForbiddenError';
    this.code = 'FORBIDDEN';
    this.action = action;
    this.requested = String(requested ?? '');
    this.reason = reason;
  }
}

/**
 * The sandbox. One per run, handed to the tools through `ctx.sandbox`.
 *
 * @param {object} [options]
 * @param {Workspace} [options.workspace] the path policy to reuse
 * @param {string} [options.root]         sandbox dir, when there is no Workspace yet
 * @param {(line: string) => void} [options.log] where FORBIDDEN lines are printed
 */
export class Sandbox {
  constructor({ workspace = null, root = null, log = console.log } = {}) {
    // A Workspace is just a resolved root plus a resolve(); reusing the one the
    // run already made means reads and writes can never disagree about the root.
    this.workspace = workspace ?? new Workspace(root ?? SANDBOX_DIR);
    this.root = this.workspace.root;
    this.log = log;
    /** How many requests this sandbox has refused - shown in the session summary. */
    this.refusals = 0;
  }

  /** Whether an action is one the sandbox governs at all. */
  static allowsAction(action) {
    return ALLOWED.has(action);
  }

  /**
   * Print the refusal and throw. Called from `check()`, so it is the one place
   * a FORBIDDEN line can come from.
   */
  forbid(action, requested, reason) {
    this.refusals += 1;
    this.log(ui.forbidden(action, requested, reason));
    throw new ForbiddenError(action, requested, reason);
  }

  /**
   * Resolve a path for one of save/edit/delete, or refuse and shout about it.
   *
   * @param {'save'|'edit'|'delete'} action
   * @param {string} requested path as the model wrote it
   * @returns {{abs: string, rel: string}}
   * @throws {ForbiddenError} for anything outside the sandbox
   */
  check(action, requested) {
    if (!ALLOWED.has(action)) {
      throw new TypeError(`unknown sandbox action "${action}". Allowed: ${[...ALLOWED].join(', ')}`);
    }

    let target;
    try {
      target = this.workspace.resolve(requested);
    } catch (err) {
      if (err instanceof PathError) this.forbid(action, requested, err.message);
      throw err;
    }

    // The root itself is not a file: deleting it would take the sandbox with it.
    if (action === ACTIONS.DELETE && target.rel === '.') {
      this.forbid(action, requested, 'the sandbox root itself cannot be deleted');
    }

    return target;
  }

  /** Write a file that `check()` already allowed. Parent folders are created. */
  write(target, content) {
    const existed = fs.existsSync(target.abs);
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.writeFileSync(target.abs, String(content), 'utf8');
    return { ...target, existed, bytes: Buffer.byteLength(String(content)) };
  }

  /** Save (create or overwrite) a path relative to the sandbox root. */
  save(requested, content) {
    return this.write(this.check(ACTIONS.SAVE, requested), content);
  }

  /**
   * Delete a file, or an empty folder, inside the sandbox.
   * @returns {{abs: string, rel: string, dir: boolean}}
   */
  remove(requested) {
    const target = this.check(ACTIONS.DELETE, requested);
    if (!fs.existsSync(target.abs)) {
      return { ...target, missing: true, dir: false };
    }
    const dir = fs.statSync(target.abs).isDirectory();
    if (dir) fs.rmdirSync(target.abs); // only succeeds when empty, on purpose
    else fs.unlinkSync(target.abs);
    return { ...target, missing: false, dir };
  }

  /**
   * Check the write targets a shell command names, and refuse the ones outside.
   * Best effort: it reads the command line, not the code inside a script.
   *
   * @param {string} command the command line about to run
   * @returns {{ok: boolean, targets: {verb: string, target: string}[]}}
   * @throws {ForbiddenError} when a target lands outside the sandbox
   */
  checkCommand(command) {
    const targets = shellWriteTargets(command);
    const refused = [];

    for (const { verb, target } of targets) {
      try {
        this.workspace.resolve(target);
      } catch (err) {
        if (!(err instanceof PathError)) throw err;
        this.refusals += 1;
        this.log(ui.forbidden(verb, target, err.message));
        refused.push(`${String(verb).toUpperCase()} ${target}`);
      }
    }

    if (refused.length) {
      throw new ForbiddenError('command', refused.join(', '), 'the shell would write outside the sandbox');
    }
    return { ok: true, targets };
  }

  /** One line for a banner or a summary: what is allowed, and where. */
  summary() {
    return `save, edit, delete - only inside ${this.root}`;
  }
}

/** Convenience: the sandbox a tool context already carries, or a fresh default. */
export function sandboxFor(ctx = {}) {
  return ctx.sandbox ?? new Sandbox({ workspace: ctx.workspace, log: ctx.log ?? console.log });
}

/* ------------------------------------------------------------------ *
 * Shell writes: best effort, and honest about it.
 *
 * `run_command` is a real shell, so it is not the sandbox - but the obvious
 * ways to move a file out of the workspace are spelled out in the command
 * line: a redirection, a `copy`/`move` destination, the operands of `del`/`rm`,
 * `curl -o`, a PowerShell cmdlet. Those get checked before the command runs.
 *
 * What this is NOT: a sandbox for the shell. `node -e "fs.copyFileSync(...)"`
 * or a downloaded script can still write anywhere, and the module says so
 * rather than pretending otherwise. A container is the answer to that.
 * ------------------------------------------------------------------ */

const SEPARATORS = new Set(['|', '&&', '||', ';', '&']);

/** Commands whose LAST positional argument is where the data lands. */
const DEST_LAST = new Set(['copy', 'cp', 'move', 'mv', 'xcopy', 'ren', 'rename', 'ln', 'install', 'scp', 'rsync']);

/** Commands where every positional argument names something written or removed. */
const ALL_POSITIONAL = new Set(['del', 'erase', 'rd', 'rmdir', 'rm', 'md', 'mkdir', 'touch', 'tee', 'unlink', 'truncate', 'shred']);

/** Downloaders: the argument after one of these flags is the output file. */
const OUTPUT_FLAG = {
  curl: ['-o', '--output', '-O', '--remote-name'],
  wget: ['-O', '--output-document'],
};

/** PowerShell cmdlets that write, and the flags that name their target. */
const PS_CMDLETS = new Set(['out-file', 'set-content', 'add-content', 'new-item', 'ni', 'remove-item', 'copy-item', 'move-item', 'rename-item']);
const PS_TARGET_FLAGS = new Set(['-destination', '-dest', '-path', '-filepath', '-literalpath']);

/** A cmd switch like `/s` or `/q`; a POSIX path like `/home` is not a switch. */
const isFlag = (arg) => /^--?[A-Za-z]/.test(arg) || /^\/[A-Za-z?]{1,2}$/.test(arg);

/** The bare command name: no folders, no `.exe`, no `.cmd`, lower case. */
function commandName(token) {
  const base = String(token ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

/**
 * Split a command line into words and operators, honouring quotes.
 * Quotes are removed, so `"C:\\Program Files\\x"` stays one word.
 */
export function tokenizeCommand(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  const flush = () => {
    if (current !== '') {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === '>' || ch === '<' || ch === '|' || ch === '&' || ch === ';') {
      flush();
      const next = text[i + 1];
      if (ch === '>' && next === '>') {
        tokens.push('>>');
        i += 1;
        continue;
      }
      if ((ch === '&' || ch === '|') && next === ch) {
        tokens.push(ch + ch);
        i += 1;
        continue;
      }
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

/** The write targets named by one command segment (between separators). */
function scanSegment(tokens, targets) {
  const verb = commandName(tokens[0]);
  const args = tokens.slice(1);
  const positional = args.filter((arg) => !isFlag(arg));

  if (ALL_POSITIONAL.has(verb)) {
    for (const target of positional) targets.push({ verb, target });
    return;
  }
  if (DEST_LAST.has(verb)) {
    if (positional.length >= 2) targets.push({ verb, target: positional[positional.length - 1] });
    return;
  }
  if (verb === 'robocopy') {
    // robocopy <source> <destination> [files...]
    if (positional.length >= 2) targets.push({ verb, target: positional[1] });
    return;
  }
  const flags = OUTPUT_FLAG[verb];
  if (flags) {
    for (let i = 0; i < args.length; i += 1) {
      if (flags.includes(args[i]) && args[i + 1]) {
        // curl -O takes no argument: the URL's own filename is the output.
        targets.push({ verb, target: args[i].startsWith('-O') || args[i] === '--remote-name' ? positional[positional.length - 1] : args[i + 1] });
      }
    }
    return;
  }
  if (PS_CMDLETS.has(verb) || verb === 'powershell' || verb === 'pwsh' || verb === 'ps') {
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i].toLowerCase();
      if (PS_TARGET_FLAGS.has(flag) && args[i + 1]) targets.push({ verb, target: args[i + 1] });
      else if (PS_CMDLETS.has(commandName(args[i])) && args[i + 1] && !isFlag(args[i + 1])) {
        targets.push({ verb: commandName(args[i]), target: args[i + 1] });
      }
    }
  }
}

/**
 * Every path a command line visibly writes to or deletes.
 *
 * @param {string} command
 * @returns {{verb: string, target: string}[]} one entry per write target found
 */
export function shellWriteTargets(command) {
  const tokens = tokenizeCommand(String(command ?? ''));
  const targets = [];
  let segment = [];

  const flushSegment = () => {
    if (segment.length) scanSegment(segment, targets);
    segment = [];
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (SEPARATORS.has(token)) {
      flushSegment();
      continue;
    }
    if (token === '>' || token === '>>') {
      // "2> log.txt" tokenises as ["2", ">", "log.txt"]: the digit is a stream id.
      if (segment.length === 1 && /^\d$/.test(segment[0])) segment = [];
      const dest = tokens[i + 1];
      if (dest && !SEPARATORS.has(dest) && dest !== '>' && dest !== '>>') {
        targets.push({ verb: 'redirect', target: dest });
      }
      i += 1;
      continue;
    }
    if (token === '<') {
      i += 1; // stdin redirection writes nothing
      continue;
    }
    segment.push(token);
  }
  flushSegment();
  return targets;
}
