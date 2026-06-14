/**
 * Tests for `src/config.ts` — auth and region precedence.
 *
 * Covers the strict precedence documented in the plan:
 *   API key: --api-key > MINIMAX_API_KEY env > ~/.mmx/credentials.json
 *            `MINIMAX_API_KEY` field > ~/.mmx/config.json `api_key` field
 *   Region:  --region > MINIMAX_REGION env > ~/.mmx/credentials.json
 *            `MINIMAX_REGION` field > ~/.mmx/config.json `region` field > 'global'
 *
 * Missing API key -> assertApiKey returns exit code 3 and writes a
 * human-readable diagnostic to stderr.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  resolveApiKey,
  resolveRegion,
  resolveConfig,
  assertApiKey,
  DEFAULT_REGION,
  ENV_API_KEY,
  ENV_REGION,
} from '../src/config.js';

interface FsFixture {
  home: string;
  files: Record<string, string>;
}

function makeFs(fixture: FsFixture) {
  return {
    homedir: fixture.home,
    fileExists: (p: string) => p in fixture.files,
    readFile: (p: string) => {
      if (!(p in fixture.files)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return fixture.files[p] ?? '';
    },
  };
}

describe('resolveApiKey precedence', () => {
  it('returns the CLI value when it is a non-empty string', () => {
    const r = resolveApiKey('sk-cli', { env: {}, homedir: '/h', fileExists: () => false, readFile: () => '' });
    expect(r).toEqual({ value: 'sk-cli', source: 'cli' });
  });

  it('skips an empty CLI value and falls through to env', () => {
    const r = resolveApiKey('   ', { env: { MINIMAX_API_KEY: 'sk-env' }, homedir: '/h', fileExists: () => false, readFile: () => '' });
    expect(r).toEqual({ value: 'sk-env', source: 'env' });
  });

  it('returns the env value when no CLI value is given', () => {
    const r = resolveApiKey(undefined, { env: { MINIMAX_API_KEY: 'sk-env' }, homedir: '/h', fileExists: () => false, readFile: () => '' });
    expect(r).toEqual({ value: 'sk-env', source: 'env' });
  });

  it('reads MINIMAX_API_KEY from ~/.mmx/credentials.json after env', () => {
    const fs = makeFs({
      home: '/home/u',
      files: {
        '/home/u/.mmx/credentials.json': JSON.stringify({ MINIMAX_API_KEY: 'sk-creds' }),
      },
    });
    const r = resolveApiKey(undefined, { env: {}, ...fs });
    expect(r).toEqual({ value: 'sk-creds', source: 'credentials.json' });
  });

  it('reads api_key from ~/.mmx/config.json as the final fallback', () => {
    const fs = makeFs({
      home: '/home/u',
      files: {
        '/home/u/.mmx/config.json': JSON.stringify({ api_key: 'sk-cfg' }),
      },
    });
    const r = resolveApiKey(undefined, { env: {}, ...fs });
    expect(r).toEqual({ value: 'sk-cfg', source: 'config.json' });
  });

  it('returns null when nothing is set', () => {
    const r = resolveApiKey(undefined, { env: {}, homedir: '/h', fileExists: () => false, readFile: () => '' });
    expect(r).toEqual({ value: null, source: null });
  });

  it('CLI > env > credentials.json > config.json (full ordering)', () => {
    const fs = makeFs({
      home: '/home/u',
      files: {
        '/home/u/.mmx/credentials.json': JSON.stringify({ MINIMAX_API_KEY: 'sk-creds' }),
        '/home/u/.mmx/config.json': JSON.stringify({ api_key: 'sk-cfg' }),
      },
    });
    // CLI wins
    expect(resolveApiKey('sk-cli', { env: { MINIMAX_API_KEY: 'sk-env' }, ...fs })).toEqual({
      value: 'sk-cli',
      source: 'cli',
    });
    // env beats credentials when CLI is unset
    expect(resolveApiKey(undefined, { env: { MINIMAX_API_KEY: 'sk-env' }, ...fs })).toEqual({
      value: 'sk-env',
      source: 'env',
    });
    // credentials beats config when env is unset
    expect(resolveApiKey(undefined, { env: {}, ...fs })).toEqual({
      value: 'sk-creds',
      source: 'credentials.json',
    });
    // config is the last resort
    expect(
      resolveApiKey(undefined, {
        env: {},
        homedir: '/home/u',
        fileExists: (p) => p === '/home/u/.mmx/config.json',
        readFile: (p) => '{"api_key":"sk-cfg"}',
      }),
    ).toEqual({ value: 'sk-cfg', source: 'config.json' });
  });

  it('treats an empty string in credentials.json as absent', () => {
    const fs = makeFs({
      home: '/home/u',
      files: {
        '/home/u/.mmx/credentials.json': JSON.stringify({ MINIMAX_API_KEY: '' }),
        '/home/u/.mmx/config.json': JSON.stringify({ api_key: 'sk-cfg' }),
      },
    });
    const r = resolveApiKey(undefined, { env: {}, ...fs });
    expect(r).toEqual({ value: 'sk-cfg', source: 'config.json' });
  });

  it('treats a corrupt credentials.json as absent and falls through to config.json', () => {
    const fs = makeFs({
      home: '/home/u',
      files: {
        '/home/u/.mmx/credentials.json': 'not-json{',
        '/home/u/.mmx/config.json': JSON.stringify({ api_key: 'sk-cfg' }),
      },
    });
    const r = resolveApiKey(undefined, { env: {}, ...fs });
    expect(r).toEqual({ value: 'sk-cfg', source: 'config.json' });
  });
});

describe('resolveRegion precedence', () => {
  it('CLI value wins', () => {
    const r = resolveRegion('cn', { env: { MINIMAX_REGION: 'global' }, homedir: '/h', fileExists: () => false, readFile: () => '' });
    expect(r).toEqual({ value: 'cn', source: 'cli' });
  });

  it('env is next', () => {
    const r = resolveRegion(undefined, { env: { MINIMAX_REGION: 'cn' }, homedir: '/h', fileExists: () => false, readFile: () => '' });
    expect(r).toEqual({ value: 'cn', source: 'env' });
  });

  it('credentials.json MINIMAX_REGION field is next', () => {
    const fs = makeFs({
      home: '/home/u',
      files: { '/home/u/.mmx/credentials.json': JSON.stringify({ MINIMAX_REGION: 'cn' }) },
    });
    const r = resolveRegion(undefined, { env: {}, ...fs });
    expect(r).toEqual({ value: 'cn', source: 'credentials.json' });
  });

  it('config.json region field is next', () => {
    const fs = makeFs({
      home: '/home/u',
      files: { '/home/u/.mmx/config.json': JSON.stringify({ region: 'cn' }) },
    });
    const r = resolveRegion(undefined, { env: {}, ...fs });
    expect(r).toEqual({ value: 'cn', source: 'config.json' });
  });

  it('defaults to "global" when nothing is set', () => {
    const r = resolveRegion(undefined, { env: {}, homedir: '/h', fileExists: () => false, readFile: () => '' });
    expect(r).toEqual({ value: DEFAULT_REGION, source: 'default' });
    expect(DEFAULT_REGION).toBe('global');
  });
});

describe('resolveConfig', () => {
  it('returns the combined resolution in one call', () => {
    const fs = makeFs({
      home: '/home/u',
      files: {
        '/home/u/.mmx/credentials.json': JSON.stringify({ MINIMAX_API_KEY: 'sk-c', MINIMAX_REGION: 'cn' }),
      },
    });
    const c = resolveConfig({}, { env: {}, ...fs });
    expect(c.apiKey).toBe('sk-c');
    expect(c.apiKeySource).toBe('credentials.json');
    expect(c.region).toBe('cn');
    expect(c.regionSource).toBe('credentials.json');
  });
});

describe('assertApiKey', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns ok=true when the API key is present (no stderr output)', () => {
    const r = assertApiKey(
      { apiKey: 'sk-x', region: 'global', apiKeySource: 'env', regionSource: 'default' },
      'mmxomni',
    );
    expect(r).toEqual({ ok: true });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns code 3 and writes a human-readable diagnostic when the key is missing', () => {
    const r = assertApiKey(
      { apiKey: null, region: 'global', apiKeySource: null, regionSource: 'default' },
      'mmxomni',
    );
    expect(r).toEqual({ ok: false, code: 3 });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]?.[0] ?? '');
    expect(written).toContain('mmxomni');
    expect(written).toContain('--api-key');
    expect(written).toContain(ENV_API_KEY);
    expect(written).toContain('credentials.json');
    expect(written).toContain('config.json');
  });
});
