/**
 * mmxomni — shared MiniMax HTTP client.
 *
 * One `MmxcClient` per server. Wraps `undici.request` with the pieces
 * every tool needs:
 *
 *   - `Authorization: Bearer <key>` header (from AC-4 resolution).
 *   - Region-driven base URL (`global` → `https://api.minimax.io/v1`,
 *     `cn` → `https://api.minimaxi.cn/v1`); `--base-url` overrides for
 *     testing / staging.
 *   - JSON request/response bodies.
 *   - Idempotent-method retry with exponential backoff for HTTP 429
 *     and 5xx responses (up to 3 attempts total by default).
 *   - `MmxcError` thrown on terminal non-2xx responses, carrying the
 *     MiniMax `code`, message, and HTTP status.
 *
 * The constructor accepts an optional `undici.Dispatcher` so tests can
 * inject a `MockAgent` and exercise the real `request()` pipeline
 * without ever touching the network.
 */

import { request as undiciRequest, type Dispatcher } from 'undici';

import { MmxcError, normalizeApiError } from './errors.js';

export type Region = 'global' | 'cn' | (string & {});

export interface MmxcClientOptions {
  apiKey: string;
  region: Region;
  /** Override the base URL (for tests / staging). Wipes region lookup. */
  baseUrl?: string;
  /** Max total attempts, including the first. Default: 3. */
  maxRetries?: number;
  /** Initial backoff in ms; doubled each attempt. Default: 250. */
  retryBaseMs?: number;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path appended to the base URL, e.g. `/image_generation`. */
  path: string;
  /** JSON-serializable body. Omit for GET / no-body requests. */
  body?: unknown;
  signal?: AbortSignal;
}

const REGION_BASE_URLS: Readonly<Record<string, string>> = {
  global: 'https://api.minimax.io/v1',
  cn: 'https://api.minimaxi.cn/v1',
};

/** Look up the canonical base URL for a region. Falls back to `global`. */
export function regionBaseUrl(region: string): string {
  return REGION_BASE_URLS[region] ?? REGION_BASE_URLS.global!;
}

/** Test hook: should we retry on this (status, method) pair? */
export function shouldRetryStatus(status: number, method: string): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // Other statuses (401/403/400/etc.) are never retried.
  void method;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export class MmxcClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(options: MmxcClientOptions, dispatcher?: Dispatcher) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error('MmxcClient: apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? regionBaseUrl(options.region);
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.dispatcher = dispatcher;
  }

  /** Effective base URL (post-region / override resolution). */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Issue a JSON HTTP request. Throws `MmxcError` on a terminal
   * non-2xx response. Retries idempotent calls on 429/5xx with
   * exponential backoff up to `maxRetries` total attempts.
   */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const url = this.baseUrl + options.path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const bodyText = options.body !== undefined ? JSON.stringify(options.body) : undefined;

    let lastTransportError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await undiciRequest(url, {
          method: options.method,
          headers,
          body: bodyText,
          signal: options.signal,
          dispatcher: this.dispatcher,
        });
        const raw = await res.body.text();
        const parsed = raw.length > 0 ? safeJsonParse(raw) : null;

        if (res.statusCode >= 200 && res.statusCode < 300) {
          return parsed as T;
        }
        if (shouldRetryStatus(res.statusCode, options.method) && attempt < this.maxRetries) {
          await sleep(this.retryBaseMs * 2 ** attempt);
          continue;
        }
        throw new MmxcError(normalizeApiError(res.statusCode, parsed));
      } catch (err) {
        if (err instanceof MmxcError) throw err;
        lastTransportError = err;
        if (attempt >= this.maxRetries) {
          throw err;
        }
        // Transport-level failure (DNS, socket, abort). Retry the
        // next attempt; the outer loop will still respect maxRetries.
        await sleep(this.retryBaseMs * 2 ** attempt);
      }
    }
    // Unreachable in practice; the loop either returns or throws.
    throw lastTransportError instanceof Error
      ? lastTransportError
      : new Error('MmxcClient.request: exhausted retries');
  }
}
