import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/llm.js';

test('a stalled request times out instead of hanging forever', async () => {
  const realFetch = globalThis.fetch;
  // A socket that accepts the request and then never answers.
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });

  try {
    await assert.rejects(
      chat({ apiKey: 'test-key', model: 'test/model', messages: [], timeoutMs: 60 }),
      /timed out after \d+s - OpenRouter did not answer/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a provider error is reported with its status and body', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"no key"}' });

  try {
    await assert.rejects(
      chat({ apiKey: 'test-key', model: 'test/model', messages: [] }),
      /OpenRouter 401 \(bad or revoked key\)/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
