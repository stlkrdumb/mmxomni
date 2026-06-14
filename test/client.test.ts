/**
 * Tests for AC-10: the shared HTTP client (`src/client.ts`) and
 * MiniMax error normalization (`src/errors.ts`).
 *
 * What this file verifies, mapped to the AC-10 contract:
 *
 *   1. `undici` is the transport (`request()` from `undici`).
 *   2. `Authorization: Bearer <apiKey>` is set on every request.
 *   3. The base URL is swapped by region (`global` / `cn` / unknown).
 *   4. A `baseUrl` override wins over the region lookup.
 *   5. Idempotent retries: up to 3 retries on 429/5xx, none on 401/403/4xx.
 *   6. Exponential backoff is applied between retries.
 *   7. Error bodies are normalized to `{ code, message, httpStatus }`.
 *   8. MCP error codes map 1 / 3 / 4 / 5 / 10 (mmx-cli exit-code table).
 *
 * All tests use `undici`'s `MockAgent` and `enableCallHistory()` so the
 * network is never touched and the per-request call count is asserted
 * explicitly (e.g. "exactly 4 attempts for a terminal 5xx").
 */

import { describe, it, expect, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

import { MmxcClient, regionBaseUrl } from '../src/client.js';
import {
  MmxcError,
  normalizeApiError,
  mapHttpStatusToMcpCode,
  MCP_ERROR_AUTH,
  MCP_ERROR_CONTENT_FILTER,
  MCP_ERROR_GENERIC,
  MCP_ERROR_QUOTA,
  MCP_ERROR_TIMEOUT,
} from '../src/errors.js';

const originalDispatcher = getGlobalDispatcher();

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

const GLOBAL_ORIGIN = 'https://api.minimax.io';
const CN_ORIGIN = 'https://api.minimaxi.cn';

interface MockedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface MockHandle {
  client: MmxcClient;
  mock: MockAgent;
}

/**
 * Build a fresh mock dispatcher with N interceptors on `/v1/test` POST.
 * Each `.intercept()` is single-shot by default, so the responses array
 * must contain exactly one entry per expected HTTP attempt.
 */
function setupMock(responses: MockedResponse[]): MockHandle {
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock.enableCallHistory();
  setGlobalDispatcher(mock);
  const pool = mock.get(GLOBAL_ORIGIN);
  for (const r of responses) {
    pool
      .intercept({ path: '/v1/test', method: 'POST' })
      .reply(r.status, JSON.stringify(r.body ?? {}), {
        headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
      });
  }
  const client = new MmxcClient({
    apiKey: 'sk-test',
    region: 'global',
    retryBaseMs: 1,
  });
  return { client, mock };
}

function callsTo(mock: MockAgent, path: string): number {
  return mock.getCallHistory()!.filterCalls({ path }).length;
}

describe('regionBaseUrl', () => {
  it('returns the global base URL for region=global', () => {
    expect(regionBaseUrl('global')).toBe('https://api.minimax.io/v1');
  });
  it('returns the cn base URL for region=cn', () => {
    expect(regionBaseUrl('cn')).toBe('https://api.minimaxi.cn/v1');
  });
  it('falls back to global for unknown regions', () => {
    expect(regionBaseUrl('mars')).toBe('https://api.minimax.io/v1');
    expect(regionBaseUrl('')).toBe('https://api.minimax.io/v1');
  });
});

describe('MmxcClient construction', () => {
  it('rejects an empty or whitespace apiKey', () => {
    expect(() => new MmxcClient({ apiKey: '', region: 'global' })).toThrow(/apiKey is required/);
    expect(() => new MmxcClient({ apiKey: '   ', region: 'global' })).toThrow(/apiKey is required/);
  });
  it('exposes the resolved base URL via getBaseUrl()', () => {
    expect(new MmxcClient({ apiKey: 'sk-x', region: 'global' }).getBaseUrl()).toBe(
      'https://api.minimax.io/v1',
    );
    expect(new MmxcClient({ apiKey: 'sk-x', region: 'cn' }).getBaseUrl()).toBe(
      'https://api.minimaxi.cn/v1',
    );
  });
  it('honors a baseUrl override (test/staging)', () => {
    expect(
      new MmxcClient({
        apiKey: 'sk-x',
        region: 'global',
        baseUrl: 'https://staging.example.com/v1',
      }).getBaseUrl(),
    ).toBe('https://staging.example.com/v1');
  });
});

describe('MmxcClient.request — happy path', () => {
  it('returns parsed JSON on a 200 response', async () => {
    const { client } = setupMock([{ status: 200, body: { ok: true, n: 42 } }]);
    const res = await client.request<{ ok: boolean; n: number }>({
      method: 'POST',
      path: '/test',
      body: { foo: 'bar' },
    });
    expect(res).toEqual({ ok: true, n: 42 });
  });

  it('returns null on a 200 with empty body', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get(GLOBAL_ORIGIN)
      .intercept({ path: '/v1/empty', method: 'GET' })
      .reply(200, '', { headers: { 'content-type': 'application/json' } });
    const client = new MmxcClient({ apiKey: 'sk-test', region: 'global', retryBaseMs: 1 });
    const res = await client.request<unknown>({ method: 'GET', path: '/empty' });
    expect(res).toBeNull();
  });

  it('passes through a non-JSON 200 body as a string', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get(GLOBAL_ORIGIN)
      .intercept({ path: '/v1/text', method: 'GET' })
      .reply(200, 'plain text response', { headers: { 'content-type': 'text/plain' } });
    const client = new MmxcClient({ apiKey: 'sk-test', region: 'global', retryBaseMs: 1 });
    const res = await client.request<unknown>({ method: 'GET', path: '/text' });
    expect(res).toBe('plain text response');
  });
});

