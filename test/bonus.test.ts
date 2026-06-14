/**
 * Tests for AC-9: bonus tools behind the `--enable-bonus` / `MMXOMNI_BONUS=1` feature flag.
 *
 * Two surfaces are covered:
 *
 *   1. The `tools/list` smoke test (server-level). With `enableBonus: false`
 *      the server advertises exactly the six core tools; with
 *      `enableBonus: true` the same server advertises the six core plus
 *      the three bonus tools (`mmx_vision_describe`, `mmx_search_query`,
 *      `mmx_quota_show`).
 *
 *   2. One mocked-lifecycle case per bonus tool. The `undici` `MockAgent`
 *      intercepts the API call each tool would make, the handler runs
 *      against a real `MmxcClient`, and the result is asserted.
 *
 * No live network calls are made: the test runs offline against
 * `https://api.minimax.io` and is restored to the original global
 * dispatcher in `afterEach`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createServer } from '../src/server.js';
import { MmxcClient } from '../src/client.js';
import {
  BONUS_TOOL_NAMES,
  CORE_TOOL_NAMES,
  MMXOMNI_BONUS_ENV,
  resolveEnableBonus,
} from '../src/tools/index.js';
import { visionDescribeHandler } from '../src/tools/vision.js';
import { searchQueryHandler } from '../src/tools/search.js';
import { quotaShowHandler } from '../src/tools/quota.js';
import {
  MCP_ERROR_AUTH,
  MCP_ERROR_CONTENT_FILTER,
  MCP_ERROR_GENERIC,
  MCP_ERROR_QUOTA,
} from '../src/errors.js';

const originalDispatcher = getGlobalDispatcher();

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

interface MockedResponse {
  status: number;
  body: unknown;
  /** Full path to intercept, including the `/v1` prefix. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
}

function setupMockedClient(responses: MockedResponse[]): {
  client: MmxcClient;
  mock: MockAgent;
} {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get('https://api.minimax.io');
  for (const r of responses) {
    pool
      .intercept({ path: r.path, method: r.method ?? 'GET' })
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

function getRegisteredToolNames(server: McpServer): string[] {
  // The MCP SDK exposes registered tools via the private `_registeredTools`
  // map on `McpServer`. The test asserts the *registration* set rather
  // than going through the full `tools/list` request handler so we don't
  // depend on a transport.
  const reg = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(reg).sort();
}

// Full paths the bonus tools hit (baseUrl + module path).
const VISION_PATH = '/v1/vision/describe';
const SEARCH_PATH = '/v1/search/query';
const QUOTA_PATH = '/v1/account/quota';

describe('AC-9 feature flag (tools/list smoke test)', () => {
  it('advertises only the six core tools when enableBonus is false', () => {
    const { client } = setupMockedClient([]);
    const server = createServer({ version: '0.0.0-test', client, enableBonus: false });
    const names = getRegisteredToolNames(server);
    expect(names).toEqual([...CORE_TOOL_NAMES].sort());
    // Sanity: bonus tool names must be absent.
    for (const bn of BONUS_TOOL_NAMES) {
      expect(names).not.toContain(bn);
    }
  });

  it('advertises six core + three bonus tools when enableBonus is true', () => {
    const { client } = setupMockedClient([]);
    const server = createServer({ version: '0.0.0-test', client, enableBonus: true });
    const names = getRegisteredToolNames(server);
    const expected = new Set<string>([...CORE_TOOL_NAMES, ...BONUS_TOOL_NAMES]);
    expect(new Set(names)).toEqual(expected);
    // And the count must be exactly 9.
    expect(names).toHaveLength(9);
  });

  it('defaults to enableBonus=false when the option is omitted', () => {
    const { client } = setupMockedClient([]);
    const server = createServer({ version: '0.0.0-test', client });
    const names = getRegisteredToolNames(server);
    expect(names).toEqual([...CORE_TOOL_NAMES].sort());
  });
});

describe('resolveEnableBonus', () => {
  it('honors an explicit true CLI value over an unset env', () => {
    expect(resolveEnableBonus(true, {})).toBe(true);
  });
  it('honors an explicit false CLI value over an env=1', () => {
    expect(resolveEnableBonus(false, { [MMXOMNI_BONUS_ENV]: '1' })).toBe(false);
  });
  it('falls back to env=1 when CLI is undefined', () => {
    expect(resolveEnableBonus(undefined, { [MMXOMNI_BONUS_ENV]: '1' })).toBe(true);
  });
  it('accepts env values "true", "yes", "on" (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'Yes', 'on', '  on  ']) {
      expect(resolveEnableBonus(undefined, { [MMXOMNI_BONUS_ENV]: v })).toBe(true);
    }
  });
  it('rejects empty / unrecognized env values', () => {
    for (const v of ['', '  ', '0', 'false', 'no', 'off', 'random']) {
      expect(resolveEnableBonus(undefined, { [MMXOMNI_BONUS_ENV]: v })).toBe(false);
    }
  });
});

describe('mmx_vision_describe (bonus tool)', () => {
  it('returns a text block with the description on a 200 response', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: VISION_PATH,
        method: 'POST',
        body: { description: 'A red apple on a wooden table.', base_resp: { status_code: 0, status_msg: 'ok' } },
      },
    ]);
    const result = await visionDescribeHandler(
      { image_url: 'https://example.com/red.png' },
      client,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    expect((block as { type: 'text'; text: string }).text).toBe('A red apple on a wooden table.');
  });

  it('rejects calls that supply neither image_url nor image_base64', async () => {
    const { client } = setupMockedClient([]);
    const result = await visionDescribeHandler({}, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_vision_describe');
    expect(text).toContain('image_url');
    expect(text).toContain('image_base64');
  });

  it('surfaces base_resp.status_code=1004 (quota) as mcp_code=4', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: VISION_PATH,
        method: 'POST',
        body: { base_resp: { status_code: 1004, status_msg: 'rate limit' } },
      },
    ]);
    const result = await visionDescribeHandler({ image_url: 'https://example.com/x.png' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.startsWith('mmx_vision_describe: ')).toBe(true);
    expect(text).toContain('(mmx_code=1004, http_status=200, mcp_code=' + MCP_ERROR_QUOTA + ')');
  });

  it('maps HTTP 401 to mcp_code=3 (auth)', async () => {
    const { client } = setupMockedClient([
      { status: 401, path: VISION_PATH, method: 'POST', body: { message: 'unauthorized' } },
    ]);
    const result = await visionDescribeHandler({ image_url: 'https://example.com/x.png' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(mmx_code=0, http_status=401, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('maps base_resp.status_code=1026 (content filter) to mcp_code=10', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: VISION_PATH,
        method: 'POST',
        body: { base_resp: { status_code: 1026, status_msg: 'input content review failed' } },
      },
    ]);
    const result = await visionDescribeHandler({ image_url: 'https://example.com/x.png' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(mmx_code=1026, http_status=200, mcp_code=' + MCP_ERROR_CONTENT_FILTER + ')');
  });
});

describe('mmx_search_query (bonus tool)', () => {
  it('returns the raw results array as a JSON text block', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: SEARCH_PATH,
        method: 'POST',
        body: {
          results: [
            { title: 'Apple', url: 'https://example.com/apple', snippet: 'fruit' },
            { title: 'Pear', url: 'https://example.com/pear', snippet: 'also fruit' },
          ],
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const result = await searchQueryHandler({ query: 'apple' }, client);
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text) as Array<{ title: string; url: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.title).toBe('Apple');
    expect(parsed[0]!.url).toBe('https://example.com/apple');
  });

  it('rejects empty / missing queries without hitting the network', async () => {
    const { client } = setupMockedClient([]);
    const result = await searchQueryHandler({ query: '' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_search_query');
    expect(text).toContain('query is required');
  });

  it('maps base_resp.status_code=1001 (invalid api key) to mcp_code=3', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: SEARCH_PATH,
        method: 'POST',
        body: { base_resp: { status_code: 1001, status_msg: 'invalid api key' } },
      },
    ]);
    const result = await searchQueryHandler({ query: 'apple' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(mmx_code=1001, http_status=200, mcp_code=' + MCP_ERROR_AUTH + ')');
  });

  it('maps HTTP 500 to mcp_code=1 (generic) after retries', async () => {
    // 4 attempts (initial + 3 retries) for a 5xx terminal response.
    const { client } = setupMockedClient([
      { status: 500, path: SEARCH_PATH, method: 'POST', body: { message: 'boom' } },
      { status: 500, path: SEARCH_PATH, method: 'POST', body: { message: 'boom' } },
      { status: 500, path: SEARCH_PATH, method: 'POST', body: { message: 'boom' } },
      { status: 500, path: SEARCH_PATH, method: 'POST', body: { message: 'boom' } },
    ]);
    const result = await searchQueryHandler({ query: 'apple' }, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(mmx_code=0, http_status=500, mcp_code=' + MCP_ERROR_GENERIC + ')');
  });
});

describe('mmx_quota_show (bonus tool)', () => {
  it('returns a concise summary by default (used/remaining/limit/reset_at/plan)', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: QUOTA_PATH,
        body: {
          used: 42,
          remaining: 958,
          limit: 1000,
          reset_at: '2026-07-01T00:00:00Z',
          plan: 'token-plan',
          base_resp: { status_code: 0, status_msg: 'ok' },
        },
      },
    ]);
    const result = await quotaShowHandler({ verbose: false }, client);
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.used).toBe(42);
    expect(parsed.remaining).toBe(958);
    expect(parsed.limit).toBe(1000);
    expect(parsed.reset_at).toBe('2026-07-01T00:00:00Z');
    expect(parsed.plan).toBe('token-plan');
    // Concise summary must not include the base_resp envelope.
    expect(parsed.base_resp).toBeUndefined();
  });

  it('returns the raw API response when verbose=true', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: QUOTA_PATH,
        body: {
          used: 42,
          remaining: 958,
          base_resp: { status_code: 0, status_msg: 'ok' },
          extra_field: 'kept in verbose',
        },
      },
    ]);
    const result = await quotaShowHandler({ verbose: true }, client);
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.extra_field).toBe('kept in verbose');
    expect(parsed.base_resp).toBeDefined();
  });

  it('maps base_resp.status_code=1004 (rate limit) to mcp_code=4', async () => {
    const { client } = setupMockedClient([
      {
        status: 200,
        path: QUOTA_PATH,
        body: { base_resp: { status_code: 1004, status_msg: 'rate limit' } },
      },
    ]);
    const result = await quotaShowHandler({}, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text.startsWith('mmx_quota_show: ')).toBe(true);
    expect(text).toContain('(mmx_code=1004, http_status=200, mcp_code=' + MCP_ERROR_QUOTA + ')');
  });

  it('maps HTTP 401 to mcp_code=3 (auth) with the mmx_quota_show: prefix', async () => {
    const { client } = setupMockedClient([
      { status: 401, path: QUOTA_PATH, body: { message: 'unauthorized' } },
    ]);
    const result = await quotaShowHandler({}, client);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('mmx_quota_show: unauthorized');
    expect(text).toContain('(mmx_code=0, http_status=401, mcp_code=' + MCP_ERROR_AUTH + ')');
  });
});
