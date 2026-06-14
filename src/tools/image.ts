/**
 * mmx_image_generate — MiniMax image generation tool.
 *
 * Calls the MiniMax image-generation endpoint (default model `image-01`).
 * Returns:
 *   - the hosted image URL(s) as a text content block (default), or
 *   - one MCP `Image` content block per generated image when
 *     `embed=true` (base64 PNG/JPEG data the host can render inline).
 *
 * Optionally downloads the generated assets to `out_dir` (with
 * `out_prefix` controlling the file name) in addition to the return
 * value. The `out_dir` path is a per-call opt-in so a single 1k token
 * response never blows up the model's context window.
 *
 * API errors are normalized via `src/errors.ts` and surfaced as
 * `{ isError: true, content: [...] }` tool results with the mapped MCP
 * code (1 / 3 / 4 / 10) included in the human-readable text.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';
import { request as undiciRequest } from 'undici';

import type { MmxcClient } from '../client.js';
import { MmxcError, normalizeApiError } from '../errors.js';
import { log } from '../log.js';

/**
 * Canonical mmx-cli default model for image generation. Sourced from the
 * MiniMax CLI skill (`mmx image generate --model`). Pinned so that
 * downstream agents see a stable default across releases.
 */
export const IMAGE_DEFAULT_MODEL = 'image-01';

/**
 * Default aspect ratio documented by the MiniMax image endpoint. The
 * server only requires `prompt`; the rest of the body is best-effort
 * optimization. We send the same default as mmx-cli when the caller
 * doesn't override it.
 */
export const IMAGE_DEFAULT_ASPECT_RATIO = '1:1';

export const ImageGenerateInputSchema = {
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .describe('Text description of the image to generate.'),
  model: z
    .string()
    .default(IMAGE_DEFAULT_MODEL)
    .describe(
      `Image model ID. Default: \`${IMAGE_DEFAULT_MODEL}\` (mmx-cli canonical). Other supported values: \`image-01-live\`.`,
    ),
  aspect_ratio: z
    .string()
    .optional()
    .describe('Output aspect ratio, e.g. `16:9`, `1:1`, `4:3`, `9:16`, `3:4`. Default: `1:1`.'),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe('Number of images to generate (1-4). Default: 1.'),
  subject_ref: z
    .string()
    .optional()
    .describe(
      'Subject reference as `type=character,image=<path-or-url>`. Used to anchor a character/subject across generations.',
    ),
  embed: z
    .boolean()
    .default(false)
    .describe(
      'When `true`, return the image as a base64 MCP `Image` content block. When `false` (default), return hosted URL(s) as text.',
    ),
  out_dir: z
    .string()
    .optional()
    .describe('If set, download the generated image(s) into this directory in addition to returning them.'),
  out_prefix: z
    .string()
    .default('image')
    .optional()
    .describe('Filename prefix when `out_dir` is set. Default: `image`.'),
};

export const IMAGE_GENERATE_DESCRIPTION =
  'Generate one or more images from a text prompt via the MiniMax image generation API (default model `image-01`). ' +
  'By default returns hosted image URL(s) as text. Pass `embed=true` to receive a base64 MCP `Image` content block, ' +
  'or `out_dir` to also save the file(s) to disk.';

export const IMAGE_TOOL_NAME = 'mmx_image_generate';

/* ------------------------------------------------------------------ *
 * Types for the MiniMax image endpoint.                              *
 * ------------------------------------------------------------------ */

interface ImageGenerateResponse {
  image_urls?: string[];
  images?: string[];
  data?: { image_urls?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
}

/** Extract the first plausible URL array from a MiniMax image response. */
function extractImageUrls(body: ImageGenerateResponse): string[] {
  if (Array.isArray(body.image_urls) && body.image_urls.length > 0) return body.image_urls;
  if (body.data && Array.isArray(body.data.image_urls) && body.data.image_urls.length > 0) {
    return body.data.image_urls;
  }
  if (Array.isArray(body.images) && body.images.length > 0) return body.images;
  return [];
}

function mimeFromUrl(url: string): string {
  const m = url.toLowerCase().match(/\.(png|jpg|jpeg|webp)(\?|$)/);
  if (!m) return 'image/png';
  const ext = m[1]!;
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function extFromUrl(url: string): string {
  const m = url.toLowerCase().match(/\.(png|jpg|jpeg|webp)(\?|$)/);
  return m ? m[1]! : 'png';
}

/** Download a single URL to a buffer; throws on non-2xx. */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await undiciRequest(url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`download failed: HTTP ${res.statusCode} for ${url}`);
  }
  return Buffer.from(await res.body.arrayBuffer());
}

/* ------------------------------------------------------------------ *
 * The handler. Exported separately from `registerImageTool` so      *
 * tests can call it directly against a `MockAgent`-backed client.   *
 * ------------------------------------------------------------------ */