describe('MmxcClient.request — request shape (auth, headers, body)', () => {
  it('sets Authorization: Bearer <apiKey>', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    let capturedAuth: string | undefined;
    mock
      .get(GLOBAL_ORIGIN)
      .intercept({ path: '/v1/test', method: 'POST' })
      .reply((opts) => {
        // undici passes through the original headers (we send `Authorization`
        // with capital A in `src/client.ts`), so we look up both casings.
        const h = opts.headers as Record<string, string | string[] | undefined>;
        const raw = h['Authorization'] ?? h['authorization'];
        capturedAuth = Array.isArray(raw) ? raw[0] : raw;
        return {
          statusCode: 200,
          data: '{"ok":true}',
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    const client = new MmxcClient({ apiKey: 'sk-abc-123', region: 'global', retryBaseMs: 1 });
    await client.request({ method: 'POST', path: '/test', body: { x: 1 } });
    expect(capturedAuth).toBe('Bearer sk-abc-123');
  });

  it('serializes the body as JSON and sets Content-Type: application/json', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    let capturedBody: string | undefined;
    let capturedContentType: string | undefined;
    mock
      .get(GLOBAL_ORIGIN)
      .intercept({ path: '/v1/test', method: 'POST' })
      .reply((opts) => {
        capturedBody = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        const h = opts.headers as Record<string, string | string[] | undefined>;
        const raw = h['Content-Type'] ?? h['content-type'];
        capturedContentType = Array.isArray(raw) ? raw[0] : raw;
        return {
          statusCode: 200,
          data: '{"ok":true}',
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    const client = new MmxcClient({ apiKey: 'sk-test', region: 'global', retryBaseMs: 1 });
    await client.request({ method: 'POST', path: '/test', body: { prompt: 'apple', n: 1 } });
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody!)).toEqual({ prompt: 'apple', n: 1 });
    expect(capturedContentType).toBe('application/json');
  });

  it('omits the body for GET (no request body sent)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    let capturedBody: unknown = 'NOT_SET';
    mock
      .get(GLOBAL_ORIGIN)
      .intercept({ path: '/v1/empty', method: 'GET' })
      .reply((opts) => {
        capturedBody = opts.body;
        return {
          statusCode: 200,
          data: '{"ok":true}',
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    const client = new MmxcClient({ apiKey: 'sk-test', region: 'global', retryBaseMs: 1 });
    await client.request({ method: 'GET', path: '/empty' });
    expect(capturedBody === undefined || capturedBody === null || capturedBody === '').toBe(true);
  });
});

describe('MmxcClient.request — region swap', () => {
  it('hits api.minimax.io for region=global', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableCallHistory();
    setGlobalDispatcher(mock);
    mock
      .get(GLOBAL_ORIGIN)
      .intercept({ path: '/v1/test', method: 'POST' })
      .reply(200, '{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const client = new MmxcClient({ apiKey: 'sk-test', region: 'global', retryBaseMs: 1 });
    await client.request({ method: 'POST', path: '/test' });
    expect(callsTo(mock, '/v1/test')).toBe(1);
  });

  it('hits api.minimaxi.cn for region=cn', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableCallHistory();
    setGlobalDispatcher(mock);
    mock
      .get(CN_ORIGIN)
      .intercept({ path: '/v1/test', method: 'POST' })
      .reply(200, '{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const client = new MmxcClient({ apiKey: 'sk-test', region: 'cn', retryBaseMs: 1 });
    await client.request({ method: 'POST', path: '/test' });
    const cnCalls = mock.getCallHistory()!.filterCalls({ origin: CN_ORIGIN }).length;
    const globalCalls = mock.getCallHistory()!.filterCalls({ origin: GLOBAL_ORIGIN }).length;
    expect(cnCalls).toBe(1);
    expect(globalCalls).toBe(0);
  });

  it('falls back to api.minimax.io for an unknown region', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableCallHistory();
    setGlobalDispatcher(mock);
    mock
      .get(GLOBAL_ORIGIN)
      .intercept({ path: '/v1/test', method: 'POST' })
      .reply(200, '{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const client = new MmxcClient({ apiKey: 'sk-test', region: 'mars', retryBaseMs: 1 });
    await client.request({ method: 'POST', path: '/test' });
    const globalCalls = mock.getCallHistory()!.filterCalls({ origin: GLOBAL_ORIGIN }).length;
    expect(globalCalls).toBe(1);
  });

  it('honors a baseUrl override (does not consult the region lookup)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableCallHistory();
    setGlobalDispatcher(mock);
    const stagingOrigin = 'https://staging.example.com';
    mock
      .get(stagingOrigin)
      .intercept({ path: '/v1/test', method: 'POST' })
      .reply(200, '{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const client = new MmxcClient({
      apiKey: 'sk-test',
      region: 'cn',
      baseUrl: 'https://staging.example.com/v1',
      retryBaseMs: 1,
    });
    await client.request({ method: 'POST', path: '/test' });
    const stagingCalls = mock
      .getCallHistory()!
      .filterCalls({ origin: stagingOrigin }).length;
    const cnCalls = mock.getCallHistory()!.filterCalls({ origin: CN_ORIGIN }).length;
    expect(stagingCalls).toBe(1);
    expect(cnCalls).toBe(0);
  });
});

describe('MmxcClient.request — error mapping (AC-10: 1/3/4/5/10)', () => {
  it('HTTP 401 → MmxcError with httpStatus=401, code=0, mcp_code=3 (auth)', async () => {
    const { client } = setupMock([{ status: 401, body: { message: 'unauthorized' } }]);
    try {
      await client.request({ method: 'POST', path: '/test' });
      throw new Error('expected to throw');
    } catch (err) {
      const e = err as MmxcError;
      expect(e).toBeInstanceOf(MmxcError);
      expect(e.httpStatus).toBe(401);
      expect(e.code).toBe(0);
      expect(e.message).toContain('unauthorized');
      expect(e.toMcpErrorCode()).toBe(MCP_ERROR_AUTH);
    }
  });

  it('HTTP 403 → mcp_code=3 (auth)', async () => {
    const { client } = setupMock([{ status: 403, body: { message: 'forbidden' } }]);
    try {
      await client.request({ method: 'POST', path: '/test' });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as MmxcError).toMcpErrorCode()).toBe(MCP_ERROR_AUTH);
    }
  });

  it('HTTP 429 → mcp_code=4 (quota)', async () => {
    // 4 attempts (initial + 3 retries), all 429. 429 is retryable.
    const { client } = setupMock([
      { status: 429, body: { message: 'rl-1' } },
      { status: 429, body: { message: 'rl-2' } },
      { status: 429, body: { message: 'rl-3' } },
      { status: 429, body: { message: 'rl-4' } },
    ]);
    try {
      await client.request({ method: 'POST', path: '/test' });
      throw new Error('expected to throw');
    } catch (err) {
      const e = err as MmxcError;
      expect(e.httpStatus).toBe(429);
      expect(e.toMcpErrorCode()).toBe(MCP_ERROR_QUOTA);
    }
  });

  it('HTTP 500 → mcp_code=1 (generic)', async () => {
    // 4 attempts (initial + 3 retries), all 500. The 4th throws MmxcError.
    const { client } = setupMock([
      { status: 500, body: { message: 'boom-1' } },
      { status: 500, body: { message: 'boom-2' } },
      { status: 500, body: { message: 'boom-3' } },
      { status: 500, body: { message: 'boom-4' } },
    ]);
    try {
      await client.request({ method: 'POST', path: '/test' });
      throw new Error('expected to throw');
    } catch (err) {
      const e = err as MmxcError;
      expect(e.httpStatus).toBe(500);
      expect(e.toMcpErrorCode()).toBe(MCP_ERROR_GENERIC);
    }
  });

  it('HTTP 408 → mcp_code=5 (timeout)', async () => {
    // 408 is not in the 429/5xx retry set, so a single attempt.
    const { client } = setupMock([{ status: 408, body: { message: 'request timeout' } }]);
    try {
      await client.request({ method: 'POST', path: '/test' });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as MmxcError).toMcpErrorCode()).toBe(MCP_ERROR_TIMEOUT);
    }
  });

  it('MiniMax base_resp.status_code=1026 → mcp_code=10 (content filter)', () => {
    // For 2xx responses with a non-zero base_resp.status_code, the tool
    // handler (not the client) is responsible for checking the body and
    // throwing an `MmxcError` via `normalizeApiError`. This test asserts
    // the mapping at the error-class level: a `MmxcError` constructed
    // from a 1026 body maps to MCP code 10 regardless of HTTP status.
    const apiErr = normalizeApiError(200, {
      base_resp: { status_code: 1026, status_msg: 'input content review failed' },
    });
    const e = new MmxcError(apiErr);
    expect(e.httpStatus).toBe(200);
    expect(e.code).toBe(1026);
    expect(e.toMcpErrorCode()).toBe(MCP_ERROR_CONTENT_FILTER);
  });

  it('MiniMax base_resp.status_code=1004 (rate limit) → mcp_code=4 (quota)', () => {
    const apiErr = normalizeApiError(200, {
      base_resp: { status_code: 1004, status_msg: 'rate limit exceeded' },
    });
    const e = new MmxcError(apiErr);
    expect(e.code).toBe(1004);
    expect(e.toMcpErrorCode()).toBe(MCP_ERROR_QUOTA);
  });

  it('MiniMax base_resp.status_code=1001 (invalid api key) → mcp_code=3 (auth)', () => {
    const apiErr = normalizeApiError(200, {
      base_resp: { status_code: 1001, status_msg: 'invalid api key' },
    });
    const e = new MmxcError(apiErr);
    expect(e.toMcpErrorCode()).toBe(MCP_ERROR_AUTH);
  });
});

