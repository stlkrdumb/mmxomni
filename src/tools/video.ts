/**
 * mmx_video_generate / mmx_video_status / mmx_video_download — AC-8.
 *
 * MiniMax video generation is treated as an async task per mmx-cli:
 *
 *   1. POST /v1/video_generation                  → { task_id, base_resp }
 *   2. GET  /v1/query/video_generation?task_id=…  → { task_id, status, file_id, base_resp }
 *        status ∈ {Preparing, Queueing, Processing, Success, Fail}
 *        Success → file_id; Fail → error
 *   3. GET  /v1/files/retrieve?file_id=…          → { file: { download_url, … } }
 *   4. GET  <download_url>                        → raw video bytes
 *
 * `mmx_video_generate` returns a JSON text block with
 * `{ task_id, status, model }` by default (no polling). When
 * `wait=true`, it polls status every `poll_interval_seconds` (default
 * 5) up to `wait_timeout_seconds` (default 600) and returns the
 * resolved task when the status is `Success` / `Fail` — or, on
 * timeout, an MCP tool error with `mcp_code=5` per the mmx-cli
 * TIMEOUT convention.
 *
 * `mmx_video_status(task_id)` is a thin wrapper that returns the raw
 * task object (whatever the API returns) as a JSON text block.
 *
 * `mmx_video_download(task_id, save_path)` first fetches the status;
 * if `status !== "Success"` it errors (mcp_code=5). Otherwise it
 * resolves `file_id` → `download_url` via `/files/retrieve`, downloads
 * the bytes, and writes them to `save_path`.
 *
 * API errors are normalized via `src/errors.ts` and surfaced as
 * `{ isError: true, content: [...] }` tool results with the mapped
 * MCP code (1 / 3 / 4 / 5 / 10) in the human-readable text, mirroring
 * the image/speech envelope.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';
import { request as undiciRequest } from 'undici';

import type { MmxcClient } from '../client.js';
import { MmxcError, normalizeApiError, MCP_ERROR_TIMEOUT } from '../errors.js';
import { log } from '../log.js';

/** Canonical mmx-cli default video model. */
export const VIDEO_DEFAULT_MODEL = 'MiniMax-Hailuo-2.3';

/** mmx-cli default poll interval for synchronous video generation. */
export const VIDEO_DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** mmx-cli default wait timeout for synchronous video generation. */
export const VIDEO_DEFAULT_WAIT_TIMEOUT_SECONDS = 600;

/** mmx-cli default duration in seconds. */
export const VIDEO_DEFAULT_DURATION = 6;

/** mmx-cli default resolution. */
export const VIDEO_DEFAULT_RESOLUTION = '768P';

/** mmx-cli default prompt-optimizer flag (true = mmx-cli default). */
export const VIDEO_DEFAULT_PROMPT_OPTIMIZER = true;

/**
 * Status string returned by the video-generation endpoint once the
 * task has reached a terminal state. Matches the mmx-cli polling
 * script (`minimax_video.py`).
 */
export const VIDEO_STATUS_SUCCESS = 'Success';
export const VIDEO_STATUS_FAIL = 'Fail';

/** API paths. Appended to the resolved base URL. */
const VIDEO_SUBMIT_PATH = '/video_generation';
const VIDEO_STATUS_PATH = '/query/video_generation';
const VIDEO_FILE_RETRIEVE_PATH = '/files/retrieve';

/**
 * Allowed `duration` values (seconds). mmx-cli's `MiniMax-Hailuo-2.3`
 * model supports 6s and 10s. We use the same allow-list mmx-cli does
 * (and the I2V guide confirms 6s / 10s is the supported set).
 */
const DURATION_VALUES = [6, 10] as const;
type VideoDuration = (typeof DURATION_VALUES)[number];

/** Allowed `resolution` values. Mirrors the mmx-cli flag set. */
const RESOLUTION_VALUES = ['720P', '768P', '1080P'] as const;
type VideoResolution = (typeof RESOLUTION_VALUES)[number];

