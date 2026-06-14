/**
 * Tests for `src/tools/image.ts:imageGenerateHandler` (AC-5).
 *
 * Covers the regression fixed in iter-025: the `base_resp.status_code`
 * check on the MiniMax image endpoint must be inside the existing
 * `try { client.request } catch (err) { if (err instanceof MmxcError) ... }`
 * block so the catch can format the result with the
 * `mmx_image_generate:` prefix and the
 * `(mmx_code=..., http_status=..., mcp_code=...)` envelope.
 *
 * Uses `undici`'s `MockAgent` so the tests run offline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

import { imageGenerateHandler } from '../src/tools/image.js';
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
      .intercept({ path: '/v1/image_generation', method: 'POST' })
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

describe('imageGenerateHandler (AC-5)', () => {
  it('returns the image URL as text when embed=false and the API succeeds', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: {
          image_urls: ['https://example.com/a.png', 'https://example.com/b.png'],
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const result = await imageGenerateHandler({ prompt: 'a red apple', embed: false }, client);
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    expect(text).toContain('https://example.com/a.png');
    expect(text).toContain('https://example.com/b.png');
    expect(text).toContain('Image generated (2):');
  });

  it('surfaces base_resp.status_code=1004 (quota) as mcp_code=4 with the mmx_image_generate: prefix', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: {
          base_resp: {
            status_code: 1004,
            status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
          },
        },
      },
    ]);
    const result = await imageGenerateHandler({ prompt: 'a red apple' }, client);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    // Regression: prefix + envelope must both appear.
    expect(text.startsWith('mmx_image_generate: ')).toBe(true);
    expect(text).toContain('(mmx_code=1004, http_status=200, mcp_code=' + MCP_ERROR_QUOTA + ')');
    expect(text).toContain("Please carry the API secret key in the 'Authorization' field of the request header");
  });

  it('maps base_resp.status_code=1001 (invalid api key) to mcp_code=3 (auth)', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 1001, status_msg: 'invalid api key' } },
      },
    ]);
    const result = await imageGenerateHandler({ prompt: 'a red apple' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_image_generate: invalid api key');
    expect(text).toContain('(mmx_code=1001, http_status=200, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('maps base_resp.status_code=1026 (content filter) to mcp_code=10', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 1026, status_msg: 'input content review failed' } },
      },
    ]);
    const result = await imageGenerateHandler({ prompt: 'a red apple' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(mmx_code=1026, http_status=200, mcp_code=' + MCP_ERROR_CONTENT_FILTER + ')');
  });

  it('maps HTTP 401 (no body) to mcp_code=3 (auth) with mmx_image_generate: prefix', async () => {
    const { client } = setupMock([{ status: 401, body: { message: 'unauthorized' } }]);
    const result = await imageGenerateHandler({ prompt: 'a red apple' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_image_generate: unauthorized');
    expect(text).toContain('(mmx_code=0, http_status=401, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('maps HTTP 500 to mcp_code=1 (generic) with mmx_image_generate: prefix', async () => {
    // 5xx is retried up to 3 times by MmxcClient — that's 4 total
    // HTTP attempts (initial + 3 retries). Provide 4 responses.
    const { client } = setupMock([
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
    ]);
    const result = await imageGenerateHandler({ prompt: 'a red apple' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_image_generate: boom');
    expect(text).toContain('(mmx_code=0, http_status=500, mcp_code=' + MCP_ERROR_GENERIC + ')');
  });

  it('returns a helpful error when the API responds 200 with no image URLs', async () => {
    const { client } = setupMock([
      {
        status: 200,
        body: { base_resp: { status_code: 0, status_msg: 'ok' } },
      },
    ]);
    const result = await imageGenerateHandler({ prompt: 'a red apple' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_image_generate: API returned no image URLs');
  });
});
