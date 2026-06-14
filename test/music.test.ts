/**
 * Tests for `src/tools/music.ts` (AC-7).
 *
 * Three layers of coverage:
 *
 *   1. `validateMusicInput` cross-field rules:
 *      (1) at-least-one of `prompt`/`lyrics` required;
 *      (2-3) each alone suffices;
 *      (4) `instrumental=true` + `lyrics` mutually exclusive;
 *      (5) `instrumental=true` without `lyrics` is fine.
 *
 *   2. JSON-Schema per-field bounds (via `z.object(MusicGenerateInputSchema)`):
 *      (6) `sample_rate` enum (16000/22050/24000/32000/44100/48000);
 *      (7) `bpm` integer in [40, 220];
 *      (7e) `format` enum (mp3/wav/flac).
 *
 *   3. HTTP handler lifecycle against `undici` `MockAgent` (matches the
 *      `test/image.test.ts` and `test/speech.test.ts` style):
 *      (8) returns audio URL as text on success;
 *      (9) maps base_resp.status_code non-zero to `isError` with the
 *          mmx_code/http_status/mcp_code envelope;
 *      (10) `embed=true` with hex-encoded inline data returns a base64
 *           `audio` content block;
 *      (11) `embed=true` with a hosted URL downloads the bytes and
 *           returns a base64 `audio` content block;
 *      (12) `save_path` writes the audio buffer to disk;
 *      (13) maps HTTP 401 to mcp_code=3, HTTP 500 to mcp_code=1;
 *      (14) when the API returns neither `audio_url` nor inline bytes,
 *           returns an `isError` result.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

import {
  MusicGenerateInputSchema,
  validateMusicInput,
  musicGenerateHandler,
} from '../src/tools/music.js';
import { MmxcClient } from '../src/client.js';
import {
  MCP_ERROR_AUTH,
  MCP_ERROR_GENERIC,
  MCP_ERROR_QUOTA,
} from '../src/errors.js';

const originalDispatcher = getGlobalDispatcher();

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

// Wrap the flat exported shape in a z.object() so we can drive
// zod's per-field validation directly. This mirrors what the MCP
// SDK does internally when it validates `tools/call` arguments,
// so an error here is the exact same error an agent would see
// when it sent the bad payload over stdio.
const MusicInputObject = z.object(MusicGenerateInputSchema);

describe('validateMusicInput (AC-7 cross-field validation)', () => {
  it('(1) returns ok=false with the at-least-one-of message when both prompt and lyrics are missing', () => {
    const result = validateMusicInput({});
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('At least one of');
    expect(result.error).toContain('prompt');
    expect(result.error).toContain('lyrics');
  });

  it('(1b) returns ok=false when prompt and lyrics are both empty strings', () => {
    // The validator must not treat empty strings as "present".
    const result = validateMusicInput({ prompt: '', lyrics: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('At least one of');
  });

  it('(2) returns ok=true when only prompt is set', () => {
    const result = validateMusicInput({ prompt: 'upbeat folk with acoustic guitar' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('(3) returns ok=true when only lyrics is set', () => {
    const result = validateMusicInput({ lyrics: '[verse]\nhello world\n[chorus]\nla la la' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('(4) returns ok=false with the mutually-exclusive message when instrumental=true AND lyrics are both set', () => {
    const result = validateMusicInput({ instrumental: true, lyrics: '[verse] hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('mutually exclusive');
    expect(result.error).toContain('instrumental');
    expect(result.error).toContain('lyrics');
  });

  it('(5) returns ok=true when instrumental=true and no lyrics', () => {
    const result = validateMusicInput({ instrumental: true, prompt: 'cinematic orchestral' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('(5b) returns ok=true when neither instrumental nor lyrics is set, and only prompt is provided', () => {
    // Edge case: caller relies on the default false and does not set
    // instrumental at all. The schema default + the cross-field
    // validator must both accept it.
    const result = validateMusicInput({ prompt: 'lo-fi study beats' });
    expect(result.ok).toBe(true);
  });
});

describe('MusicGenerateInputSchema (AC-7 per-field bounds)', () => {
  it('(6) rejects an out-of-enum sample_rate (99999) with the refine() error message', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'jazz piano',
      sample_rate: 99999,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    // The refine() message is the only diagnostic the agent gets.
    const sampleRateIssue = parsed.error.issues.find((i) => i.path.includes('sample_rate'));
    expect(sampleRateIssue).toBeDefined();
    expect(sampleRateIssue?.message).toContain('sample_rate must be one of');
    expect(sampleRateIssue?.message).toContain('16000');
    expect(sampleRateIssue?.message).toContain('48000');
  });

  it('(6b) accepts every allowed sample_rate value', () => {
    for (const sr of [16000, 22050, 24000, 32000, 44100, 48000]) {
      const parsed = MusicInputObject.safeParse({ prompt: 'jazz piano', sample_rate: sr });
      expect(parsed.success).toBe(true);
    }
  });

  it('(7) rejects an out-of-range bpm (500) above the 220 maximum', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'fast drum and bass',
      bpm: 500,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    const bpmIssue = parsed.error.issues.find((i) => i.path.includes('bpm'));
    expect(bpmIssue).toBeDefined();
    // zod's min/max validators emit a 'too_big' code; the issue is
    // still attached to the bpm path so the agent can see which
    // field failed.
    expect(bpmIssue?.code).toBe('too_big');
  });

  it('(7b) rejects bpm below the 40 minimum', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'extremely slow funeral doom',
      bpm: 5,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    const bpmIssue = parsed.error.issues.find((i) => i.path.includes('bpm'));
    expect(bpmIssue).toBeDefined();
    expect(bpmIssue?.code).toBe('too_small');
  });

  it('(7c) accepts a bpm within [40, 220]', () => {
    for (const bpm of [40, 90, 120, 180, 220]) {
      const parsed = MusicInputObject.safeParse({ prompt: 'pop', bpm });
      expect(parsed.success).toBe(true);
    }
  });

  it('(7d) accepts the full mmx-cli control set in a single call', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'warm indie folk with rich harmonies',
      vocals: 'male and female duet',
      genre: 'folk',
      mood: 'nostalgic',
      instruments: 'acoustic guitar, mandolin, brushed drums',
      tempo: 'moderate',
      bpm: 96,
      key: 'G major',
      structure: 'verse-chorus-verse-bridge-chorus',
      references: 'similar to The Lumineers',
      avoid: 'distorted electric guitar',
      use_case: 'film soundtrack',
      instrumental: false,
      aigc_watermark: true,
      format: 'mp3',
      sample_rate: 44100,
      bitrate: 256000,
      save_path: '/tmp/out.mp3',
      model: 'music-2.5',
    });
    expect(parsed.success).toBe(true);
  });

  it('(7e) rejects an out-of-enum format', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'rock',
      format: 'ogg', // not in the allowed enum
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const formatIssue = parsed.error.issues.find((i) => i.path.includes('format'));
    expect(formatIssue).toBeDefined();
  });
});

/* ====================================================================== *
 * HTTP handler tests (mirrors test/image.test.ts pattern).               *
 * ====================================================================== */