/* ------------------------------------------------------------------ *
 * Input schemas (Zod shapes; wrapped by the SDK into a ZodType).     *
 * ------------------------------------------------------------------ */

export const VideoGenerateInputSchema = {
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .max(2000, 'prompt exceeds MiniMax 2,000 char limit')
    .describe('Video description / storyboard text. Max 2,000 characters (mmx-cli limit).'),
  model: z
    .string()
    .default(VIDEO_DEFAULT_MODEL)
    .describe(
      `Video model ID. Default: \`${VIDEO_DEFAULT_MODEL}\` (mmx-cli canonical). ` +
        `Other supported values: \`MiniMax-Hailuo-02\`, \`T2V-01-Director\`, \`T2V-01\`, ` +
        `\`${VIDEO_DEFAULT_MODEL}-Fast\` (I2V).`,
    ),
  duration: z
    .number()
    .int()
    .refine((v) => (DURATION_VALUES as readonly number[]).includes(v), {
      message: `duration must be one of: ${DURATION_VALUES.join(', ')}`,
    })
    .default(VIDEO_DEFAULT_DURATION)
    .describe(`Video duration in seconds. Allowed: ${DURATION_VALUES.join(', ')}. Default: \`${VIDEO_DEFAULT_DURATION}\`.`),
  resolution: z
    .string()
    .refine((v) => (RESOLUTION_VALUES as readonly string[]).includes(v), {
      message: `resolution must be one of: ${RESOLUTION_VALUES.join(', ')}`,
    })
    .default(VIDEO_DEFAULT_RESOLUTION)
    .describe(
      `Output resolution. Allowed: ${RESOLUTION_VALUES.join(', ')}. Default: \`${VIDEO_DEFAULT_RESOLUTION}\`. ` +
        `Note: 1080P only supports 6s duration; 10s only available at 768P with Hailuo models.`,
    ),
  prompt_optimizer: z
    .boolean()
    .default(VIDEO_DEFAULT_PROMPT_OPTIMIZER)
    .describe(
      'When `true` (default), let the server optimize the prompt for video generation. ' +
        'Set `false` to send the prompt verbatim.',
    ),
  first_frame: z
    .string()
    .optional()
    .describe('Path or URL of an image to use as the first frame (image-to-video).'),
  callback_url: z
    .string()
    .url()
    .optional()
    .describe('Webhook URL invoked when the task completes. Default: none (poll for status).'),
  wait: z
    .boolean()
    .default(false)
    .describe(
      'When `true`, the tool polls `mmx_video_status` until the task is `Success` or `Fail`. ' +
        'When `false` (default), returns a `{ task_id, status, model }` JSON block immediately.',
    ),
  wait_timeout_seconds: z
    .number()
    .int()
    .min(1)
    .default(VIDEO_DEFAULT_WAIT_TIMEOUT_SECONDS)
    .describe(
      `Maximum total wait time in seconds when \`wait=true\`. Polling stops on timeout and returns a TIMEOUT error (code 5). Default: \`${VIDEO_DEFAULT_WAIT_TIMEOUT_SECONDS}\` (10 minutes).`,
    ),
  poll_interval_seconds: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(VIDEO_DEFAULT_POLL_INTERVAL_SECONDS)
    .describe(`Polling interval in seconds when \`wait=true\`. Default: \`${VIDEO_DEFAULT_POLL_INTERVAL_SECONDS}\`.`),
};

export const VideoStatusInputSchema = {
  task_id: z
    .string()
    .min(1, 'task_id is required')
    .describe('Video generation task ID returned by `mmx_video_generate`.'),
};

export const VideoDownloadInputSchema = {
  task_id: z
    .string()
    .min(1, 'task_id is required')
    .describe('Video generation task ID whose resulting file should be downloaded.'),
  save_path: z
    .string()
    .min(1, 'save_path is required')
    .describe('Local filesystem path to write the downloaded video to.'),
};

