import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Minimal .env loader: KEY=VALUE lines, # comments, surrounding quotes stripped.
 *
 * PRECEDENCE: values in `.env` WIN over variables inherited from the shell.
 * This is deliberate - a stale OPENROUTER_API_KEY exported in ~/.bashrc (or any
 * other terminal session) would otherwise silently outrank the key you just put
 * in this project's .env, and you would spend an afternoon debugging a 401.
 * Real environment variables are still used for anything .env does not define.
 *
 * @returns {Record<string,string>} the keys that came from the file
 */
export function loadDotEnv(file = path.join(PROJECT_ROOT, '.env')) {
  const fromFile = {};
  if (!fs.existsSync(file)) return fromFile;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const name = m[1];
    const value = m[2].trim().replace(/^["'](.*)["']$/, '$1').trim();
    if (!value) continue;

    process.env[name] = value; // .env overrides the shell
    fromFile[name] = value;
  }
  return fromFile;
}

/** Never log a key: 5 chars of prefix, last 4, and how long it is. */
export function fingerprint(secret) {
  if (!secret) return 'not set';
  if (secret.length <= 12) return `${'*'.repeat(secret.length)} (${secret.length} chars)`;
  return `${secret.slice(0, 5)}...${secret.slice(-4)} (${secret.length} chars)`;
}

// OpenRouter needs vendor/model. A .env carried over from another project often
// holds a bare name, so map the obvious prefixes instead of failing with a 400.
const VENDOR_BY_PREFIX = [
  [/^deepseek/i, 'deepseek'],
  [/^claude/i, 'anthropic'],
  [/^(gpt|o[13458]|chatgpt)/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^grok/i, 'x-ai'],
  [/^llama/i, 'meta-llama'],
  [/^qwen/i, 'qwen'],
  [/^mistral|^mixtral/i, 'mistralai'],
];

export function normalizeModel(model) {
  const value = String(model ?? '').trim();
  if (!value || value.includes('/')) return { model: value, normalised: false };

  const explicit = process.env.OPENROUTER_PROVIDER_PREFIX;
  if (explicit) return { model: `${explicit}/${value}`, normalised: true };

  const hit = VENDOR_BY_PREFIX.find(([re]) => re.test(value));
  return hit ? { model: `${hit[1]}/${value}`, normalised: true } : { model: value, normalised: false };
}

export function loadConfig(overrides = {}, { envFile } = {}) {
  // Remember what the shell handed us before .env is applied, so we can report
  // when .env actually replaced a different value.
  const inherited = {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
  };

  const fromFile = loadDotEnv(envFile);
  const sourceOf = (name, fromDotEnv) => {
    if (fromDotEnv) return '.env';
    return process.env[name] !== undefined ? 'environment' : 'not set';
  };

  // .env wins. `MODEL=` is accepted as an alias because that is the name this
  // project's old .env used, and OPENROUTER_MODEL/OPENROUTER_API_KEY are the
  // names everything else uses.
  const keyFromFile = fromFile.OPENROUTER_API_KEY ?? fromFile.OPENROUTER_KEY;
  const modelFromFile = fromFile.OPENROUTER_MODEL ?? fromFile.MODEL;

  const apiKey = overrides.apiKey || keyFromFile || process.env.OPENROUTER_API_KEY || '';
  const chosen = overrides.model || modelFromFile || process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash-1017';
  const { model, normalised } = normalizeModel(chosen);

  const replaced = (fromFileValue, inheritedValue) =>
    Boolean(fromFileValue) && inheritedValue !== undefined && inheritedValue !== fromFileValue;

  return {
    apiKey,
    apiKeySource: overrides.apiKey ? 'override' : sourceOf('OPENROUTER_API_KEY', keyFromFile),
    apiKeyOverrodeShell: replaced(keyFromFile, inherited.apiKey),
    model,
    modelSource: overrides.model ? 'flag' : sourceOf('OPENROUTER_MODEL', modelFromFile),
    modelOverrodeShell: replaced(modelFromFile, inherited.model),
    modelNormalised: normalised,
    workspaceRoot: path.resolve(PROJECT_ROOT, process.env.WORKSPACE_DIR || 'workspace'),
    commandPolicy: process.env.CMD_POLICY || 'ask', // allow | ask | deny
    maxSteps: Number(process.env.MAX_STEPS) || 12,
    envFile: envFile ?? path.join(PROJECT_ROOT, '.env'),
  };
}
