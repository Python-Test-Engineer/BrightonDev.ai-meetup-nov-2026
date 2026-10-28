/**
 * Console styling, on top of `chalk`.
 *
 * chalk styles the exact string you hand it, so there is no markup to parse and
 * nothing to escape: text from the model or a tool prints verbatim, even when it
 * contains something that looks like a colour tag. Backslashes in Windows paths
 * and in JSON are untouched too.
 *
 * Every helper returns a STRING and nothing here writes to stdout, which is why
 * runTask can still take an injected `log` in the tests.
 *
 * Colour level is chalk's call, not ours: TTY, NO_COLOR and FORCE_COLOR are all
 * honoured, so piping a run into a log file gives clean text automatically.
 */
import chalk from 'chalk';

/** A result is "bad" if the tool reported an error, a denial or a non-zero exit. */
const isFailure = (text) => /^(ERROR|DENIED)\b/.test(text) || /\bexit code (?!0\b)\d+/.test(text);

const firstLine = (text, limit = 300) => String(text ?? '').split('\n')[0].slice(0, limit);

/**
 * What a non-zero exit code means, in words someone on stage can act on.
 * "result ← exit code 1" on its own tells an audience nothing, so every failed
 * command gets one of these printed underneath it.
 */
const EXIT_MEANINGS = {
  1: 'general failure - the command ran and then reported an error (uncaught exception, failed assertion, bad argument). The cause is in stderr; fix that, do not just re-run.',
  2: 'usage error - the program rejected its arguments, or a file it needed was missing or unreadable',
  3: 'usage error - Python CLIs (argparse) use 3 for invalid arguments; bash uses 2 for a bad builtin',
  126: 'the command exists but cannot be executed - permission denied on the file',
  127: 'command not found - not on PATH inside the sandbox, or a typo in the name',
  128: 'invalid exit status - exit() was called with something outside the range 0-255',
  129: 'killed by SIGHUP - the terminal that started it went away',
  130: 'interrupted - Ctrl-C (SIGINT) reached the process',
  137: 'killed - SIGKILL: an out-of-memory kill, or the run_command timeout',
  143: 'terminated - SIGTERM: killed politely, usually by a timeout',
  9009: 'command not found - Windows cmd uses 9009 for "not recognised as a program or batch file"',
};

/** Plain-English meaning of a process exit code. */
export function explainExit(code) {
  const n = Number(code);
  if (EXIT_MEANINGS[n]) return EXIT_MEANINGS[n];
  if (n > 128 && n < 165) return `killed by signal ${n - 128} - the process never got to exit on its own`;
  return 'non-zero exit - the command reported failure; stdout and stderr above say why';
}

/** The non-zero code in an "exit code N" result line, or null. */
const failedExitCode = (line) => {
  const m = line.match(/\bexit code (\d+)/);
  return m && Number(m[1]) !== 0 ? Number(m[1]) : null;
};

/** First line a successful command printed, for the line under "exit code 0". */
const firstStdout = (text) => {
  const s = String(text ?? '');
  if (!/^exit code 0/.test(s)) return '';
  const m = s.match(/\nstdout:\n([\s\S]*)/);
  if (!m) return '';
  const line = m[1].split('\n').find((l) => l.trim() !== '');
  return line ? line.trim().slice(0, 160) : '';
};

/**
 * The agent's visual language. One function per kind of line, so agent.js never
 * contains a colour and the whole palette can be swapped here.
 */