/* ------------------------------------------------------------------ *
 * Tool descriptions (advertised in `tools/list`).                    *
 * ------------------------------------------------------------------ */

export const VIDEO_GENERATE_DESCRIPTION =
  'Submit a video generation task via the MiniMax video API (default model `' +
  VIDEO_DEFAULT_MODEL +
  '`). ' +
  'Async by default: returns a JSON text block with `{ task_id, status, model }`. ' +
  'Set `wait=true` to poll `mmx_video_status` every `poll_interval_seconds` (default 5s) up to ' +
  '`wait_timeout_seconds` (default 600s) and return the resolved task when the status is `Success` or `Fail`. ' +
  'On timeout, returns a TIMEOUT error (MCP code 5).';

export const VIDEO_STATUS_DESCRIPTION =
  'Fetch the current status of a MiniMax video generation task by `task_id`. ' +
  'Returns the raw task object (status, progress, file URL when succeeded, error when failed) as a JSON text block.';

export const VIDEO_DOWNLOAD_DESCRIPTION =
  'Download the generated video file for a completed `mmx_video_generate` task. ' +
  'Errors (MCP code 5) if the task is not in `Success` status. Writes the file to `save_path`.';

export const VIDEO_GENERATE_TOOL_NAME = 'mmx_video_generate';
export const VIDEO_STATUS_TOOL_NAME = 'mmx_video_status';
export const VIDEO_DOWNLOAD_TOOL_NAME = 'mmx_video_download';

/* ------------------------------------------------------------------ *
 * API response types (defensive — we never assume every field is set).*
 * ------------------------------------------------------------------ */

export interface VideoSubmitResponse {
  task_id?: string;
  base_resp?: { status_code?: number; status_msg?: string };
}

export interface VideoTaskResponse {
  task_id?: string;
  status?: string;
  file_id?: string;
  /** mmx-cli also surfaces a `progress` field in some responses. */
  progress?: number;
  base_resp?: { status_code?: number; status_msg?: string };
  [key: string]: unknown;
}

export interface VideoFileRetrieveResponse {
  file?: { file_id?: string; download_url?: string; [key: string]: unknown };
  base_resp?: { status_code?: number; status_msg?: string };
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Tool result shape.                                                 *
 * ------------------------------------------------------------------ */

export interface VideoToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Helpers                                                            *
 * ------------------------------------------------------------------ */

/**
 * Format a MiniMax `MmxcError` (or arbitrary error) into the
 * `mmx_video_<name>: <msg> (mmx_code=..., http_status=..., mcp_code=...)`
 * envelope used by the image/speech tools. Includes the tool-name
 * prefix so the agent can route errors back to the right call.
 */
function formatVideoError(toolName: string, err: unknown): VideoToolResult {
  if (err instanceof MmxcError) {
    const code = err.toMcpErrorCode();
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${toolName}: ${err.message} ` +
            `(mmx_code=${err.code}, http_status=${err.httpStatus}, mcp_code=${code})`,
        },
      ],
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${toolName}: ${msg} (mmx_code=0, http_status=0, mcp_code=${MCP_ERROR_TIMEOUT})`,
      },
    ],
  };
}

/** Build the GET path with the query string baked in. */
function buildQueryPath(basePath: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return qs ? `${basePath}?${qs}` : basePath;
}

/* ------------------------------------------------------------------ *
 * mmx_video_generate                                                 *
 * ------------------------------------------------------------------ */

/** Internal type for the parsed generate input. */
interface VideoGenerateArgs {
  prompt: string;
  model: string;
  duration: VideoDuration;
  resolution: VideoResolution;
  prompt_optimizer: boolean;
  first_frame?: string;
  callback_url?: string;
  wait: boolean;
  wait_timeout_seconds: number;
  poll_interval_seconds: number;
}

