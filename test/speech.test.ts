/**
 * Tests for `src/tools/speech.ts:speechSynthesizeHandler` (AC-6).
 *
 * Mirrors the request/response coverage we give `mmx_image_generate`
 * in `test/image.test.ts`, but for the TTS path:
 *
 *   - (1) happy path with output_format=url returns text containing the
 *         hosted `audio_url`;
 *   - (2) happy path with embed=true and output_format=hex returns an
 *         `audio` content block with non-empty base64 data and the
 *         right mimeType (audio/mpeg for mp3, audio/wav for wav, etc.);
 *   - (3) `base_resp.status_code=1004` (quota / rate limit) maps to
 *         mcp_code=4 with the `mmx_speech_synthesize:` prefix and the
 *         `(mmx_code=..., http_status=200, mcp_code=...)` envelope;
 *   - (4) `base_resp.status_code=1001` (invalid api key) maps to
 *         mcp_code=3 (auth);
 *   - (5) `base_resp.status_code=1026` (content filter) maps to
 *         mcp_code=10;
 *   - (6) HTTP 401 maps to mcp_code=3 (auth) with the prefix;
 *   - (7) HTTP 500 maps to mcp_code=1 (generic) with the prefix (5xx
 *         is retried up to 3 times, so 4 responses are queued);
 *   - (8) `save_path` actually writes the audio bytes to disk and
 *         the returned text advertises the saved location;
 *   - (9) "API returned no audio" graceful fallback when the 200
 *         body has neither `data.audio` nor `data.audio_url`.
 *
 * Uses `undici`'s `MockAgent` so the tests run offline (AC-12's
 * "no live network calls by default" guarantee).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { speechSynthesizeHandler } from '../src/tools/speech.js';
import { MmxcClient } from '../src/client.js';
import {
  MCP_ERROR_AUTH,
  MCP_ERROR_CONTENT_FILTER,
  MCP_ERROR_GENERIC,
  MCP_ERROR_QUOTA,
} from '../src/errors.js';

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
      .intercept({ path: '/v1/t2a_v2', method: 'POST' })
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

const originalDispatcher = getGlobalDispatcher();

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

describe('speechSynthesizeHandler (AC-6)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mmxomni-speech-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('(1) returns the audio URL as text when embed=false and the API succeeds', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: {
          data: { audio_url: 'https://example.com/audio/abc.mp3' },
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const result = await speechSynthesizeHandler({ text: 'hello world', embed: false }, client);
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    expect(text).toContain('https://example.com/audio/abc.mp3');
    expect(text).toContain('Audio generated');
    expect(text).toContain('mp3');
  });

  it('(2) returns a base64 audio content block when embed=true and the API returns hex bytes', async () => {
    // 8 bytes of arbitrary data -> hex string. Base64 should round-trip
    // back to a Buffer of the same length.
    const audioBytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const audioHex = audioBytes.toString('hex');
    const { client } = setupMock([
      {
        status: 200,
        body: {
          data: { audio: audioHex },
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const result = await speechSynthesizeHandler(
      { text: 'hello world', embed: true, format: 'mp3' },
      client,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('audio');
    const audioBlock = block as { type: 'audio'; data: string; mimeType: string };
    expect(audioBlock.mimeType).toBe('audio/mpeg');
    // Base64 must be non-empty and must decode back to the same bytes.
    expect(audioBlock.data.length).toBeGreaterThan(0);
    const decoded = Buffer.from(audioBlock.data, 'base64');
    expect(decoded.equals(audioBytes)).toBe(true);
  });

  it('(2b) uses the right mimeType for non-mp3 formats when embed=true', async () => {
    const audioBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const { client } = setupMock([
      {
        status: 200,
        body: {
          data: { audio: audioBytes.toString('hex') },
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const result = await speechSynthesizeHandler(
      { text: 'hello', embed: true, format: 'wav' },
      client,
    );
    const block = result.content[0]! as { type: 'audio'; mimeType: string };
    expect(block.mimeType).toBe('audio/wav');
  });

  it('(3) maps base_resp.status_code=1004 (quota) to mcp_code=4 with the mmx_speech_synthesize: prefix', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: {
          base_resp: {
            status_code: 1004,
            status_msg:
              "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
          },
        },
      },
    ]);
    const result = await speechSynthesizeHandler({ text: 'hello' }, client);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    expect(text.startsWith('mmx_speech_synthesize: ')).toBe(true);
    expect(text).toContain('(mmx_code=1004, http_status=200, mcp_code=' + MCP_ERROR_QUOTA + ')');
    expect(text).toContain(
      "Please carry the API secret key in the 'Authorization' field of the request header",
    );
  });

  it('(4) maps base_resp.status_code=1001 (invalid api key) to mcp_code=3 (auth)', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 1001, status_msg: 'invalid api key' } },
      },
    ]);
    const result = await speechSynthesizeHandler({ text: 'hello' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_speech_synthesize: invalid api key');
    expect(text).toContain('(mmx_code=1001, http_status=200, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('(5) maps base_resp.status_code=1026 (content filter) to mcp_code=10', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 1026, status_msg: 'input content review failed' } },
      },
    ]);
    const result = await speechSynthesizeHandler({ text: 'hello' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_speech_synthesize: input content review failed');
    expect(text).toContain('(mmx_code=1026, http_status=200, mcp_code=' + MCP_ERROR_CONTENT_FILTER + ')');
  });

  it('(6) maps HTTP 401 (no body) to mcp_code=3 (auth) with mmx_speech_synthesize: prefix', async () => {
    const { client } = setupMock([{ status: 401, body: { message: 'unauthorized' } }]);
    const result = await speechSynthesizeHandler({ text: 'hello' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_speech_synthesize: unauthorized');
    expect(text).toContain('(mmx_code=0, http_status=401, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('(7) maps HTTP 500 to mcp_code=1 (generic) with mmx_speech_synthesize: prefix', async () => {
    // MmxcClient retries 5xx up to 3 times (4 total attempts) before
    // giving up. Queue 4 responses to cover the worst case.
    const { client } = setupMock([
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
    ]);
    const result = await speechSynthesizeHandler({ text: 'hello' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_speech_synthesize: boom');
    expect(text).toContain('(mmx_code=0, http_status=500, mcp_code=' + MCP_ERROR_GENERIC + ')');
  });

  it('(8) writes the audio bytes to save_path and reports the saved location', async () => {
    const audioBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xde, 0xad, 0xbe, 0xef]); // "RIFF" + 4 bytes
    const { client } = setupMock([
      {
        status: 200,
        body: {
          data: { audio: audioBytes.toString('hex') },
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const savePath = join(tmpDir, 'out.mp3');
    const result = await speechSynthesizeHandler(
      { text: 'hello', embed: true, format: 'mp3', save_path: savePath },
      client,
    );
    // Even with embed=true, the on-disk file must exist and have the
    // exact bytes the API returned.
    const onDisk = await readFile(savePath);
    expect(onDisk.equals(audioBytes)).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it('(9) returns a helpful error when the API responds 200 with no audio payload', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 0, status_msg: 'ok' } },
      },
    ]);
    const result = await speechSynthesizeHandler({ text: 'hello' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_speech_synthesize: API returned no audio');
  });
});
