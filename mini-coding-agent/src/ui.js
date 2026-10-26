/**
 * Console styling, on top of the `rich-console` package.
 *
 * rich-console turns HTML-ish tags into ANSI escapes, so styles read as text
 * instead of \x1b[ codes:
 *
 *     getRichTmpl('<cyan>think:</cyan> %s')   ->  ESC[36m + 'think:' + ESC[0m + ' %s'
 *
 * Two rules keep this safe for an agent demo:
 *
 * 1. Everything the model or a tool prints goes through a %s slot, and each
 *    value is escaped first, so a file containing `<red>` prints literally
 *    instead of repainting the rest of the console.
 * 2. Every helper returns a STRING. Nothing here writes to stdout, which is
 *    why runTask can still take an injected `log` in the tests.
 */
import richConsole from 'rich-console';

const TAGS = /<\/?(?:black|red|green|yellow|orange|blue|pink|cyan|white)>/g;

/**
 * Neutralise anything rich-console would interpret: a backslash eats the next
 * character (`C:\Users` -> `C:Users`), and `\<red>` renders as literal `<red>`,
 * which is what we want for tag lookalikes coming from model or tool output.
 */
const escapeTags = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(TAGS, (match) => `\\${match}`);

/** Fill %s slots, then let rich-console render the tags in the template. */
function render(template, values, bright) {
  let i = 0;
  const filled = template.replace(/%s/g, () => escapeTags(values[i++]));
  return richConsole.getRichTmpl(filled, bright);
}

/** Normal weight; palette: black, red, green, yellow/orange, blue, pink, cyan, white. */
export const style = (template, ...values) => render(template, values, false);

/** Bright/bold variant of the same palette - used for headings only. */
export const styleBright = (template, ...values) => render(template, values, true);

const firstLine = (text, limit = 300) => String(text ?? '').split('\n')[0].slice(0, limit);

/** A result is "bad" if the tool reported an error, a denial or a non-zero exit. */
const isFailure = (text) => /^(ERROR|DENIED)\b/.test(text) || /\bexit code (?!0\b)\d+/.test(text);

/**
 * The agent's visual language. One function per kind of line, so agent.js
 * never contains a colour code and the whole palette can be swapped here.
 */
export const ui = {
  title: (text) => styleBright('<cyan>%s</cyan>', text),
  /** the input field prompt: label on the left, a caret after it */
  field: (label) => style('<green>%s</green> <white>›</white>', label),
  /** secondary banner line: label on the left, value after the colon */
  kv: (label, value) => style('<blue>%s</blue> <white>%s</white>', `${label.padEnd(10)}:`, value),
  step: (step, max, width = 40) => style(`<blue>── step %s/%s ${'─'.repeat(width)}</blue>`, step, max),
  think: (text) => style('<cyan>think:</cyan> %s', text),
  tool: (name, args) => style('<white>tool →</white> <yellow>%s</yellow> <white>%s</white>', name, args),
  result: (text) => {
    const line = firstLine(text);
    return isFailure(line)
      ? style('<red>result ← %s</red>', line)
      : style('<green>result ←</green> <white>%s</white>', line);
  },
  answerRule: () => styleBright(`<green>── final answer ${'─'.repeat(38)}</green>`),
  answer: (text) => style('<white>%s</white>', text),
  warn: (text) => style('<orange>%s</orange>', text),
  /** heartbeat while a model call is in flight */
  waiting: (text) => style('<orange>%s</orange>', text),
  error: (text) => style('<red>%s</red>', text),
  note: (text) => style('<white>%s</white>', text),
  prompt: (text) => style('<green>%s</green>', text),
  dim: (text) => style('<white>%s</white>', text),
};