function readGenerateArgs(rawArgs: Record<string, unknown>): VideoGenerateArgs {
  const prompt = typeof rawArgs.prompt === 'string' ? rawArgs.prompt : '';
  const model = typeof rawArgs.model === 'string' ? rawArgs.model : VIDEO_DEFAULT_MODEL;
  const duration =
    typeof rawArgs.duration === 'number' ? (rawArgs.duration as VideoDuration) : VIDEO_DEFAULT_DURATION;
  const resolution =
    typeof rawArgs.resolution === 'string'
      ? (rawArgs.resolution as VideoResolution)
      : VIDEO_DEFAULT_RESOLUTION;
  const prompt_optimizer =
    typeof rawArgs.prompt_optimizer === 'boolean' ? rawArgs.prompt_optimizer : VIDEO_DEFAULT_PROMPT_OPTIMIZER;
  const first_frame = typeof rawArgs.first_frame === 'string' ? rawArgs.first_frame : undefined;
  const callback_url = typeof rawArgs.callback_url === 'string' ? rawArgs.callback_url : undefined;
  const wait = rawArgs.wait === true;
  const wait_timeout_seconds =
    typeof rawArgs.wait_timeout_seconds === 'number'
      ? rawArgs.wait_timeout_seconds
      : VIDEO_DEFAULT_WAIT_TIMEOUT_SECONDS;
  const poll_interval_seconds =
    typeof rawArgs.poll_interval_seconds === 'number'
      ? rawArgs.poll_interval_seconds
      : VIDEO_DEFAULT_POLL_INTERVAL_SECONDS;
  return {
    prompt,
    model,
    duration,
    resolution,
    prompt_optimizer,
    first_frame,
    callback_url,
    wait,
    wait_timeout_seconds,
    poll_interval_seconds,
  };
}

/**
 * Submit a video generation task. Returns the raw submit response
 * (with `task_id` populated). Throws `MmxcError` on transport or
 * business errors; the handler turns those into the standard
 * `mmx_video_generate:` error envelope.
 */
async function submitVideoTask(
  client: MmxcClient,
  args: VideoGenerateArgs,
): Promise<VideoSubmitResponse> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    duration: args.duration,
    resolution: args.resolution,
    prompt_optimizer: args.prompt_optimizer,
  };
  if (args.first_frame) {
    body.first_frame_image = args.first_frame;
  }
  if (args.callback_url) {
    body.callback_url = args.callback_url;
  }
  return client.request<VideoSubmitResponse>({
    method: 'POST',
    path: VIDEO_SUBMIT_PATH,
    body,
  });
}

/**
 * Fetch a single status snapshot for a video task. Throws `MmxcError`
 * on transport or business errors. The shape is the raw task object.
 */
export async function fetchVideoTask(
  client: MmxcClient,
  taskId: string,
): Promise<VideoTaskResponse> {
  return client.request<VideoTaskResponse>({
    method: 'GET',
    path: buildQueryPath(VIDEO_STATUS_PATH, { task_id: taskId }),
  });
}

/**
 * Resolve a `file_id` to a hosted `download_url` via
 * `GET /v1/files/retrieve?file_id=…`. Throws `MmxcError` on failure.
 */
export async function resolveDownloadUrl(
  client: MmxcClient,
  fileId: string,
): Promise<string> {
  const body = await client.request<VideoFileRetrieveResponse>({
    method: 'GET',
    path: buildQueryPath(VIDEO_FILE_RETRIEVE_PATH, { file_id: fileId }),
  });
  const url = body?.file?.download_url;
  if (typeof url !== 'string' || !url) {
    throw new MmxcError({
      code: 0,
      message: 'files/retrieve returned no download_url',
      httpStatus: 200,
      raw: body,
    });
  }
  return url;
}

/**
 * Download a single URL to a buffer. Bypasses `MmxcClient` (no
 * retries) — we don't want to retry a long file fetch.
 */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await undiciRequest(url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`download failed: HTTP ${res.statusCode} for ${url}`);
  }
  return Buffer.from(await res.body.arrayBuffer());
}

