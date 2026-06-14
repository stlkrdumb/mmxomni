/**
 * mmxomni — API error normalization and MCP code mapping.
 *
 * The MiniMax HTTP API returns errors in two common shapes:
 *   1. `{ "base_resp": { "status_code": <int>, "status_msg": <string> } }`
 *      — the canonical MiniMax envelope (image / TTS / music / video).
 *   2. `{ "code": <int|string>, "message": <string> }`
 *      — used by some endpoints / proxies.
 *
 * `normalizeApiError` reduces both into a single `ApiError` shape so
 * downstream code only deals with one form.
 *
 * `mapHttpStatusToMcpCode` and `MmxcError.toMcpErrorCode` translate that
 * normalized error into the mmx-cli exit-code-style integer used by
 * mmxomni's MCP tool results:
 *
 *   1  generic / internal / 5xx
 *   3  authentication failure (HTTP 401/403, or MiniMax code 1001/1002/1003/1007)
 *   4  quota / rate-limit (HTTP 429, or MiniMax code 1004/1005/10429)
 *   5  timeout (HTTP 408 or signal-aborted)
 *  10  content filter / safety (MiniMax code 1026/1027/2013/2014, or HTTP 400 with that body)
 *
 * The MCP spec says tool results are normal JSON; clients that surface
 * errors to humans typically display `content[0].text` and a
 * non-zero `isError`. We keep the integer code in the text for
 * machine parsing without depending on the `isError` flag (some hosts
 * ignore it).
 */

export const MCP_ERROR_GENERIC = 1;
export const MCP_ERROR_AUTH = 3;
export const MCP_ERROR_QUOTA = 4;
export const MCP_ERROR_TIMEOUT = 5;
export const MCP_ERROR_CONTENT_FILTER = 10;

/** Known MiniMax error code → MCP code hint, applied after HTTP mapping. */
const MMX_CODE_TO_MCP: Record<number, number> = {
  1001: MCP_ERROR_AUTH, // invalid api key
  1002: MCP_ERROR_AUTH, // quota exhausted (auth-bound)
  1003: MCP_ERROR_AUTH, // security / invalid token
  1004: MCP_ERROR_QUOTA, // rate limit / RPM
  1005: MCP_ERROR_QUOTA, // account balance
  1007: MCP_ERROR_AUTH, // invalid authorization
  1011: MCP_ERROR_AUTH, // permission denied
  1026: MCP_ERROR_CONTENT_FILTER, // input content review failed
  1027: MCP_ERROR_CONTENT_FILTER, // output content review failed
  10429: MCP_ERROR_QUOTA, // requests per minute
  2013: MCP_ERROR_CONTENT_FILTER, // input parameter invalid (often safety)
  2014: MCP_ERROR_CONTENT_FILTER, // output rejected by safety
};

export interface ApiError {
  /** MiniMax `status_code` / `code`; `0` if the body was unparseable. */
  code: number;
  /** Human-readable message (from `status_msg` / `message` / fallback). */
  message: string;
  /** Underlying HTTP status. `0` for transport-level failures. */
  httpStatus: number;
  /** Raw response body, if any, for debugging / structured logging. */
  raw?: unknown;
}

/**
 * Reduce the two MiniMax error-body shapes into a single `ApiError`.
 * Falls back to sensible defaults if the body is missing or unparseable.
 */
export function normalizeApiError(httpStatus: number, body: unknown): ApiError {
  const fallback = (): ApiError => ({
    code: 0,
    message: typeof body === 'string' && body ? body : `HTTP ${httpStatus}`,
    httpStatus,
    raw: body,
  });

  if (body === null || body === undefined) {
    return fallback();
  }
  if (typeof body !== 'object') {
    return fallback();
  }
  const b = body as Record<string, unknown>;
  const baseResp = b.base_resp;
  if (baseResp && typeof baseResp === 'object') {
    const r = baseResp as Record<string, unknown>;
    const statusCode = typeof r.status_code === 'number' ? r.status_code : 0;
    const statusMsg =
      typeof r.status_msg === 'string' && r.status_msg ? r.status_msg : `HTTP ${httpStatus}`;
    return { code: statusCode, message: statusMsg, httpStatus, raw: body };
  }
  if ('code' in b || 'message' in b) {
    const rawCode = b.code;
    const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' ? Number(rawCode) || 0 : 0;
    const rawMessage = b.message;
    const message =
      typeof rawMessage === 'string' && rawMessage ? rawMessage : `HTTP ${httpStatus}`;
    return { code, message, httpStatus, raw: body };
  }
  return fallback();
}

/**
 * Map an HTTP status code to the closest MCP error code. Called by
 * `MmxcError.toMcpErrorCode` as the default when no MiniMax-specific
 * code override applies.
 */
export function mapHttpStatusToMcpCode(httpStatus: number): number {
  if (httpStatus === 401 || httpStatus === 403) return MCP_ERROR_AUTH;
  if (httpStatus === 408) return MCP_ERROR_TIMEOUT;
  if (httpStatus === 429) return MCP_ERROR_QUOTA;
  if (httpStatus === 400) return MCP_ERROR_CONTENT_FILTER;
  if (httpStatus >= 500 && httpStatus < 600) return MCP_ERROR_GENERIC;
  return MCP_ERROR_GENERIC;
}

/**
 * The single error class thrown by `MmxcClient.request()` on a
 * non-2xx response. Carries both the MiniMax `code` and the underlying
 * HTTP status so callers can map to MCP codes deterministically.
 */
export class MmxcError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly raw?: unknown;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = 'MmxcError';
    this.code = apiError.code;
    this.httpStatus = apiError.httpStatus;
    this.raw = apiError.raw;
  }

  /**
   * Map this error to the MCP / mmx-cli integer code. Prefers the
   * MiniMax code table (more specific), falls back to the HTTP-status
   * table, and finally defaults to the generic code (1).
   */
  toMcpErrorCode(): number {
    if (this.code !== 0 && this.code in MMX_CODE_TO_MCP) {
      return MMX_CODE_TO_MCP[this.code]!;
    }
    if (this.httpStatus !== 0) {
      return mapHttpStatusToMcpCode(this.httpStatus);
    }
    return MCP_ERROR_GENERIC;
  }
}