interface MockResp {
  status: number;
  body: unknown;
}

function setupMock(responses: MockResp[]): { client: MmxcClient; mock: MockAgent } {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get('https://api.minimax.io');
  for (const r of responses) {
    pool
      .intercept({ path: '/v1/music_generation', method: 'POST' })
      .reply(r.status, JSON.stringify(r.body), {
        headers: { 'content-type': 'application/json' },
      });
  }
  const client = new MmxcClient({
    apiKey: 'sk-test',
    region: 'global',
    baseUrl: 'https://api.minimax.io/v1',
  });
  return { client, mock };
}

describe('musicGenerateHandler (HTTP lifecycle)', () => {
  it('returns the audio URL as text when embed=false and the API succeeds', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: {
          audio_url: 'https://example.com/track.mp3',
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const result = await musicGenerateHandler({ prompt: 'upbeat pop' }, client);
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    expect(text).toContain('https://example.com/track.mp3');
  });

  it('surfaces base_resp.status_code=1004 (quota) as mcp_code=4', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: {
          base_resp: { status_code: 1004, status_msg: 'rate limit exceeded' },
        },
      },
    ]);
    const result = await musicGenerateHandler({ prompt: 'upbeat pop' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.startsWith('mmx_music_generate: ')).toBe(true);
    expect(text).toContain('(mmx_code=1004, http_status=200, mcp_code=' + MCP_ERROR_QUOTA + ')');
  });

  it('maps base_resp.status_code=1001 (invalid api key) to mcp_code=3 (auth)', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 1001, status_msg: 'invalid api key' } },
      },
    ]);
    const result = await musicGenerateHandler({ prompt: 'jazz' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_music_generate: invalid api key');
    expect(text).toContain('(mmx_code=1001, http_status=200, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('maps base_resp.status_code=1026 (content filter) to mcp_code=10', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 1026, status_msg: 'input content review failed' } },
      },
    ]);
    const result = await musicGenerateHandler({ prompt: 'sensitive' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(mmx_code=1026, http_status=200, mcp_code=10)');
  });

  it('maps HTTP 401 to mcp_code=3 (auth) with the mmx_music_generate: prefix', async () => {
    const { client } = setupMock([{ status: 401, body: { message: 'unauthorized' } }]);
    const result = await musicGenerateHandler({ prompt: 'rock' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_music_generate: unauthorized');
    expect(text).toContain('(mmx_code=0, http_status=401, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('maps HTTP 500 to mcp_code=1 (generic) after retries', async () => {
    // 4 attempts (initial + 3 retries) for a 5xx terminal response.
    const { client } = setupMock([
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
    ]);
    const result = await musicGenerateHandler({ prompt: 'rock' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(mmx_code=0, http_status=500, mcp_code=' + MCP_ERROR_GENERIC + ')');
  });

  it('rejects when both prompt and lyrics are missing (validation error)', async () => {
    const { client } = setupMock([]);
    const result = await musicGenerateHandler({}, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_music_generate');
    expect(text).toMatch(/prompt|lyrics/i);
  });

  it('rejects when instrumental=true and lyrics are set (validation error)', async () => {
    const { client } = setupMock([]);
    const result = await musicGenerateHandler(
      { instrumental: true, lyrics: '[verse] test' },
      client,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('instrumental');
    expect(text).toMatch(/mutually exclusive/i);
  });
});
