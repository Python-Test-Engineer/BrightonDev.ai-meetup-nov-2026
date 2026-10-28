/**
 * heartbeat.js - liveness: a slow model call must not look like a frozen program.
 *
 * WHY THIS FILE EXISTS: a request can legitimately take 60 seconds, and on a
 * projector 60 seconds of silence is indistinguishable from a crash. The fix is
 * a timer that prints one line every few seconds while the request is in flight.
 *
 * It lives outside the loop because it is a separate worry with a separate
 * lifecycle: arm it, await the request, stop it - on both the success and the
 * failure path. Keeping it here means `runTask` reads as the loop, not as the
 * loop plus a stopwatch.
 */
import { ui } from './ui.js';

/**
 * Start printing "still waiting" every `everyMs` milliseconds.
 *
 * @param {(line: string) => void} log where the lines go (runTask's injected logger)
 * @param {number} [everyMs] how often to print; 5 s is slow enough to read
 * @returns {{stop: () => void}} call `stop()` when the request settles
 */
export function heartbeat(log, everyMs = 5000) {
  const started = Date.now();

  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    log(ui.waiting(`  … still waiting for the model (${seconds}s)`));
  }, everyMs);

  // A timer that holds the event loop open would turn a clean exit into a
  // program that hangs for another five seconds. unref() makes it invisible to
  // the event loop count.
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
