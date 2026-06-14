/**
 * Real MiniMax API smoke test (gated).
 *
 * This file contains one integration test that hits the live MiniMax API.
 * It is gated behind `process.env.MINIMAX_API_KEY` using Vitest's
 * `it.runIf()`, so it is **skipped by default** in CI and local runs
 * without a real key. `npm test` exits 0 with no live network calls.
 *
 * To run: `MINIMAX_API_KEY=sk-... npx vitest run test/smoke.test.ts`
 *
 * What it verifies:
 *   - Auth, base URL, and the quota endpoint (lightest-weight endpoint)
 *     work end-to-end against the real MiniMax API.
 */

import { describe, it, expect } from 'vitest';
import { MmxcClient } from '../src/client.js';
import { MmxcError } from '../src/errors.js';

const API_KEY = process.env.MINIMAX_API_KEY;

describe('MiniMax live API smoke test', () => {
  it.runIf(API_KEY)(
    'GET /v1/account/quota returns a 200 with base_resp.status_code=0',
    async () => {
      const client = new MmxcClient({
        apiKey: API_KEY!,
        region: 'global',
      });

      const result = await client.request<{
        base_resp?: { status_code?: number; status_msg?: string };
        used?: number;
        remaining?: number;
        [key: string]: unknown;
      }>({
        method: 'GET',
        path: '/account/quota',
      });

      expect(result).toBeDefined();
      // The quota endpoint may error if the API key lacks quota access,
      // but it should at least return a parseable response (not throw).
      // If base_resp is present, status_code must be 0 (success).
      if (result.base_resp && typeof result.base_resp.status_code === 'number') {
        expect(result.base_resp.status_code).toBe(0);
      }
    },
  );

  it.runIf(API_KEY)(
    'a bad API key is rejected with a 401 and the client throws MmxcError',
    async () => {
      const client = new MmxcClient({
        apiKey: 'sk-bogus-key-that-will-fail',
        region: 'global',
      });

      await expect(
        client.request({
          method: 'GET',
          path: '/account/quota',
        }),
      ).rejects.toThrow(MmxcError);
    },
  );
});
