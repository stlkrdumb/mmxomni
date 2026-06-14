/**
 * mmx_vision_describe — bonus tool (AC-9).
 *
 * Calls the MiniMax vision endpoint to describe an image. The
 * endpoint accepts either a hosted image URL or base64-encoded image
 * bytes; mmx-cli follows the same convention. The default model
 * follows mmx-cli's `MiniMax-01-vision-01` choice for the vision
 * surface.
 *
 * At least one of `image_url` or `image_base64` must be provided.
 * The schema-level refine() rejects calls that supply neither. The
 * HTTP implementation is intentionally minimal: the request body
 * shape mirrors mmx-cli's `MiniMax_vision.py` reference.
 *
 * Activation: behind `MMXOMNI_BONUS=1` / `--enable-bonus`. The
 * registry in `src/tools/index.ts` only calls `registerVisionTool`
 * when the feature flag is on, so this tool is absent from
 * `tools/list` in the default build.
 */

import { z } from 'zod';

import type { MmxcClient } from '../client.js';
import { MmxcError, normalizeApiError } from '../errors.js';
import { log } from '../log.js';

/** Canonical mmx-cli default vision model. */
export const VISION_DEFAULT_MODEL = 'MiniMax-01-vision-01';

/** mmx-cli default endpoint path. */
export const VISION_DESCRIBE_PATH = '/vision/describe';

export const VisionDescribeInputSchema = {
  image_url: z
    .string()
    .url()
    .optional()
    .describe('Hosted image URL (http/https) to describe. Mutually preferred over `image_base64`.'),
  image_base64: z
    .string()
    .min(1)
    .optional()
    .describe('Base64-encoded image bytes. Use when the image is not hosted at a URL.'),
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional instruction that biases the caption (e.g. `Focus on layout and colors.`). ' +
        'Default: a generic "describe this image" instruction.',
    ),
  model: z
    .string()
    .default(VISION_DEFAULT_MODEL)
    .describe(`Vision model ID. Default: \`${VISION_DEFAULT_MODEL}\` (mmx-cli canonical).`),
  max_tokens: z
    .number()
    .int()
    .min(64)
    .max(4096)
    .default(1024)
    .describe('Maximum response length in tokens. Default: `1024`.'),
};

/** Cross-field validation result. */
export interface VisionValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Cross-field validation. The schema above accepts each of
 * `image_url` / `image_base64` independently, so the constraint
 * "at least one must be present" lives in this helper.
 */
export function validateVisionInput(args: Record<string, unknown>): VisionValidationResult {
  const hasUrl = typeof args.image_url === 'string' && args.image_url.length > 0;
  const hasBase64 = typeof args.image_base64 === 'string' && args.image_base64.length > 0;
  if (!hasUrl && !hasBase64) {
    return {
      ok: false,
      error: 'At least one of `image_url` or `image_base64` must be provided.',
    };
  }
  return { ok: true };
}

export const VISION_DESCRIBE_DESCRIPTION =
  'Describe an image via the MiniMax vision API (default model `' +
  VISION_DEFAULT_MODEL +
  '`). ' +
  'Pass either `image_url` (hosted image) or `image_base64` (inline bytes). ' +
  'Returns the caption as text. Optional `prompt` biases the description and `max_tokens` caps the response length. ' +
  'Bonus tool — only available when `MMXOMNI_BONUS=1` / `--enable-bonus` is set.';

export const VISION_TOOL_NAME = 'mmx_vision_describe';

interface VisionDescribeResponse {
  description?: string;
  caption?: string;
  text?: string;
  base_resp?: { status_code?: number; status_msg?: string };
  [key: string]: unknown;
}

function extractDescription(body: VisionDescribeResponse): string | undefined {
  if (typeof body.description === 'string' && body.description) return body.description;
  if (typeof body.caption === 'string' && body.caption) return body.caption;
  if (typeof body.text === 'string' && body.text) return body.text;
  return undefined;
}

export interface VisionToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function formatVisionError(toolName: string, err: unknown): VisionToolResult {
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
      { type: 'text', text: `${toolName}: ${msg} (mmx_code=0, http_status=0, mcp_code=1)` },
    ],
  };
}

export async function visionDescribeHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<VisionToolResult> {
  const TOOL = VISION_TOOL_NAME;

  const v = validateVisionInput(rawArgs);
  if (!v.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${TOOL}: ${v.error}` }],
    };
  }

  const args = rawArgs as Partial<{
    image_url: string;
    image_base64: string;
    prompt: string;
    model: string;
    max_tokens: number;
  }>;

  const model = typeof args.model === 'string' && args.model ? args.model : VISION_DEFAULT_MODEL;
  const maxTokens = typeof args.max_tokens === 'number' ? args.max_tokens : 1024;
  const prompt = typeof args.prompt === 'string' && args.prompt ? args.prompt : 'Describe this image.';

  const body: Record<string, unknown> = {
    model,
    prompt,
    max_tokens: maxTokens,
  };
  if (typeof args.image_url === 'string' && args.image_url) {
    body.image_url = args.image_url;
  } else if (typeof args.image_base64 === 'string' && args.image_base64) {
    body.image_base64 = args.image_base64;
  }

  let response: VisionDescribeResponse;
  try {
    response = await client.request<VisionDescribeResponse>({
      method: 'POST',
      path: VISION_DESCRIBE_PATH,
      body,
    });
    const br = response.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, response));
    }
  } catch (err) {
    log.debug(`${TOOL} request failed:`, err);
    return formatVisionError(TOOL, err);
  }

  const description = extractDescription(response);
  if (!description) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${TOOL}: API returned no description. ` +
            `Response: ${JSON.stringify(response).slice(0, 2000)}`,
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: description }],
  };
}

export function registerVisionTool(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  client: MmxcClient,
): void {
  server.tool(VISION_TOOL_NAME, VISION_DESCRIBE_DESCRIPTION, VisionDescribeInputSchema, async (args) => {
    return visionDescribeHandler(args as Record<string, unknown>, client);
  });
}
