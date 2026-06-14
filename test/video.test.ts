/**
 * Tests for `src/tools/video.ts` (AC-8).
 *
 * Covers the seven mocked-lifecycle cases the iter-034 / iter-035 reviews
 * enumerated. The video flow is async-first: `mmx_video_generate`
 * submits a task and returns `{ task_id, status, model }`; with
 * `wait=true` it polls `mmx_video_status` until the task reaches a
 * terminal state or the deadline expires.
 *
 * The seven cases:
 *   (a) async mode (`wait=false`) returns `{ task_id, status, model }`
 *       immediately on the submit response, with no polling;
 *   (b) `wait=true` polls `Processing` → `Success` and returns the
 *       resolved task object as JSON text;
 *   (c) `wait=true` polls `Processing` → `Fail` and returns the failed
 *       task object as JSON text (no error envelope);
 *   (d) `wait=true` polls `Processing` forever and hits the
 *       `wait_timeout_seconds` budget — returns an `isError: true`
 *       result with the documented `(mmx_code=0, http_status=0,
 *       mcp_code=5)` envelope. Driven via `pollVideoTask(...)`'s
 *       `sleepFn` seam so the test runs in ms;
 *   (e) `mmx_video_status(task_id)` returns the raw task object as a
 *       JSON text block;
 *   (f) `mmx_video_download(task_id, save_path)` errors with
 *       `(mcp_code=5)` when the task is not in `Success` status;
 *   (g) `mmx_video_download(task_id, save_path)` writes the file
 *       bytes to `save_path` when the task is in `Success` status
 *       (mock the `/v1/files/retrieve` endpoint + the hosted
 *       download URL with a separate MockAgent origin pool).
 *
 * Uses `undici`'s `MockAgent` so the suite runs offline (AC-12's
 * "no live network calls by default" guarantee).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  videoGenerateHandler,
  videoStatusHandler,
  videoDownloadHandler,
  pollVideoTask,
  VIDEO_STATUS_SUCCESS,
  VIDEO_STATUS_FAIL,
  MCP_ERROR_TIMEOUT_MAPPED,
} from '../src/tools/video.js';
import { MmxcClient } from '../src/client.js';
import { MCP_ERROR_TIMEOUT } from '../src/errors.js';

interface MockResp {
  status: number;
  body: unknown;
}

const API_BASE = 'https://api.minimax.io/v1';
const FILES_ORIGIN = 'https://files.example.com';
const FILES_DOWNLOAD_PATH = '/videos/abc.mp4';

/**
 * Install a fresh `MockAgent` as the global dispatcher, queue the
 * given responses on the MiniMax API pool, and return both the agent
 * and a freshly-constructed `MmxcClient` (with `baseUrl` pinned to
 * the test API host so the matching pool is the one we populated).
 */
function setupApiMock(responses: MockResp[]): { client: MmxcClient; mock: MockAgent } {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get('https://api.minimax.io');
  for (const r of responses) {
    pool
      .intercept({ path: '/v1/video_generation', method: 'POST' })
      .reply(r.status, JSON.stringify(r.body), {
        headers: { 'content-type': 'application/json' },
      });
  }
  const client = new MmxcClient({
    apiKey: 'sk-test',
    region: 'global',
    baseUrl: API_BASE,
  });
  return { client, mock };
}

const originalDispatcher = getGlobalDispatcher();

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

/* ------------------------------------------------------------------ *
 * (a) async mode returns { task_id, status, model } immediately.      *
 * ------------------------------------------------------------------ */

describe('videoGenerateHandler (AC-8, async mode)', () => {
  it('(a) returns { task_id, status, model } as a JSON text block on the submit response, with no polling', async () => {
    const { client } = setupApiMock([
      {
        status: 200,
        body: { task_id: 't-123', base_resp: { status_code: 0, status_msg: 'ok' } },
      },
    ]);
    const result = await videoGenerateHandler({ prompt: 'a cat playing piano' }, client);
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const parsed = JSON.parse((block as { type: 'text'; text: string }).text) as Record<string, unknown>;
    // Required AC-8 keys:
    expect(parsed.task_id).toBe('t-123');
    expect(parsed.status).toBe('submitted');
    expect(parsed.model).toBe('MiniMax-Hailuo-2.3');
    // No polling happened: only the POST was mocked. If the handler
    // had polled, the MockAgent would have thrown an "unmatched
    // request" error — the successful return above is itself the
    // assertion.
  });
});

/* ------------------------------------------------------------------ *
 * (b)(c)(d) wait=true polling lifecycle.                              *
 * ------------------------------------------------------------------ */

