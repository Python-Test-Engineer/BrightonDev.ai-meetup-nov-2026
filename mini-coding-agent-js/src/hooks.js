/**
 * hooks.js - lifecycle hooks: named moments in the loop where YOUR code gets a turn.
 *
 * WHY THIS FILE EXISTS: the loop in agent.js is fixed on purpose - one `for`, one
 * model call, one dispatcher - and that is what makes it readable. But a fixed
 * loop is not extensible either: "log every command", "never let it touch .env",
 * "tell me when it gives up" all used to mean editing the loop itself, and every
 * one of those edits is a chance to break it. A hook is the smallest extension
 * point that fixes that: a function attached to a named moment, called BY the
 * loop, able to observe, rewrite, or block.
 *
 * THE CONTRACT (worth saying out loud on stage):
 *   a hook is called with a payload object; what it RETURNS decides what happens:
 *
 *     nothing / undefined       observe only - no effect on the run
 *     { note: 'text' }          an observation for whoever is listening
 *     { task: 'new text' }      UserPromptSubmit may rewrite the task
 *     { replace: 'text' }       PostToolUse may replace what the model reads back
 *     { block: true, reason }   PreToolUse / UserPromptSubmit refuse the call; the
 *                               model is told why and can try something else
 *
 *   - a hook that THROWS is reported and ignored. Extension code must never be
 *     able to break the loop's own invariants - above all, every tool_call still
 *     gets a matching tool result, or the next request is invalid.
 *   - a hook does not call the model and does not run tools. It is a pure
 *     function of the payload, which is why it is safe to run on stage.
 *
 * HOOK_EVENTS below is the single source of truth for the lifecycle: the icon,
 * the console colour, when it fires, what it receives, whether it can change
 * anything, and why a student should care. printHookCatalogue() renders all of
 * it for the console (`node src/agent.js --hooks`), and traceHooks() prints each
 * event as it fires (`--trace-hooks`), so the diagram on the slide is the same
 * data the program runs on.
 */
import { ui } from './ui.js';

/**
 * The nine moments, in the order a single run fires them.
 *
 *   color   a chalk colour name - ui.js stays the only file that knows about colour
 *   when    one line: where in the run this fires
 *   gets    what the payload object carries
 *   may     what returning a decision can do (or why it cannot)
 *   why     the sentence a student should remember
 */
export const HOOK_EVENTS = [
  {
    name: 'SessionStart',
    icon: '🚀',
    color: 'cyan',
    when: 'once, before the first model call',
    gets: 'task, workspace, config, log',
    may: 'refuse to start - or post a note to the console',
    why: 'The run exists but nothing has been sent yet. This is where project rules '
      + 'are loaded, a transcript file is opened, a budget is checked, or a greeting is printed.',
  },
  {
    name: 'UserPromptSubmit',
    icon: '✍️',
    color: 'blue',
    when: 'once, as the task enters the loop',
    gets: 'task',
    may: 'rewrite the task (return { task }) or block the run',
    why: 'The user\'s words, before the model has seen them. Rewriting here is how a '
      + 'harness adds standing context ("always run the tests"); blocking here is how it refuses a task.',
  },
  {
    name: 'PreModel',
    icon: '🧠',
    color: 'magenta',
    when: 'before every model call',
    gets: 'step, maxSteps, messages, tools',
    may: 'observe - the request is assembled but not sent',
    why: 'The whole conversation is about to go over the wire. This is where context '
      + 'management begins: measure the messages, summarise the old ones, or log exactly what is being sent.',
  },
  {
    name: 'PostModel',
    icon: '💬',
    color: 'cyan',
    when: 'after every reply, before anything is dispatched',
    gets: 'step, message, finishReason',
    may: 'observe - nothing has happened yet',
    why: 'Text came back: an answer or a tool call, visible here first. Useful for '
      + 'token counts, transcripts, and spotting a model that is going round in circles.',
  },
  {
    name: 'PreToolUse',
    icon: '🛠️',
    color: 'yellowBright',
    when: 'before every tool call',
    gets: 'name, args, step',
    may: 'BLOCK - return { block: true, reason } and the tool never runs',
    why: 'The one hook that changes what the agent is allowed to do. A permission '
      + 'layer lives here: inspect the arguments, refuse the call. The refusal comes back as an '
      + 'observation, so the model can choose another way instead of crashing.',
  },
  {
    name: 'PostToolUse',
    icon: '📦',
    color: 'green',
    when: 'after every tool call',
    gets: 'name, result, ok, step',
    may: 'replace the observation (return { replace }) the model reads back',
    why: 'The result exists and the model has not seen it. Redact a secret, cap a huge '
      + 'output, annotate a failure - the loop appends whatever you return instead.',
  },
  {
    name: 'Stop',
    icon: '🏁',
    color: 'greenBright',
    when: 'the model answered and the loop is ending',
    gets: 'answer, steps, messages',
    may: 'observe - a completion is already a completion',
    why: 'The happy ending: no tool calls, an answer, a return. Good for a summary, a '
      + 'cost report, or the notification that says the job is done.',
  },
  {
    name: 'StepLimit',
    icon: '⏳',
    color: 'yellow',
    when: 'the loop hit maxSteps without an answer',
    gets: 'steps, messages',
    may: 'observe - the run is already over',
    why: 'Failures need a lifecycle too. Escalate here, dump the transcript, or ask the '
      + 'model to summarise what it did manage before the budget ran out.',
  },
  {
    name: 'SessionEnd',
    icon: '🔒',
    color: 'red',
    when: 'always - every run ends here, finished or not',
    gets: 'ok, reason, steps, durationMs, messages',
    may: 'observe - the last code to run in the process',
    why: 'The finally block of the lifecycle. One place that runs whatever happened is '
      + 'what makes cleanup, timing and audit logs reliable rather than hopeful.',
  },
];

