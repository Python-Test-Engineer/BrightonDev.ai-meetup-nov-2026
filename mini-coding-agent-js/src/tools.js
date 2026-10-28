import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { PathError } from './workspace.js';
import { formatEntry } from './memory.js';

/* ------------------------------------------------------------------ *
 * Schemas: exactly what the model sees. Descriptions are prompt text,
 * so they are worth tuning - the model picks tools from these words.
 * ------------------------------------------------------------------ */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and folders in the workspace, recursively. Use this first when you are unsure what exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relative to the workspace root. Default "."' },
          depth: { type: 'integer', description: 'How many levels deep to walk. Default 3, max 6.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file with line numbers. Use it before editing so old_string matches exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          offset: { type: 'integer', description: 'First line to return, 1-based. Default 1' },
          limit: { type: 'integer', description: 'Max lines to return. Default 200' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a NEW file with the given content. Fails if the file already exists - use edit_file or write_file for existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or completely overwrite a file. Parent folders are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact snippet in an existing file. old_string must appear exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          old_string: { type: 'string', description: 'Exact text to replace, including indentation' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace root and return exit code, stdout and stderr. Use it to execute or test what you wrote.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line, e.g. "node hello.js" or "ls -la"' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  // The last two are the only tools whose effect outlives the run. Everything
  // else changes the workspace; these change what the NEXT process knows about
  // it. See memory.js - memory.md is the store.
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save a durable note to memory.md so a future run can use it. Use it for facts about this project that will still be true next week (how to run the tests, a command the sandbox refuses, a naming rule) or a preference the user stated. Do NOT save task progress, file contents, or anything you would not want quoted back at you later.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The memory, in one self-contained sentence - it will be read with no other context' },
          tag: { type: 'string', description: 'fact (default), pref (a user preference), fix (something that went wrong, and how it was fixed) or gotcha (a trap in this repo)' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search memory.md for notes saved by earlier runs. The newest few are already in your system prompt; use this when the task looks like something this repo has already taught you, or when those notes mention an older one.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for, e.g. "test node" - every word must appear. Empty lists the newest memories.' },
          limit: { type: 'integer', description: 'Max memories to return. Default 20' },
        },
        additionalProperties: false,
      },
    },
  },
];

const PARAMS = Object.fromEntries(
  TOOL_SCHEMAS.map((t) => [
    t.function.name,
    Object.fromEntries(
      Object.entries(t.function.parameters.properties).map(([k, v]) => [k, v.type]),
    ),
  ]),
);

/* ------------------------------------------------------------------ *
 * Command policy: this is the human-in-the-loop principle on stage.
 * Default "ask": the demo stops and waits for you to approve each command.
 * ------------------------------------------------------------------ */