export const ui = {
  /** banner heading */
  title: (text) => chalk.bold.cyan(text),
  /** the input field prompt: label on the left, a caret after it */
  field: (label) => `${chalk.green(label)} ${chalk.white('›')}`,
  /** secondary banner line: label on the left, value after the colon */
  kv: (label, value) => `${chalk.blue(`${label.padEnd(10)}:`)} ${chalk.white(value)}`,
  step: (step, max, width = 40) => chalk.blue(`── step ${step}/${max} ${'─'.repeat(width)}`),
  think: (text) => `${chalk.cyan('think:')} ${text}`,
  tool: (name, args) => `${chalk.white('tool →')} ${chalk.yellow(name)} ${chalk.white(args)}`,
  result: (text) => {
    const line = firstLine(text);

    if (!isFailure(line)) {
      // A successful command also shows the first thing it printed, so a
      // "exit code 0" is not a claim you have to take on trust.
      const out = firstStdout(text);
      const detail = out ? `\n${chalk.dim(`         ↳ stdout: ${out}`)}` : '';
      return `${chalk.green('result ←')} ${chalk.white(line)}${detail}`;
    }

    // A failed command also gets the meaning of its exit code, one line down.
    const code = failedExitCode(line);
    const detail = code === null ? '' : `\n${chalk.dim(`         ↳ exit ${code}: ${explainExit(code)}`)}`;
    return chalk.red(`result ← ${line}`) + detail;
  },
  /** a passed sandbox check in the --demo scorecard */
  pass: (text) => `${chalk.green('✓')} ${text}`,
  /** a sandbox check that did not hold */
  fail: (text) => `${chalk.red('✗')} ${text}`,
  /** a titled divider, e.g. "── sandbox checks ──────" */
  rule: (label, width = 44) => chalk.bold.magenta(`── ${label} ${'─'.repeat(width)}`),

  /* ---- lifecycle hooks (see hooks.js) ------------------------------------ *
   * hooks.js owns the catalogue - names, icons, colours, descriptions - and
   * every colour still comes from here. `colour` is a chalk mode NAME, so the
   * event table stays plain data. An unknown name falls back rather than
   * throwing: this file is also what the palette test calls with junk.        */

  /** a section heading in the hook catalogue */
  hookTitle: (label) => chalk.bold.cyan(`── ${label} ${'─'.repeat(Math.max(4, 60 - label.length))}`),
  /** one hook: icon, name in its own colour, and when it fires */
  hookLine: (icon, name, colour = 'cyan', when = '', live = '') => {
    const paint = chalk[colour] ?? chalk.cyan;
    return `  ${icon}  ${paint.bold(String(name).padEnd(16))} ${chalk.white(when)}${live}`;
  },
  /** a labelled field under a hook, e.g. "receives  name, args, step" */
  hookField: (label, value, colour = 'cyan') => {
    const paint = chalk[colour] ?? chalk.cyan;
    return `      ${chalk.dim(String(label).padEnd(9))} ${paint(value)}`;
  },
  /** marks a hook that currently has a handler attached */
  hookLive: () => chalk.green(' ← attached'),
  /** a hook saying something without changing the run: "📝 PreToolUse: ..." */
  hookNote: (name, text) => `  📝 ${chalk.dim(`${name}: ${text}`)}`,
  /**
   * One lifecycle event firing, in the form a student can grep for:
   *   "🛠️  [HOOK:PreToolUse] before every tool call - run_command {"command":"ls"}"
   * The tag is the hook's own colour, the explanation is the moment's one-liner
   * from HOOK_EVENTS, and the detail is what this particular firing carried.
   */
  hookTrace: (icon, name, colour = 'cyan', explanation = '', detail = '') => {
    const paint = chalk[colour] ?? chalk.cyan;
    const why = explanation ? ` ${chalk.white(explanation)}` : '';
    const what = detail ? ` ${chalk.dim(`- ${detail}`)}` : '';
    return `  ${icon}  ${paint.bold(`[HOOK:${name}]`)}${why}${what}`;
  },
  /** the ordered lifecycle, one step per line */
  hookFlow: (steps = []) => (Array.isArray(steps) ? steps : [steps])
    .map((s, i) => `  ${chalk.dim(`${i + 1}.`)} ${chalk.white(s)}`)
    .join('\n'),
  /** what long-term memory carried into this run (see memory.js) */
  memory: (text) => `${chalk.magenta('memory ←')} ${chalk.white(text)}`,
  /** the last line of a failed run: the process exit code and what it means */
  exitNote: (code, meaning) => `${chalk.red(`exit code ${code}`)}${meaning ? ` ${chalk.dim(`- ${meaning}`)}` : ''}`,
  answerRule: () => chalk.bold.green(`── final answer ${'─'.repeat(38)}`),
  answer: (text) => chalk.white(text),
  warn: (text) => chalk.yellowBright(text),
  /** heartbeat while a model call is in flight */
  waiting: (text) => chalk.yellowBright(text),
  error: (text) => chalk.red(text),
  note: (text) => chalk.white(text),
  prompt: (text) => chalk.green(text),
  dim: (text) => chalk.dim(text),
};
