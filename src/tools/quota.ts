/**
 * mmx_quota_show — bonus tool (AC-9).
 *
 * Calls the MiniMax quota endpoint to inspect remaining quotas for
 * the current API key. mmx-cli's reference exposes this as a simple
 * GET against the quota endpoint with no body. The handler is
 * intentionally minimal: it forwards the response (whatever shape
 * the API uses) to the agent as a JSON text block.
 *
 * Why this is a bonus tool: Token Plan users often want to inspect
 * how much of their monthly quota they have left. The four core
 * tools (image / speech / music / video) cover generation; quota is
 * a meta-tool, so it sits behind the feature flag.
 *
 * Activation: behind `MMXOMNI_BONUS=1` / `--enable-bonus`. The
 * registry in `src/tools/index.ts` only calls `registerQuotaTool`
 * when the feature flag is on, so this tool is absent from
 * `tools/list` in the default build.
 */

import { z } from 'zod';

import type { MmxcClient } from '../client.js';
import { MmxcError, normalizeApiError } from '../errors.js';
import { log } from '../log.js';

/** mmx-cli default endpoint path. */
export const QUOTA_SHOW_PATH = '/account/quota';

export const QuotaShowInputSchema = {
  /** Reserved for future use; the current endpoint takes no body. */
  verbose: z
    .boolean()
    .default(false)
    .describe(
      'When `true`, return the raw API response. When `false` (default), return a concise summary ' +
        'with the most useful fields surfaced (used / remaining / reset_at).',
    ),
};

export const QUOTA_SHOW_DESCRIPTION =
  'Inspect remaining quota for the current MiniMax API key via the quota endpoint. ' +
  'Returns a JSON text block. Pass `verbose=true` for the raw API response; default is a concise summary ' +
  'with `used`, `remaining`, and `reset_at` fields. ' +
  'Bonus tool — especially useful for Token Plan users; only available when `MMXOMNI_BONUS=1` / `--enable-bonus` is set.';

export const QUOTA_TOOL_NAME = 'mmx_quota_show';

interface QuotaRawResponse {
  used?: number | string;
  remaining?: number | string;
  limit?: number | string;
  reset_at?: string;
  plan?: string;
  base_resp?: { status_code?: number; status_msg?: string };
  [key: string]: unknown;
}

export interface QuotaToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function formatQuotaError(toolName: string, err: unknown): QuotaToolResult {
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

/**
 * Reduce the raw quota response into the concise summary the agent
 * sees by default. Only includes fields that were actually
 * populated; this keeps the result useful even when the API returns
 * a subset.
 */
function summarizeQuota(raw: QuotaRawResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw.used !== undefined) out.used = raw.used;
  if (raw.remaining !== undefined) out.remaining = raw.remaining;
  if (raw.limit !== undefined) out.limit = raw.limit;
  if (raw.reset_at !== undefined) out.reset_at = raw.reset_at;
  if (raw.plan !== undefined) out.plan = raw.plan;
  return out;
}

export async function quotaShowHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<QuotaToolResult> {
  const TOOL = QUOTA_TOOL_NAME;
  const verbose = rawArgs.verbose === true;

  let response: QuotaRawResponse;
  try {
    response = await client.request<QuotaRawResponse>({
      method: 'GET',
      path: QUOTA_SHOW_PATH,
    });
    const br = response.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, response));
    }
  } catch (err) {
    log.debug(`${TOOL} request failed:`, err);
    return formatQuotaError(TOOL, err);
  }

  const payload = verbose ? response : summarizeQuota(response);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerQuotaTool(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  client: MmxcClient,
): void {
  server.tool(QUOTA_TOOL_NAME, QUOTA_SHOW_DESCRIPTION, QuotaShowInputSchema, async (args) => {
    return quotaShowHandler(args as Record<string, unknown>, client);
  });
}