const HARD_DENY = [
  { re: /\brm\s+(-[a-z]*\s+)?-[a-z]*r[a-z]*f?\s+([/~]|[a-z]:[\\/])\s*$/i, why: 'recursive delete of a root path' },
  { re: /\bdel\s+\/[a-z]*[sq]/i, why: 'recursive/quiet Windows delete' },
  { re: /\b(format|diskpart)\b/i, why: 'disk formatting' },
  { re: /\b(shutdown|reboot)\b/i, why: 'machine power control' },
  { re: /git\s+push\s+(--force|-f)\b/i, why: 'force push' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh/i, why: 'piping the internet into a shell' },
  { re: /:\s*\(\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  { re: />\s*\/dev\/sd/i, why: 'raw disk write' },
];

const MAX_OUTPUT = 6000;
const TIMEOUT_MS = 30_000;

/**
 * The child gets a short allow-list, not `process.env`.
 * A shell that inherits the harness's environment can do
 * `node -e "console.log(process.env.OPENROUTER_API_KEY)"` and put the key
 * straight into messages, the provider and your logs. Paths and the temp dir
 * are all a subprocess legitimately needs.
 */
const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
  'SYSTEMROOT', 'COMSPEC', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
];

export function safeEnv(source = process.env) {
  const env = {};
  for (const key of ENV_ALLOW) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

function clip(text, limit = MAX_OUTPUT) {
  const s = String(text ?? '');
  return s.length <= limit ? s : `${s.slice(0, limit)}\n... [${s.length - limit} chars truncated]`;
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: safeEnv(),
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout,
          stderr: err?.killed ? `${stderr}\n[tool] command timed out after ${TIMEOUT_MS / 1000}s` : stderr,
        });
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Handlers. Every one returns a STRING: that string is what the model
 * reads back. Errors are returned, never thrown out of the loop.
 * ------------------------------------------------------------------ */
const HANDLERS = {
  list_files(ws, args) {
    const start = ws.resolve(args.path ?? '.');
    if (!fs.existsSync(start.abs)) return `ERROR: no such folder: ${start.rel}`;
    if (!fs.statSync(start.abs).isDirectory()) return `ERROR: not a folder: ${start.rel}`;

    const depth = Math.min(Math.max(Number(args.depth ?? 3), 1), 6);
    const skip = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
    const lines = [];
    let dirs = 0;
    let files = 0;

    const walk = (dir, level) => {
      if (level > depth || lines.length >= 200) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (skip.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        const rel = path.relative(ws.root, abs).split(path.sep).join('/');
        if (entry.isDirectory()) {
          dirs += 1;
          lines.push(`${rel}/`);
          walk(abs, level + 1);
        } else {
          files += 1;
          lines.push(`${rel}  (${fs.statSync(abs).size}b)`);
        }
        if (lines.length >= 200) return;
      }
    };
    walk(start.abs, 1);

    return `${lines.length ? lines.join('\n') : '(empty)'}\n\n${dirs} folder(s), ${files} file(s) under ${start.rel}`;
  },

  read_file(ws, args) {
    const target = ws.resolve(args.path);
    if (!fs.existsSync(target.abs)) return `ERROR: no such file: ${target.rel}`;
    if (fs.statSync(target.abs).isDirectory()) return `ERROR: ${target.rel} is a folder - use list_files`;

    const all = fs.readFileSync(target.abs, 'utf8').split(/\r?\n/);
    const offset = Math.max(Number(args.offset ?? 1), 1);
    const limit = Math.min(Math.max(Number(args.limit ?? 200), 1), 2000);
    const slice = all.slice(offset - 1, offset - 1 + limit);

    const numbered = slice.map((line, i) => `${String(offset + i).padStart(4)}| ${line}`).join('\n');
    const more = offset - 1 + slice.length < all.length
      ? `\n... [${all.length - (offset - 1 + slice.length)} more lines]`
      : '';
    return `${target.rel} (${all.length} lines)\n${numbered}${more}`;
  },

  create_file(ws, args) {
    const target = ws.resolve(args.path);
    if (fs.existsSync(target.abs)) {
      return `ERROR: ${target.rel} already exists - use edit_file to change it or write_file to overwrite`;
    }
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.writeFileSync(target.abs, String(args.content), 'utf8');
    return `created ${target.rel} (${Buffer.byteLength(String(args.content))} bytes)`;
  },

  write_file(ws, args) {
    const target = ws.resolve(args.path);
    const existed = fs.existsSync(target.abs);
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.writeFileSync(target.abs, String(args.content), 'utf8');
    return `${existed ? 'overwrote' : 'created'} ${target.rel} (${Buffer.byteLength(String(args.content))} bytes)`;
  },

  edit_file(ws, args) {
    const target = ws.resolve(args.path);
    if (!fs.existsSync(target.abs)) return `ERROR: no such file: ${target.rel}`;

    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    if (oldStr === '') return 'ERROR: old_string must not be empty';

    const source = fs.readFileSync(target.abs, 'utf8');
    const count = source.split(oldStr).length - 1;

    if (count === 0) {
      return `ERROR: old_string not found in ${target.rel}. Read the file and copy the snippet exactly, including whitespace.`;
    }
    if (count > 1 && !args.replace_all) {
      return `ERROR: old_string appears ${count} times in ${target.rel}. Add surrounding context to make it unique, or pass replace_all: true.`;
    }

    const updated = args.replace_all
      ? source.split(oldStr).join(newStr)
      : source.replace(oldStr, () => newStr); // function form: no $1 surprises
    fs.writeFileSync(target.abs, updated, 'utf8');

    const lineNo = source.slice(0, source.indexOf(oldStr)).split(/\r?\n/).length;
    const replaced = args.replace_all ? count : 1;
    return `edited ${target.rel}: ${replaced} replacement(s), first at line ${lineNo}`;
  },

  async run_command(ws, args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) return 'ERROR: command is required';

    for (const { re, why } of HARD_DENY) {
      if (re.test(command)) return `DENIED: blocked by policy (${why}). Command: ${command}`;
    }

    const policy = ctx.commandPolicy;
    if (policy === 'deny') return 'DENIED: command execution is disabled (CMD_POLICY=deny).';

    const approval = policy === 'allow' ? 'allow' : await ctx.confirm(command);
    if (approval !== 'allow') return `DENIED: the user did not approve this command. Command: ${command}`;

    const { code, stdout, stderr } = await runShell(command, ws.root);
    const parts = [`exit code ${code}`];
    if (stdout.trim()) parts.push(`stdout:\n${clip(stdout.trimEnd())}`);
    if (stderr.trim()) parts.push(`stderr:\n${clip(stderr.trimEnd())}`);
    if (!stdout.trim() && !stderr.trim()) parts.push('(no output)');
    return parts.join('\n');
  },

  /* ---- long-term memory (see memory.js) ---------------------------- *
   * These two are the ONLY tools whose effect is still there after the
   * process exits. `remember` is a write to a file the harness also reads,
   * and `recall` is the lazy half of the same store: the digest in the
   * system prompt is bounded, so older notes have to be asked for.        */

  remember(ws, args, ctx) {
    if (!ctx.memory) return 'ERROR: no memory store in this run (started with --no-memory)';
    const saved = ctx.memory.remember(args.text, { tag: args.tag });
    if (!saved.ok) return `ERROR: ${saved.reason}`;
    if (saved.duplicate) {
      return `already remembered in ${ctx.memory.label} (${saved.total} total), date refreshed: ${formatEntry(saved.entry)}`;
    }
    const dropped = saved.dropped ? `, dropped the ${saved.dropped} oldest` : '';
    return `remembered in ${ctx.memory.label} (${saved.total} total${dropped}): ${formatEntry(saved.entry)}`;
  },

  recall(ws, args, ctx) {
    if (!ctx.memory) return 'ERROR: no memory store in this run (started with --no-memory)';
    const query = String(args.query ?? '');
    const hits = ctx.memory.search(query, { limit: args.limit ?? 20 });
    if (!hits.length) {
      return `no memories in ${ctx.memory.label} match "${query}" (${ctx.memory.size} stored)`;
    }
    const head = `${hits.length} of ${ctx.memory.size} memories in ${ctx.memory.label}:`;
    // One hit on one line, so the console's first-line preview shows the memory
    // itself rather than only the count.
    return hits.length === 1 ? `${head} ${formatEntry(hits[0])}` : `${head}\n${hits.map(formatEntry).join('\n')}`;
  },
};

