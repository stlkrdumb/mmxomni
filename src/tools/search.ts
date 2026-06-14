/**
 * mmx_search_query — bonus tool (AC-9).
 *
 * Calls the MiniMax search endpoint. mmx-cli's reference exposes
 * this as `MiniMax_search.py` with a `query` body. The handler is
 * intentionally minimal: the request body shape mirrors mmx-cli's
 * (`query` + optional `top_k` + optional `recency_days`).
 *
 * Activation: behind `MMXOMNI_BONUS=1` / `--enable-bonus`. The
 * registry in `src/tools/index.ts` only calls `registerSearchTool`
 * when the feature flag is on, so this tool is absent from
 * `tools/list` in the default build.
 */

import { z } from 'zod';

import type { MmxcClient } from '../client.js';
import { MmxcError, normalizeApiError } from '../errors.js';
import { log } from '../log.js';

/** mmx-cli default endpoint path. */
export const SEARCH_QUERY_PATH = '/search/query';

/** mmx-cli default `top_k` for search results. */
export const SEARCH_DEFAULT_TOP_K = 10;

export const SearchQueryInputSchema = {
  query: z
    .string()
    .min(1, 'query is required')
    .max(2000, 'query exceeds MiniMax search 2,000 char limit')
    .describe('Natural-language search query. Max 2,000 characters (mmx-cli limit).'),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(SEARCH_DEFAULT_TOP_K)
    .describe(`Number of results to return (1-50). Default: \`${SEARCH_DEFAULT_TOP_K}\`.`),
  recency_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Optional filter: only include results from the last N days (1-365).'),
  site: z
    .string()
    .optional()
    .describe('Optional host filter (e.g. `example.com`) to scope the search to a single domain.'),
};

export const SEARCH_QUERY_DESCRIPTION =
  'Search the web via the MiniMax search API. ' +
  'Requires a non-empty `query` string. Optional `top_k` (1-50, default 10) controls result count, ' +
  '`recency_days` (1-365) filters by age, and `site` scopes to a single host. ' +
  'Returns the raw results array as a JSON text block. ' +
  'Bonus tool — only available when `MMXOMNI_BONUS=1` / `--enable-bonus` is set.';

export const SEARCH_TOOL_NAME = 'mmx_search_query';

interface SearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  published_at?: string;
  [key: string]: unknown;
}

interface SearchQueryResponse {
  results?: SearchResultItem[];
  base_resp?: { status_code?: number; status_msg?: string };
  [key: string]: unknown;
}

export interface SearchToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function formatSearchError(toolName: string, err: unknown): SearchToolResult {
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

export async function searchQueryHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<SearchToolResult> {
  const TOOL = SEARCH_TOOL_NAME;

  const query = typeof rawArgs.query === 'string' ? rawArgs.query : '';
  if (!query) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `${TOOL}: query is required (mmx_code=0, http_status=0, mcp_code=1)` },
      ],
    };
  }
  const topK = typeof rawArgs.top_k === 'number' ? rawArgs.top_k : SEARCH_DEFAULT_TOP_K;
  const recencyDays = typeof rawArgs.recency_days === 'number' ? rawArgs.recency_days : undefined;
  const site = typeof rawArgs.site === 'string' && rawArgs.site ? rawArgs.site : undefined;

  const body: Record<string, unknown> = {
    query,
    top_k: topK,
  };
  if (recencyDays !== undefined) {
    body.recency_days = recencyDays;
  }
  if (site) {
    body.site = site;
  }

  let response: SearchQueryResponse;
  try {
    response = await client.request<SearchQueryResponse>({
      method: 'POST',
      path: SEARCH_QUERY_PATH,
      body,
    });
    const br = response.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, response));
    }
  } catch (err) {
    log.debug(`${TOOL} request failed:`, err);
    return formatSearchError(TOOL, err);
  }

  const results = Array.isArray(response.results) ? response.results : [];
  // Return the raw results array as a JSON text block, exactly the
  // same envelope `mmx_video_status` uses. Agents can pick out
  // title/url/snippet fields directly.
  return {
    content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
  };
}

export function registerSearchTool(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  client: MmxcClient,
): void {
  server.tool(SEARCH_TOOL_NAME, SEARCH_QUERY_DESCRIPTION, SearchQueryInputSchema, async (args) => {
    return searchQueryHandler(args as Record<string, unknown>, client);
  });
}
