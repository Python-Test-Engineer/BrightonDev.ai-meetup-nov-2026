const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** A stalled socket must not look like a hung agent. */
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * One model call. OpenAI-compatible tool calling over plain fetch - no SDK,
 * because the point of the demo is that an agent is just this HTTP request
 * in a loop.
 */
export async function chat({ apiKey, model, messages, tools, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (put it in .env or the environment)');

  const timeout = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res;
  let text;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: abort,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'min-coding-js',
      },
      body: JSON.stringify({ model, messages, tools, max_tokens: 2048 }),
    });
    text = await res.text();
  } catch (err) {
    if (timeout.aborted) {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s - OpenRouter did not answer`);
    }
    throw err;
  }

  if (!res.ok) {
    const hint = res.status === 401 ? ' (bad or revoked key)'
      : res.status === 402 ? ' (out of credits)' : '';
    throw new Error(`OpenRouter ${res.status}${hint}: ${text.slice(0, 400)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OpenRouter returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (json.error) throw new Error(`OpenRouter error: ${JSON.stringify(json.error).slice(0, 400)}`);
  return json;
}

/**
 * Rebuild the outgoing assistant message with only the fields an agent needs.
 * Providers may also return `reasoning` / `reasoning_content`; echoing those
 * back re-sends the whole trace on every later step.
 */
export function sanitizeAssistant(message) {
  const out = { role: 'assistant', content: message.content ?? '' };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls;
    if (message.content == null) delete out.content;
  }
  return out;
}