describe('MmxcClient.request — retry behavior (AC-10)', () => {
  it('retries up to 3 times on 5xx (4 total attempts, then throws)', async () => {
    const { client, mock } = setupMock([
      { status: 500, body: { message: 'a' } },
      { status: 500, body: { message: 'b' } },
      { status: 500, body: { message: 'c' } },
      { status: 500, body: { message: 'd' } },
    ]);
    await expect(client.request({ method: 'POST', path: '/test' })).rejects.toBeInstanceOf(
      MmxcError,
    );
    expect(callsTo(mock, '/v1/test')).toBe(4);
  });

  it('retries up to 3 times on 429 (4 total attempts, then throws)', async () => {
    const { client, mock } = setupMock([
      { status: 429, body: { message: 'rl-1' } },
      { status: 429, body: { message: 'rl-2' } },
      { status: 429, body: { message: 'rl-3' } },
      { status: 429, body: { message: 'rl-4' } },
    ]);
    await expect(client.request({ method: 'POST', path: '/test' })).rejects.toBeInstanceOf(
      MmxcError,
    );
    expect(callsTo(mock, '/v1/test')).toBe(4);
  });

  it('stops retrying as soon as a 2xx succeeds', async () => {
    const { client, mock } = setupMock([
      { status: 500, body: { message: 'a' } },
      { status: 500, body: { message: 'b' } },
      { status: 200, body: { ok: true } },
    ]);
    const res = await client.request<{ ok: boolean }>({ method: 'POST', path: '/test' });
    expect(res).toEqual({ ok: true });
    expect(callsTo(mock, '/v1/test')).toBe(3);
  });

  it('does NOT retry on 401 (single attempt)', async () => {
    const { client, mock } = setupMock([{ status: 401, body: { message: 'unauthorized' } }]);
    await expect(client.request({ method: 'POST', path: '/test' })).rejects.toBeInstanceOf(
      MmxcError,
    );
    expect(callsTo(mock, '/v1/test')).toBe(1);
  });

  it('does NOT retry on 403 (single attempt)', async () => {
    const { client, mock } = setupMock([{ status: 403, body: { message: 'forbidden' } }]);
    await expect(client.request({ method: 'POST', path: '/test' })).rejects.toBeInstanceOf(
      MmxcError,
    );
    expect(callsTo(mock, '/v1/test')).toBe(1);
  });

  it('does NOT retry on 400 (single attempt)', async () => {
    const { client, mock } = setupMock([{ status: 400, body: { message: 'bad request' } }]);
    await expect(client.request({ method: 'POST', path: '/test' })).rejects.toBeInstanceOf(
      MmxcError,
    );
    expect(callsTo(mock, '/v1/test')).toBe(1);
  });

  it('applies exponential backoff between retries (1ms * 2^attempt)', async () => {
    // 4 attempts at 1ms base: delays are 1, 2, 4 ms = 7ms total minimum.
    // We assert a lower bound only (timing assertions on real timers are flaky).
    const { client } = setupMock([
      { status: 500, body: { message: 'a' } },
      { status: 500, body: { message: 'b' } },
      { status: 500, body: { message: 'c' } },
      { status: 500, body: { message: 'd' } },
    ]);
    const t0 = Date.now();
    await expect(client.request({ method: 'POST', path: '/test' })).rejects.toBeInstanceOf(
      MmxcError,
    );
    const elapsed = Date.now() - t0;
    // 1+2+4 = 7ms of backoff; tolerate any test environment jitter.
    expect(elapsed).toBeGreaterThanOrEqual(6);
  });

  it('respects a custom maxRetries override (e.g. 1 retry = 2 total attempts)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableCallHistory();
    setGlobalDispatcher(mock);
    for (let i = 0; i < 2; i++) {
      mock
        .get(GLOBAL_ORIGIN)
        .intercept({ path: '/v1/test', method: 'POST' })
        .reply(500, `{"i":${i}}`, { headers: { 'content-type': 'application/json' } });
    }
    const client = new MmxcClient({
      apiKey: 'sk-test',
      region: 'global',
      maxRetries: 1,
      retryBaseMs: 1,
    });
    await expect(client.request({ method: 'POST', path: '/test' })).rejects.toBeInstanceOf(
      MmxcError,
    );
    expect(callsTo(mock, '/v1/test')).toBe(2);
  });
});