/** The event names, in firing order. handiest thing for tests and validation. */
export const HOOK_NAMES = HOOK_EVENTS.map((event) => event.name);

/** The events whose return value can change the run, and what each one can do about it. */
const DECIDING = new Map([
  ['SessionStart', 'refuse to start the run'],
  ['UserPromptSubmit', 'rewrite or block the task'],
  ['PreToolUse', 'block a tool call'],
  ['PostToolUse', 'replace the observation'],
]);

/** Look up one event's metadata by name. */
export const hookMeta = (name) => HOOK_EVENTS.find((event) => event.name === name);

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * A tiny synchronous-by-default registry: attach functions to event names, then
 * let the loop `await hooks.run(name, payload)` at each moment.
 *
 * It is deliberately not an EventEmitter. `run` COLLECTS decisions and returns
 * one answer (blocked? replaced with what?), because a hook that can change the
 * run has to be asked, not merely notified.
 */
export class Hooks {
  #handlers = new Map();

  /**
   * @param {{log?: Function, catalog?: boolean}} options
   *   log      where warnings about broken hooks go (a hook must never be silent)
   *   catalog  print the lifecycle once, on construction - handy in a demo
   */
  constructor({ log = null, catalog = false } = {}) {
    for (const name of HOOK_NAMES) this.#handlers.set(name, []);
    this.log = log;
    if (catalog) printHookCatalogue({ log: log ?? console.log });
  }

  /**
   * Attach a handler. Returns the id so it can be removed again.
   *
   * @param {string} name one of HOOK_NAMES - a typo is an error, not a silent no-op
   * @param {(payload: object, ctx: {event: string}) => any} fn
   * @param {{id?: string, once?: boolean}} [opts]
   */
  on(name, fn, { id, once = false } = {}) {
    if (!this.#handlers.has(name)) {
      throw new Error(`unknown hook "${name}". Known hooks: ${HOOK_NAMES.join(', ')}`);
    }
    if (typeof fn !== 'function') throw new TypeError(`hook "${name}" needs a function`);
    const handle = id ?? `${name}#${this.#handlers.get(name).length + 1}`;
    this.#handlers.get(name).push({ id: handle, fn, once });
    return handle;
  }

  /** Detach by id (the value `on` returned). */
  off(name, id) {
    const list = this.#handlers.get(name);
    if (!list) return false;
    const i = list.findIndex((h) => h.id === id);
    if (i === -1) return false;
    list.splice(i, 1);
    return true;
  }