describe('videoGenerateHandler (AC-8, wait=true polling lifecycle)', () => {
  /**
   * Build a video-pipeline mock: one POST submit, then a sequence of
   * GET status responses (one per poll), then optionally a GET
   * `/files/retrieve` and a hosted download URL on a separate
   * origin pool. The intercepts are ordered: POST first, then each
   * GET status, then `files/retrieve`, then the hosted download.
   */
  function setupPollMock(opts: {
    submitTaskId: string;
    statusSequence: Array<{ status: string; file_id?: string }>;
    filesRetrieve?: { file_id: string; download_url: string };
    downloadBytes?: Buffer;
  }): { client: MmxcClient; mock: MockAgent } {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const apiPool = mock.get('https://api.minimax.io');

    // 1. POST submit.
    apiPool
      .intercept({ path: '/v1/video_generation', method: 'POST' })
      .reply(
        200,
        JSON.stringify({ task_id: opts.submitTaskId, base_resp: { status_code: 0, status_msg: 'ok' } }),
        { headers: { 'content-type': 'application/json' } },
      );

    // 2. GET status (one intercept per poll, queued in order).
    for (const snap of opts.statusSequence) {
      apiPool
        .intercept({
          path: `/v1/query/video_generation?task_id=${opts.submitTaskId}`,
          method: 'GET',
        })
        .reply(
          200,
          JSON.stringify({
            task_id: opts.submitTaskId,
            status: snap.status,
            ...(snap.file_id ? { file_id: snap.file_id } : {}),
            base_resp: { status_code: 0, status_msg: 'ok' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
    }

    // 3. GET /files/retrieve.
    if (opts.filesRetrieve) {
      apiPool
        .intercept({
          path: `/v1/files/retrieve?file_id=${opts.filesRetrieve.file_id}`,
          method: 'GET',
        })
        .reply(
          200,
          JSON.stringify({
            file: {
              file_id: opts.filesRetrieve.file_id,
              download_url: opts.filesRetrieve.download_url,
            },
            base_resp: { status_code: 0, status_msg: 'ok' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
    }

    // 4. Hosted download URL on a separate origin.
    if (opts.downloadBytes) {
      const filesPool = mock.get(FILES_ORIGIN);
      filesPool
        .intercept({ path: FILES_DOWNLOAD_PATH, method: 'GET' })
        .reply(200, opts.downloadBytes, { headers: { 'content-type': 'video/mp4' } });
    }

    const client = new MmxcClient({
      apiKey: 'sk-test',
      region: 'global',
      baseUrl: API_BASE,
    });
    return { client, mock };
  }

  /** A no-op sleep — the polling loop accepts a custom sleepFn. */
  const instantSleep = (): Promise<void> => new Promise<void>((resolve) => resolve());

  it('(b) wait=true polls Processing → Success and returns the resolved task', async () => {
    const { client } = setupPollMock({
      submitTaskId: 't-b',
      statusSequence: [
        { status: 'Processing' },
        { status: VIDEO_STATUS_SUCCESS, file_id: 'file-b' },
      ],
    });
    const result = await videoGenerateHandler(
      {
        prompt: 'a cat playing piano',
        wait: true,
        wait_timeout_seconds: 30,
        poll_interval_seconds: 1,
      },
      client,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const parsed = JSON.parse((block as { type: 'text'; text: string }).text) as Record<string, unknown>;
    expect(parsed.task_id).toBe('t-b');
    expect(parsed.status).toBe(VIDEO_STATUS_SUCCESS);
    expect(parsed.file_id).toBe('file-b');
  });

  it('(c) wait=true polls Processing → Fail and returns the failed task (not an error envelope)', async () => {
    const { client } = setupPollMock({
      submitTaskId: 't-c',
      statusSequence: [{ status: 'Processing' }, { status: VIDEO_STATUS_FAIL }],
    });
    const result = await videoGenerateHandler(
      {
        prompt: 'a cat playing piano',
        wait: true,
        wait_timeout_seconds: 30,
        poll_interval_seconds: 1,
      },
      client,
    );
    // Fail is a *resolved* terminal state — the AC text says
    // "returns the resolved task when status is succeeded/failed",
    // so the handler should return the task (no error envelope).
    expect(result.isError).toBeFalsy();
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const parsed = JSON.parse((block as { type: 'text'; text: string }).text) as Record<string, unknown>;
    expect(parsed.task_id).toBe('t-c');
    expect(parsed.status).toBe(VIDEO_STATUS_FAIL);
  });

  it('(d) wait=true hits wait_timeout_seconds and returns an isError with mcp_code=5', async () => {
    // Queue 5 pending responses — well over the 1-poll-per-instant
    // budget of timeoutSeconds=2, intervalSeconds=1.
    const { client } = setupPollMock({
      submitTaskId: 't-d',
      statusSequence: Array.from({ length: 5 }, () => ({ status: 'Processing' })),
    });
    // Drive the poll directly with a no-op sleepFn so the test
    // runs in ms (no real wall time). The handler's
    // `pollVideoTask` call uses the default real `setTimeout`
    // sleep, so we additionally assert the handler's timeout
    // path via the exported `pollVideoTask` itself.
    const result = await videoGenerateHandler(
      {
        prompt: 'a cat playing piano',
        wait: true,
        wait_timeout_seconds: 2,
        poll_interval_seconds: 1,
      },
      client,
    );
    // (d-i) The handler's own wait=true path uses real setTimeout,
    // so we separately drive the polling loop with the sleepFn
    // seam to assert the timeout error shape.
    expect(result.isError).toBe(true);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    // Envelope must include the prefix + the mcp_code=5 marker
    // per the mmx-cli TIMEOUT convention.
    expect(text.startsWith('mmx_video_generate: ')).toBe(true);
    expect(text).toContain('timed out');
    expect(text).toContain('mcp_code=' + MCP_ERROR_TIMEOUT);
  });

  it('(d-direct) pollVideoTask with a no-op sleepFn returns timedOut=true and the last pending snapshot', async () => {
    // Drive the loop without real setTimeout so this is fast.
    const { client } = setupPollMock({
      submitTaskId: 't-d-direct',
      statusSequence: Array.from({ length: 5 }, () => ({ status: 'Processing' })),
    });
    const result = await pollVideoTask(client, 't-d-direct', {
      intervalSeconds: 1,
      timeoutSeconds: 2,
      sleepFn: instantSleep,
    });
    expect(result.timedOut).toBe(true);
    expect(result.task.task_id).toBe('t-d-direct');
    expect(result.task.status).toBe('Processing');
  });
});

/* ------------------------------------------------------------------ *
 * (e) mmx_video_status returns the raw task object.                  *
 * ------------------------------------------------------------------ */

describe('videoStatusHandler (AC-8)', () => {
  it('(e) returns the raw task object as a JSON text block', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get('https://api.minimax.io')
      .intercept({ path: '/v1/query/video_generation?task_id=t-raw', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          task_id: 't-raw',
          status: VIDEO_STATUS_SUCCESS,
          file_id: 'file-raw',
          progress: 100,
          base_resp: { status_code: 0, status_msg: 'ok' },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const client = new MmxcClient({
      apiKey: 'sk-test',
      region: 'global',
      baseUrl: API_BASE,
    });
    const result = await videoStatusHandler({ task_id: 't-raw' }, client);
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const parsed = JSON.parse((block as { type: 'text'; text: string }).text) as Record<string, unknown>;
    // The raw object must include every field the API returned —
    // not a sanitized subset.
    expect(parsed.task_id).toBe('t-raw');
    expect(parsed.status).toBe(VIDEO_STATUS_SUCCESS);
    expect(parsed.file_id).toBe('file-raw');
    expect(parsed.progress).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * (f)(g) mmx_video_download.                                          *
 * ------------------------------------------------------------------ */

describe('videoDownloadHandler (AC-8)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mmxomni-video-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('(f) errors with mcp_code=5 when the task is not in Success status', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get('https://api.minimax.io')
      .intercept({ path: '/v1/query/video_generation?task_id=t-pending', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          task_id: 't-pending',
          status: 'Processing',
          base_resp: { status_code: 0, status_msg: 'ok' },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const client = new MmxcClient({
      apiKey: 'sk-test',
      region: 'global',
      baseUrl: API_BASE,
    });
    const result = await videoDownloadHandler(
      { task_id: 't-pending', save_path: join(tmpDir, 'out.mp4') },
      client,
    );
    expect(result.isError).toBe(true);
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    // The error envelope: mmx_video_download: ... mcp_code=5.
    expect(text.startsWith('mmx_video_download: ')).toBe(true);
    expect(text).toContain('not in `Success` status');
    expect(text).toContain('mcp_code=' + MCP_ERROR_TIMEOUT);
  });

  it('(g) writes the file bytes to save_path when the task is in Success status', async () => {
    const videoBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const downloadUrl = `${FILES_ORIGIN}${FILES_DOWNLOAD_PATH}`;

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const apiPool = mock.get('https://api.minimax.io');
    // 1. GET status (Success, file_id).
    apiPool
      .intercept({ path: '/v1/query/video_generation?task_id=t-done', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          task_id: 't-done',
          status: VIDEO_STATUS_SUCCESS,
          file_id: 'file-done',
          base_resp: { status_code: 0, status_msg: 'ok' },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    // 2. GET /v1/files/retrieve (download_url).
    apiPool
      .intercept({ path: '/v1/files/retrieve?file_id=file-done', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          file: { file_id: 'file-done', download_url: downloadUrl },
          base_resp: { status_code: 0, status_msg: 'ok' },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    // 3. Hosted download URL on a separate origin.
    mock
      .get(FILES_ORIGIN)
      .intercept({ path: FILES_DOWNLOAD_PATH, method: 'GET' })
      .reply(200, videoBytes, { headers: { 'content-type': 'video/mp4' } });

    const client = new MmxcClient({
      apiKey: 'sk-test',
      region: 'global',
      baseUrl: API_BASE,
    });
    const savePath = join(tmpDir, 'out.mp4');
    const result = await videoDownloadHandler({ task_id: 't-done', save_path: savePath }, client);
    expect(result.isError).toBeFalsy();
    const block = result.content[0]!;
    expect(block.type).toBe('text');
    const text = (block as { type: 'text'; text: string }).text;
    expect(text).toContain('Video downloaded');
    expect(text).toContain(savePath);
    // Verify the on-disk file has the exact bytes the hosted URL returned.
    const onDisk = await readFile(savePath);
    expect(onDisk.equals(videoBytes)).toBe(true);
    expect(onDisk.length).toBe(videoBytes.length);
  });
});