/**
 * Poll the video status endpoint until the task reaches a terminal
 * state (`Success` or `Fail`) or the deadline expires.
 *
 * Returns the final task snapshot and a `timedOut` flag. Uses
 * real `setTimeout` for the inter-poll sleep; an optional `sleepFn`
 * seam is exposed so tests can drive the loop without real wall
 * time.
 */
export async function pollVideoTask(
  client: MmxcClient,
  taskId: string,
  options: {
    intervalSeconds: number;
    timeoutSeconds: number;
    sleepFn?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<{ task: VideoTaskResponse; timedOut: boolean }> {
  const sleep =
    options.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let elapsed = 0;
  let lastTask: VideoTaskResponse | undefined;
  // At least one poll is always performed (the submit + the first
  // status check is the AC's "submitted" surface).
  while (elapsed <= options.timeoutSeconds) {
    if (options.signal?.aborted) {
      throw new MmxcError({
        code: 0,
        message: 'poll aborted',
        httpStatus: 0,
        raw: undefined,
      });
    }
    const task = await fetchVideoTask(client, taskId);
    lastTask = task;
    const status = task.status;
    if (status === VIDEO_STATUS_SUCCESS || status === VIDEO_STATUS_FAIL) {
      return { task, timedOut: false };
    }
    // Decide how long to sleep: cap at the remaining budget so we
    // exit promptly on timeout rather than overshooting.
    const remaining = options.timeoutSeconds - elapsed;
    const sleepMs = Math.max(0, Math.min(options.intervalSeconds, remaining) * 1000);
    if (sleepMs === 0) break;
    await sleep(sleepMs);
    elapsed += options.intervalSeconds;
  }
  return { task: lastTask as VideoTaskResponse, timedOut: true };
}

/**
 * `mmx_video_generate` handler. Submits the task (or, with
 * `wait=true`, submits and polls). Returns the standard MCP tool
 * result shape.
 */
export async function videoGenerateHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<VideoToolResult> {
  const args = readGenerateArgs(rawArgs);
  const TOOL = 'mmx_video_generate';

  // 1. Submit.
  let submit: VideoSubmitResponse;
  try {
    submit = await submitVideoTask(client, args);
    // Surface non-zero `base_resp.status_code` (HTTP 200 + business
    // error) through the same MmxcError -> formatted text path that
    // the image/speech handlers use, so the
    // (mmx_code=..., http_status=..., mcp_code=...) envelope is
    // consistent across tools.
    const br = submit.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, submit));
    }
  } catch (err) {
    return formatVideoError(TOOL, err);
  }

  const taskId = submit.task_id;
  if (!taskId) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${TOOL}: API returned no task_id. ` +
            `Response: ${JSON.stringify(submit).slice(0, 2000)}`,
        },
      ],
    };
  }

  // 2. Optional synchronous poll.
  if (args.wait) {
    let result: { task: VideoTaskResponse; timedOut: boolean };
    try {
      result = await pollVideoTask(client, taskId, {
        intervalSeconds: args.poll_interval_seconds,
        timeoutSeconds: args.wait_timeout_seconds,
      });
    } catch (err) {
      return formatVideoError(TOOL, err);
    }
    if (result.timedOut) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `${TOOL}: timed out after ${args.wait_timeout_seconds}s waiting for task ` +
              `${taskId} to reach a terminal state. ` +
              `(mmx_code=0, http_status=0, mcp_code=${MCP_ERROR_TIMEOUT})`,
          },
        ],
      };
    }
    // Resolved task. Return the raw object as JSON text so the
    // agent can inspect `status` / `file_id` / `progress`.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.task, null, 2),
        },
      ],
    };
  }

  // 3. Default async: return the documented `{ task_id, status, model }`
  // triple. The API doesn't return a `status` on submit, so we use a
  // synthetic `"submitted"` marker; agents that need the real status
  // should call `mmx_video_status` or set `wait=true`.
  const payload = { task_id: taskId, status: 'submitted', model: args.model };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/* ------------------------------------------------------------------ *
 * mmx_video_status                                                   *
 * ------------------------------------------------------------------ */

export async function videoStatusHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<VideoToolResult> {
  const TOOL = 'mmx_video_status';
  const taskId = typeof rawArgs.task_id === 'string' ? rawArgs.task_id : '';
  if (!taskId) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `${TOOL}: task_id is required (mmx_code=0, http_status=0, mcp_code=1)` },
      ],
    };
  }
  try {
    const task = await fetchVideoTask(client, taskId);
    // Mirror the image/speech base_resp business-error check.
    const br = task.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, task));
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
    };
  } catch (err) {
    return formatVideoError(TOOL, err);
  }
}

/* ------------------------------------------------------------------ *
 * mmx_video_download                                                 *
 * ------------------------------------------------------------------ */

export async function videoDownloadHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<VideoToolResult> {
  const TOOL = 'mmx_video_download';
  const taskId = typeof rawArgs.task_id === 'string' ? rawArgs.task_id : '';
  const savePath = typeof rawArgs.save_path === 'string' ? rawArgs.save_path : '';
  if (!taskId) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `${TOOL}: task_id is required (mmx_code=0, http_status=0, mcp_code=1)` },
      ],
    };
  }
  if (!savePath) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `${TOOL}: save_path is required (mmx_code=0, http_status=0, mcp_code=1)` },
      ],
    };
  }

  // 1. Verify the task is `Success`.
  let task: VideoTaskResponse;
  try {
    task = await fetchVideoTask(client, taskId);
    const br = task.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, task));
    }
  } catch (err) {
    return formatVideoError(TOOL, err);
  }

  if (task.status !== VIDEO_STATUS_SUCCESS) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${TOOL}: task ${taskId} is not in \`Success\` status ` +
            `(current: \`${task.status ?? 'unknown'}\`). ` +
            `Use \`mmx_video_status\` to poll, or wait for the task to finish. ` +
            `(mmx_code=0, http_status=200, mcp_code=${MCP_ERROR_TIMEOUT})`,
        },
      ],
    };
  }
  const fileId = task.file_id;
  if (!fileId) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${TOOL}: task ${taskId} is \`Success\` but no \`file_id\` was returned. ` +
            `Response: ${JSON.stringify(task).slice(0, 2000)}`,
        },
      ],
    };
  }

  // 2. Resolve file_id → download_url.
  let downloadUrl: string;
  try {
    downloadUrl = await resolveDownloadUrl(client, fileId);
  } catch (err) {
    return formatVideoError(TOOL, err);
  }

  // 3. Stream the bytes to disk.
  let buffer: Buffer;
  try {
    buffer = await downloadToBuffer(downloadUrl);
  } catch (err) {
    log.warn(`${TOOL}: failed to download ${downloadUrl}:`, err);
    return formatVideoError(TOOL, err);
  }

  try {
    await mkdir(dirname(savePath), { recursive: true });
    await writeFile(savePath, buffer);
  } catch (err) {
    log.warn(`${TOOL}: failed to write ${savePath}:`, err);
    return formatVideoError(TOOL, err);
  }

  return {
    content: [
      {
        type: 'text',
        text: `Video downloaded: ${buffer.length} bytes -> ${savePath}`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * MCP registration.                                                 *
 * ------------------------------------------------------------------ */

export function registerVideoTools(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  client: MmxcClient,
): void {
  server.tool(VIDEO_GENERATE_TOOL_NAME, VIDEO_GENERATE_DESCRIPTION, VideoGenerateInputSchema, async (args) => {
    return videoGenerateHandler(args as Record<string, unknown>, client);
  });
  server.tool(VIDEO_STATUS_TOOL_NAME, VIDEO_STATUS_DESCRIPTION, VideoStatusInputSchema, async (args) => {
    return videoStatusHandler(args as Record<string, unknown>, client);
  });
  server.tool(VIDEO_DOWNLOAD_TOOL_NAME, VIDEO_DOWNLOAD_DESCRIPTION, VideoDownloadInputSchema, async (args) => {
    return videoDownloadHandler(args as Record<string, unknown>, client);
  });
}
