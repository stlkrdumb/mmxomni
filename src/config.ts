/**
 * mmxomni — configuration resolution.
 *
 * Resolves the API key and region in this strict precedence:
 *
 *   API key:
 *     1. CLI flag `--api-key <value>`  (source: 'cli')
 *     2. Env var `MINIMAX_API_KEY`              (source: 'env')
 *     3. `MINIMAX_API_KEY` field in `~/.mmx/credentials.json`  (source: 'credentials.json')
 *     4. `api_key` field in `~/.mmx/config.json`               (source: 'config.json')
 *     -> If none of the above yield a non-empty string, the
 *        caller exits with code 3 and a human-readable stderr
 *        message (see `assertApiKey`).
 *
 *   Region:
 *     1. CLI flag `--region <value>`   (source: 'cli')
 *     2. Env var `MINIMAX_REGION`               (source: 'env')
 *     3. `MINIMAX_REGION` field in `~/.mmx/credentials.json`  (source: 'credentials.json')
 *     4. `region` field in `~/.mmx/config.json`               (source: 'config.json')
 *     -> Default: `'global'`.                    (source: 'default')
 *
 * Filesystem reads and `process.env` are abstracted behind a small
 * `ResolveDeps` object so the resolution logic is fully unit-testable
 * without monkey-patching `process.env` or touching the real home
 * directory.
 */

import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const DEFAULT_REGION = 'global';
export const ENV_API_KEY = 'MINIMAX_API_KEY';
export const ENV_REGION = 'MINIMAX_REGION';
export const CREDENTIALS_PATH = ['.mmx', 'credentials.json'];
export const CONFIG_PATH = ['.mmx', 'config.json'];

/** Where a value came from. `null` for `apiKeySource` means "not found". */
export type ConfigSource = 'cli' | 'env' | 'credentials.json' | 'config.json' | 'default';

export interface ResolvedConfig {
  /** Resolved API key, or `null` if no source yielded a non-empty value. */
  apiKey: string | null;
  /** Resolved region; always defined (defaults to `'global'`). */
  region: string;
  /** Which file/env/flag produced the API key; `null` when missing. */
  apiKeySource: ConfigSource | null;
  /** Which file/env/flag produced the region. */
  regionSource: ConfigSource;
}

export interface ResolveDeps {
  /** Environment lookup. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Home directory. Defaults to `os.homedir()`. */
  homedir?: string;
  /** `fs.existsSync` for tests. */
  fileExists?: (path: string) => boolean;
  /** `fs.readFileSync` (utf8) for tests. */
  readFile?: (path: string) => string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function readJsonFile(
  path: string,
  deps: Required<Pick<ResolveDeps, 'fileExists' | 'readFile'>>,
): Record<string, unknown> | null {
  if (!deps.fileExists(path)) return null;
  try {
    const raw = deps.readFile(path);
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt JSON or unreadable file is treated as "absent" rather than fatal,
    // so a partial config does not block the next precedence level.
  }
  return null;
}

/**
 * Resolve the API key across the four precedence levels. The first
 * non-empty string wins. Returns `{ value, source }` or `{ value: null,
 * source: null }` when no source yielded a key.
 */
export function resolveApiKey(
  cliValue: string | undefined,
  deps: ResolveDeps = {},
): { value: string | null; source: ConfigSource | null } {
  if (isNonEmptyString(cliValue)) return { value: cliValue, source: 'cli' };

  const env = deps.env ?? process.env;
  const fromEnv = env[ENV_API_KEY];
  if (isNonEmptyString(fromEnv)) return { value: fromEnv, source: 'env' };

  const home = deps.homedir ?? osHomedir();
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const fileDeps = { fileExists, readFile };

  const creds = readJsonFile(join(home, ...CREDENTIALS_PATH), fileDeps);
  if (creds && isNonEmptyString(creds[ENV_API_KEY])) {
    return { value: creds[ENV_API_KEY], source: 'credentials.json' };
  }

  const cfg = readJsonFile(join(home, ...CONFIG_PATH), fileDeps);
  if (cfg && isNonEmptyString(cfg.api_key)) {
    return { value: cfg.api_key, source: 'config.json' };
  }

  return { value: null, source: null };
}

/**
 * Resolve the region across the four precedence levels plus the
 * `'global'` default. The first non-empty string wins.
 */
export function resolveRegion(
  cliValue: string | undefined,
  deps: ResolveDeps = {},
): { value: string; source: ConfigSource } {
  if (isNonEmptyString(cliValue)) return { value: cliValue, source: 'cli' };

  const env = deps.env ?? process.env;
  const fromEnv = env[ENV_REGION];
  if (isNonEmptyString(fromEnv)) return { value: fromEnv, source: 'env' };

  const home = deps.homedir ?? osHomedir();
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const fileDeps = { fileExists, readFile };

  const creds = readJsonFile(join(home, ...CREDENTIALS_PATH), fileDeps);
  if (creds && isNonEmptyString(creds[ENV_REGION])) {
    return { value: creds[ENV_REGION], source: 'credentials.json' };
  }

  const cfg = readJsonFile(join(home, ...CONFIG_PATH), fileDeps);
  if (cfg && isNonEmptyString(cfg.region)) {
    return { value: cfg.region, source: 'config.json' };
  }

  return { value: DEFAULT_REGION, source: 'default' };
}

/** Resolve both fields in one call. */
export function resolveConfig(
  options: { cliApiKey?: string; cliRegion?: string },
  deps: ResolveDeps = {},
): ResolvedConfig {
  const api = resolveApiKey(options.cliApiKey, deps);
  const region = resolveRegion(options.cliRegion, deps);
  return {
    apiKey: api.value,
    region: region.value,
    apiKeySource: api.source,
    regionSource: region.source,
  };
}

/**
 * Exit-code-3 helper used by the CLI bootstrap when the API key is
 * missing. Writes a human-readable diagnostic to stderr (the only stream
 * mmxomni may use for logs; stdout is reserved for the MCP transport)
 * and returns the exit code. Keeping the function pure makes it easy
 * to unit-test the diagnostic text.
 */
export function assertApiKey(config: ResolvedConfig, programName: string): { ok: true } | { ok: false; code: 3 } {
  if (config.apiKey !== null) return { ok: true };
  const msg =
    `${programName}: MiniMax API key not found.\n` +
    `Provide it via one of (in precedence order):\n` +
    `  1. --api-key <key> CLI flag\n` +
    `  2. ${ENV_API_KEY} environment variable\n` +
    `  3. ${ENV_API_KEY} field in ~/.mmx/credentials.json\n` +
    `  4. api_key field in ~/.mmx/config.json\n` +
    `See ${programName} --help for more.`;
  process.stderr.write(msg + '\n');
  return { ok: false, code: 3 };
}