/** Validate args against the tool's own schema before dispatch. */
function validate(name, raw) {
  const spec = PARAMS[name];
  let args;
  try {
    args = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : (raw ?? {});
  } catch (err) {
    return { error: `ERROR: could not parse arguments for ${name}: ${err.message}` };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { error: `ERROR: arguments for ${name} must be a JSON object` };
  }
  for (const [key, type] of Object.entries(spec)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const actual = type === 'integer' ? (Number.isInteger(value) ? 'integer' : typeof value) : typeof value;
    if (actual !== type) return { error: `ERROR: "${key}" must be a ${type}, got ${actual}` };
  }
  return { args };
}

export async function runTool(name, rawArgs, ctx) {
  if (!HANDLERS[name]) {
    return `ERROR: unknown tool "${name}". Available: ${Object.keys(HANDLERS).join(', ')}`;
  }
  const { args, error } = validate(name, rawArgs);
  if (error) return error;

  try {
    return await HANDLERS[name](ctx.workspace, args, ctx);
  } catch (err) {
    if (err instanceof PathError) return `ERROR: ${err.message}`;
    return `ERROR: ${err.code ?? 'failed'}: ${err.message}`;
  }
}

export const TOOL_NAMES = Object.keys(HANDLERS);

/** The bounds that are configured rather than exercised by a demo step. */
export const SANDBOX_LIMITS = {
  maxOutput: MAX_OUTPUT,
  timeoutMs: TIMEOUT_MS,
  denyPatterns: HARD_DENY.length,
  envKeys: ENV_ALLOW.length,
};