export type ImageContentBlock = { type: 'image'; data: string; mimeType: string };
export type TextContentBlock = { type: 'text'; text: string };
export type ImageToolContent = TextContentBlock | ImageContentBlock;

export interface ImageToolResult {
  content: ImageToolContent[];
  isError?: boolean;
  // The MCP SDK's `CallToolResult` is a `$loose` zod schema, which
  // infers an open `[key: string]: unknown` index signature. We
  // mirror that here so the registered tool callback is assignable
  // to `CallToolResult` without an explicit cast; concrete
  // properties are still enforced at runtime by the zod-derived
  // `CallToolResultSchema`.
  [key: string]: unknown;
}

export async function imageGenerateHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<ImageToolResult> {
  const args = rawArgs as Partial<{
    prompt: string;
    model: string;
    aspect_ratio: string;
    n: number;
    subject_ref: string;
    embed: boolean;
    out_dir: string;
    out_prefix: string;
  }>;

  const prompt = args.prompt ?? '';
  const model = args.model ?? IMAGE_DEFAULT_MODEL;
  const aspectRatio = args.aspect_ratio ?? IMAGE_DEFAULT_ASPECT_RATIO;
  const embed = args.embed === true;
  const outDir = typeof args.out_dir === 'string' && args.out_dir ? args.out_dir : undefined;
  const outPrefix = args.out_prefix ?? 'image';
  const n = typeof args.n === 'number' ? args.n : 1;

  const body: Record<string, unknown> = {
    model,
    prompt,
    aspect_ratio: aspectRatio,
    n,
  };
  if (typeof args.subject_ref === 'string' && args.subject_ref) {
    body.subject_ref = args.subject_ref;
  }

  let response: ImageGenerateResponse;
  try {
    response = await client.request<ImageGenerateResponse>({
      method: 'POST',
      path: '/image_generation',
      body,
    });
    // The MiniMax HTTP API often returns HTTP 200 with a non-zero
    // `base_resp.status_code` for application-level failures (invalid
    // key, quota, content filter, etc.). The shared client only throws
    // `MmxcError` on transport-level non-2xx, so we have to inspect
    // the envelope here and throw it INSIDE the try block so the
    // catch below formats it with the `mmx_image_generate:` prefix
    // and the `(mmx_code=..., http_status=..., mcp_code=...)` envelope
    // — that envelope is what downstream agents parse for the
    // documented MCP error codes 1/3/4/10.
    const br = response.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, response));
    }
  } catch (err) {
    if (err instanceof MmxcError) {
      const code = err.toMcpErrorCode();
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `mmx_image_generate: ${err.message} ` +
              `(mmx_code=${err.code}, http_status=${err.httpStatus}, mcp_code=${code})`,
          },
        ],
      };
    }
    throw err;
  }

  const urls = extractImageUrls(response);
  if (urls.length === 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'mmx_image_generate: API returned no image URLs. ' +
            `Response: ${JSON.stringify(response).slice(0, 2000)}`,
        },
      ],
    };
  }

  // Optional: download to disk before returning.
  const savedPaths: string[] = [];
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;
      try {
        const buf = await downloadToBuffer(url);
        const path = join(outDir, `${outPrefix}-${i + 1}.${extFromUrl(url)}`);
        await writeFile(path, buf);
        savedPaths.push(path);
      } catch (err) {
        log.warn(`mmx_image_generate: failed to save ${url} to ${outDir}:`, err);
      }
    }
  }

  if (embed) {
    // Download all URLs, embed as base64 Image content blocks.
    const blocks: ImageContentBlock[] = [];
    for (const url of urls) {
      try {
        const buf = await downloadToBuffer(url);
        blocks.push({ type: 'image', data: buf.toString('base64'), mimeType: mimeFromUrl(url) });
      } catch (err) {
        log.warn(`mmx_image_generate: failed to embed ${url}:`, err);
      }
    }
    if (blocks.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'mmx_image_generate: failed to download any image for embed=true',
          },
        ],
      };
    }
    return { content: blocks };
  }

  // Default: return URLs as a single text block.
  const lines = [`Image generated (${urls.length}):`, ...urls];
  if (savedPaths.length > 0) {
    lines.push('', 'Saved to:', ...savedPaths);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/* ------------------------------------------------------------------ *
 * MCP registration.                                                 *
 * ------------------------------------------------------------------ */

export function registerImageTool(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  client: MmxcClient,
): void {
  server.tool(IMAGE_TOOL_NAME, IMAGE_GENERATE_DESCRIPTION, ImageGenerateInputSchema, async (args) => {
    return imageGenerateHandler(args as Record<string, unknown>, client);
  });
}
