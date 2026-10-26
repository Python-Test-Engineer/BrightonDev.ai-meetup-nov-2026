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
    return isFailure(line)
      ? chalk.red(`result ← ${line}`)
      : `${chalk.green('result ←')} ${chalk.white(line)}`;
  },
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