  /** How many handlers are registered for an event (0 when none are). */
  count(name) {
    return (this.#handlers.get(name) ?? []).length;
  }

  /** Whether any handler is registered for an event. */
  has(name) {
    return this.count(name) > 0;
  }

  /** The events that currently have at least one handler - what the trace will show. */
  attached() {
    return HOOK_NAMES.filter((name) => this.has(name));
  }

  /**
   * Fire an event. Handlers run in registration order; the first `block` wins and
   * the rest are skipped (a refusal does not need a second opinion).
   *
   * @returns {Promise<{event: string, ran: number, blocked: boolean, reason: string|null,
   *                    task: string|null, replace: string|null, notes: string[], errors: string[]}>}
   */
  async run(name, payload = {}) {
    const handlers = this.#handlers.get(name);
    if (!handlers) throw new Error(`unknown hook "${name}". Known hooks: ${HOOK_NAMES.join(', ')}`);

    const out = {
      event: name, ran: 0, blocked: false, reason: null,
      task: null, replace: null, notes: [], errors: [],
    };

    for (const handler of [...handlers]) {
      if (handler.once) this.off(name, handler.id);
      out.ran += 1;

      let decision;
      try {
        decision = await handler.fn(payload, { event: name });
      } catch (err) {
        // Reported, never fatal: one bad hook must not take the loop with it.
        out.errors.push(`${handler.id}: ${err.message}`);
        this.log?.(ui.warn(`  hook ${name} (${handler.id}) threw: ${err.message} - ignored`));
        continue;
      }

      if (!decision || typeof decision !== 'object') continue;
      if (decision.note) {
        // A note is just a hook talking to whoever is watching. It changes
        // nothing, so it prints and the loop carries on.
        out.notes.push(String(decision.note));
        this.log?.(ui.hookNote(name, decision.note));
      }
      if (typeof decision.task === 'string') out.task = decision.task;
      if (typeof decision.replace === 'string') out.replace = decision.replace;

      if (decision.block) {
        out.blocked = true;
        out.reason = decision.reason ? String(decision.reason) : `${name} blocked this step`;
        break;
      }
    }

    return out;
  }
}

/* ------------------------------------------------------------------ *
 * The console
 * ------------------------------------------------------------------ */

/** Fold a line to `width` columns on word boundaries - the catalogue must fit a terminal. */
function wrap(text, width = 78, indent = '      ') {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`).join('\n');
}

/**
 * The one-line summary of a payload, for the live trace. Each event has its own
 * useful detail, and this is the table that decides what that is: a tool call
 * shows the tool and its arguments, a tool result shows its first line, a
 * session end shows why the run stopped.
 */
export function hookDetail(event, payload = {}) {
  switch (event) {
    case 'SessionStart':
      return String(payload.task ?? '').slice(0, 72);
    case 'UserPromptSubmit':
      return String(payload.task ?? '').slice(0, 72);
    case 'PreModel':
      return `step ${payload.step}/${payload.maxSteps} - ${payload.messages?.length ?? 0} messages`;
    case 'PostModel':
      return `step ${payload.step} - ${payload.finishReason ?? 'stop'}`;
    case 'PreToolUse':
      return `${payload.name} ${String(payload.args ?? '').slice(0, 60)}`.trim();
    case 'PostToolUse':
      return `${payload.name} - ${String(payload.result ?? '').split('\n')[0].slice(0, 60)}`;
    case 'Stop':
      return `${payload.steps ?? 0} step(s) - ${String(payload.answer ?? '').split('\n')[0].slice(0, 56)}`;
    case 'StepLimit':
      return `stopped at ${payload.steps} step(s)`;
    case 'SessionEnd':
      return `${payload.ok ? 'ok' : 'failed'} (${payload.reason ?? '?'}) in ${payload.durationMs ?? 0}ms`;
    default:
      return '';
  }
}

/**
 * A `Hooks` with one tracer on every event, so a normal run shows the lifecycle
 * as it happens. This is the cheapest way to teach hooks: run the demo, watch
 * the nine moments fire, then read the loop and find the nine call sites.
 *
 * Every line is tagged `[HOOK:Name]` - greppable on stage and in a log file -
 * followed by what the moment is FOR (the one-liner from HOOK_EVENTS) and what
 * this particular firing carried.
 *
 * @param {{log?: Function, detail?: Function, explain?: boolean}} [options]
 *   explain=false prints only the tag and the payload, with no description
 */
export function traceHooks({ log = console.log, detail = hookDetail, explain = true } = {}) {
  const hooks = new Hooks({ log });
  for (const event of HOOK_EVENTS) {
    hooks.on(event.name, (payload) => {
      log(ui.hookTrace(
        event.icon, event.name, event.color,
        explain ? event.when : '', detail(event.name, payload),
      ));
    }, { id: `trace:${event.name}` });
  }
  return hooks;
}

/**
 * Print the whole lifecycle: every event, with its icon, its colour, what it
 * receives, what it may do, and why it exists - then the order one run fires
 * them in. This is the `--hooks` output, and it is generated from HOOK_EVENTS,
 * so it cannot drift from the events the loop actually fires.
 *
 * @param {{log?: Function, hooks?: Hooks}} [options]
 *   hooks - when given, events with a handler attached are marked as live
 */
export function printHookCatalogue({ log = console.log, hooks = null } = {}) {
  const deciding = [...DECIDING.entries()]
    .map(([name, verb]) => `${name} (${verb})`)
    .join('; ');

  log(ui.hookTitle(`lifecycle hooks - ${HOOK_EVENTS.length} moments in one run`));
  log(ui.dim(
    '  A hook is a function attached to a named moment in the loop. agent.js calls each\n'
    + '  moment; a hook may observe, rewrite what the model reads, or block a call outright.',
  ));
  log('');

  for (const [i, event] of HOOK_EVENTS.entries()) {
    const live = hooks?.has?.(event.name) ? ui.hookLive() : '';
    log(ui.hookLine(event.icon, event.name, event.color, event.when, live));
    log(ui.hookField('receives', event.gets));
    log(ui.hookField('may', event.may, event.color));
    log(ui.dim(wrap(event.why)));
    log('');
  }

  log(ui.hookTitle(`the order one run fires them`));
  log(ui.hookFlow([
    'SessionStart', 'UserPromptSubmit', '[ PreModel → PostModel → PreToolUse → PostToolUse ]',
    'Stop | StepLimit', 'SessionEnd',
  ]));
  log('');
  log(ui.dim(wrap(
    `${HOOK_EVENTS.length} hooks, and ${DECIDING.size} of them can change the run: ${deciding}. `
    + 'The rest only watch - which is exactly why a hook is a safe first extension point.',
  )));
  log('');
}

/** What `hooks.js` guarantees: how many events, and which of them decide anything. */
export const HOOK_SUMMARY = {
  total: HOOK_EVENTS.length,
  deciding: DECIDING.size,
  names: HOOK_NAMES,
};
