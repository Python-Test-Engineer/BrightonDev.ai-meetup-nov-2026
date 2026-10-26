import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadDotEnv, findEnvFile, fingerprint, normalizeModel } from '../src/config.js';

function envFileWith(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('.env beats a stale key exported in the shell', () => {
  const file = envFileWith(['# comment', 'OPENROUTER_API_KEY="from-dotenv"', 'OPENROUTER_MODEL=from/dotenv-model']);
  withEnv({ OPENROUTER_API_KEY: 'stale-shell-key', OPENROUTER_MODEL: 'stale/shell-model' }, () => {
    const config = loadConfig({}, { envFile: file });
    assert.equal(config.apiKey, 'from-dotenv');
    assert.equal(config.apiKeySource, '.env');
    assert.equal(config.model, 'from/dotenv-model');
    assert.equal(config.modelSource, '.env');
    assert.equal(process.env.OPENROUTER_API_KEY, 'from-dotenv', 'process env is updated too');
  });
});

test('environment is still used for keys .env does not define', () => {
  const file = envFileWith(['SOMETHING_UNRELATED=1']);
  withEnv({ OPENROUTER_API_KEY: 'shell-only-key' }, () => {
    const config = loadConfig({}, { envFile: file });
    assert.equal(config.apiKey, 'shell-only-key');
    assert.equal(config.apiKeySource, 'environment');
  });
});

test('a missing .env file is not an error', () => {
  const missing = path.join(os.tmpdir(), 'mca-does-not-exist', '.env');
  withEnv({ OPENROUTER_API_KEY: 'shell-key' }, () => {
    assert.deepEqual(loadDotEnv(missing), {});
    assert.equal(loadConfig({}, { envFile: missing }).apiKey, 'shell-key');
  });
});

test('quotes, export prefixes and blank values are handled', () => {
  const file = envFileWith(['export OPENROUTER_MODEL="quoted/model"', 'OPENROUTER_API_KEY=', 'CMD_POLICY=allow']);
  withEnv({ OPENROUTER_API_KEY: 'shell-fallback' }, () => {
    const config = loadConfig({}, { envFile: file });
    assert.equal(config.model, 'quoted/model');
    assert.equal(config.apiKey, 'shell-fallback', 'empty .env value does not blank the key');
    assert.equal(config.commandPolicy, 'allow');
  });
});

test('config finds the .env in the project root when the package has none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-root-'));
  const nested = path.join(root, 'mini-coding-agent', 'src');
  fs.mkdirSync(nested, { recursive: true });
  const rootEnv = path.join(root, '.env');
  fs.writeFileSync(rootEnv, 'OPENROUTER_API_KEY=root-key\nMODEL=deepseek/deepseek-chat\n', 'utf8');

  // walk-up search finds it from a nested folder
  assert.equal(findEnvFile(nested), rootEnv);

  // and the default load (no envFile argument) uses it
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const config = loadConfig({}, { startDir: nested });
    assert.equal(config.envFile, rootEnv);
    assert.equal(config.apiKey, 'root-key');
    assert.equal(config.model, 'deepseek/deepseek-chat');
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});

test('a nearer .env wins over one further up', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-near-'));
  const pkg = path.join(root, 'mini-coding-agent');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'OPENROUTER_API_KEY=outer-key\n', 'utf8');
  fs.writeFileSync(path.join(pkg, '.env'), 'OPENROUTER_API_KEY=inner-key\n', 'utf8');

  assert.equal(findEnvFile(pkg), path.join(pkg, '.env'));
});

test('fingerprints never expose the whole key', () => {
  const key = 'sk-or-v1-1234567890abcdef';
  const shown = fingerprint(key);
  assert.ok(shown.includes('cdef'), 'last 4 are shown for recognition');
  assert.ok(!shown.includes('1234567890'), 'the middle of the key is never shown');
  assert.ok(shown.length < key.length);
  assert.equal(fingerprint(''), 'not set');
});

test('bare model names are normalised to vendor/model', () => {
  assert.deepEqual(normalizeModel('deepseek-v4.1-flash-1017'), { model: 'deepseek/deepseek-v4.1-flash-1017', normalised: true });
  assert.deepEqual(normalizeModel('gpt-5'), { model: 'openai/gpt-5', normalised: true });
  assert.deepEqual(normalizeModel('claude-sonnet-4.5'), { model: 'anthropic/claude-sonnet-4.5', normalised: true });
  assert.deepEqual(normalizeModel('deepseek/deepseek-chat'), { model: 'deepseek/deepseek-chat', normalised: false });
  assert.deepEqual(normalizeModel('acme/widget'), { model: 'acme/widget', normalised: false });
  assert.deepEqual(normalizeModel('weird-name'), { model: 'weird-name', normalised: false });
});

test('config normalises the model that came from .env', () => {
  const file = envFileWith(['OPENROUTER_MODEL="deepseek/deepseek-chat"']);
  withEnv({ OPENROUTER_MODEL: 'stale/shell-model' }, () => {
    const config = loadConfig({}, { envFile: file });
    assert.equal(config.model, 'deepseek/deepseek-chat');
    assert.equal(config.modelOverrodeShell, true);
  });
});

test('.env MODEL= is honoured and beats an inherited OPENROUTER_MODEL', () => {
  const file = envFileWith(['MODEL="deepseek-v4.1-flash-1017"']);
  withEnv({ OPENROUTER_MODEL: 'deepseek/deepseek-v4.1-flash' }, () => {
    const config = loadConfig({}, { envFile: file });
    assert.equal(config.model, 'deepseek/deepseek-v4.1-flash-1017');
    assert.equal(config.modelSource, '.env');
    assert.equal(config.modelOverrodeShell, true);
  });
});

test('the key from .env is the one used, and the override is reported', () => {
  const file = envFileWith(['OPENROUTER_API_KEY=dotenv-key']);
  withEnv({ OPENROUTER_API_KEY: 'shell-old-key' }, () => {
    const config = loadConfig({}, { envFile: file });
    assert.equal(config.apiKey, 'dotenv-key');
    assert.equal(config.apiKeySource, '.env');
    assert.equal(config.apiKeyOverrodeShell, true);
  });
});

test('identical values are not reported as an override', () => {
  const file = envFileWith(['OPENROUTER_API_KEY=same-key']);
  withEnv({ OPENROUTER_API_KEY: 'same-key' }, () => {
    assert.equal(loadConfig({}, { envFile: file }).apiKeyOverrodeShell, false);
  });
});