describe('normalizeApiError', () => {
  it('reduces the base_resp shape to { code, message, httpStatus, raw }', () => {
    const e = normalizeApiError(200, {
      base_resp: { status_code: 1026, status_msg: 'blocked' },
    });
    expect(e).toEqual({
      code: 1026,
      message: 'blocked',
      httpStatus: 200,
      raw: { base_resp: { status_code: 1026, status_msg: 'blocked' } },
    });
  });

  it('reduces the {code, message} shape to the canonical form', () => {
    const e = normalizeApiError(401, { code: 1001, message: 'invalid api key' });
    expect(e.code).toBe(1001);
    expect(e.message).toBe('invalid api key');
    expect(e.httpStatus).toBe(401);
  });

  it('accepts a string `code` and coerces to number', () => {
    const e = normalizeApiError(400, { code: '1026', message: 'blocked' });
    expect(e.code).toBe(1026);
  });

  it('falls back to HTTP <status> when the body is null', () => {
    const e = normalizeApiError(503, null);
    expect(e.code).toBe(0);
    expect(e.message).toBe('HTTP 503');
    expect(e.httpStatus).toBe(503);
  });

  it('falls back to HTTP <status> when the body has neither base_resp nor code/message', () => {
    const e = normalizeApiError(500, { something: 'else' });
    expect(e.code).toBe(0);
    expect(e.message).toBe('HTTP 500');
  });

  it('uses the raw body string as the message when it is a string', () => {
    const e = normalizeApiError(500, 'plain text error');
    expect(e.code).toBe(0);
    expect(e.message).toBe('plain text error');
    expect(e.httpStatus).toBe(500);
  });
});

describe('mapHttpStatusToMcpCode (mmx-cli exit-code table)', () => {
  it('401/403 → 3 (auth)', () => {
    expect(mapHttpStatusToMcpCode(401)).toBe(MCP_ERROR_AUTH);
    expect(mapHttpStatusToMcpCode(403)).toBe(MCP_ERROR_AUTH);
  });
  it('408 → 5 (timeout)', () => {
    expect(mapHttpStatusToMcpCode(408)).toBe(MCP_ERROR_TIMEOUT);
  });
  it('429 → 4 (quota)', () => {
    expect(mapHttpStatusToMcpCode(429)).toBe(MCP_ERROR_QUOTA);
  });
  it('5xx → 1 (generic)', () => {
    expect(mapHttpStatusToMcpCode(500)).toBe(MCP_ERROR_GENERIC);
    expect(mapHttpStatusToMcpCode(502)).toBe(MCP_ERROR_GENERIC);
    expect(mapHttpStatusToMcpCode(599)).toBe(MCP_ERROR_GENERIC);
  });
  it('other 4xx → 1 (generic)', () => {
    expect(mapHttpStatusToMcpCode(418)).toBe(MCP_ERROR_GENERIC);
  });
});
