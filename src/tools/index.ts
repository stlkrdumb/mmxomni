/**
 * mmxomni — tool registry.
 *
 * Aggregates every tool module and provides a single `registerAllTools`
 * entry point that the server factory calls.
 *
 * The four core tools (image / speech / music / video generate +
 * status + download) are always registered. The three bonus tools
 * (vision / search / quota) are gated behind AC-9's feature flag:
 *
 *   - CLI flag `--enable-bonus`
 *   - Env var `MMXOMNI_BONUS=1`
 *
 * When the flag is off, the bonus tools are absent from
 * `tools/list` (the registry does not call their `register*` helpers
 * at all). This is the only mechanism the AC-9 text requires; we
 * intentionally do not register-and-then-hide.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { MmxcClient } from '../client.js';
import { registerImageTool } from './image.js';
import { registerMusicTool } from './music.js';
import { registerQuotaTool } from './quota.js';
import { registerSearchTool } from './search.js';
import { registerSpeechTool } from './speech.js';
import { registerVideoTools } from './video.js';
import { registerVisionTool } from './vision.js';

/**
 * Names of every core tool the server registers. Tests and the
 * `tools/list` smoke check assert on this set.
 */
export const CORE_TOOL_NAMES = [
  'mmx_image_generate',
  'mmx_speech_synthesize',
  'mmx_music_generate',
  'mmx_video_generate',
  'mmx_video_status',
  'mmx_video_download',
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

/**
 * Names of the bonus tools (AC-9). Same export shape as
 * `CORE_TOOL_NAMES` so tests can assert on the full bonus set.
 */
export const BONUS_TOOL_NAMES = ['mmx_vision_describe', 'mmx_search_query', 'mmx_quota_show'] as const;

export type BonusToolName = (typeof BONUS_TOOL_NAMES)[number];

/** Env var that flips the bonus-tools feature flag. */
export const MMXOMNI_BONUS_ENV = 'MMXOMNI_BONUS';

/**
 * Resolve the `enableBonus` boolean from the CLI flag, the env var,
 * and an explicit override. Truthy values for the CLI flag and
 * non-empty env values (e.g. `1`, `true`, `yes`) are accepted; the
 * env-var check is case-insensitive.
 *
 * Precedence: explicit `cliEnableBonus` > `MMXOMNI_BONUS` env.
 */
export function resolveEnableBonus(
  cliEnableBonus: boolean | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (cliEnableBonus === true) return true;
  if (cliEnableBonus === false) return false;
  const raw = env[MMXOMNI_BONUS_ENV];
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'on';
}

/**
 * Options accepted by `registerAllTools`.
 */
export interface RegisterAllToolsOptions {
  /** When `true`, also register the AC-9 bonus tools. */
  enableBonus?: boolean;
}

/**
 * Register every core tool on the given `McpServer` instance. Each
 * tool module owns its own schema, description, and handler; this
 * function is a flat dispatcher. The shared `MmxcClient` carries the
 * resolved `apiKey` and `region` for every tool that needs them.
 *
 * AC-9: when `options.enableBonus` is true, the bonus tools
 * (`mmx_vision_describe`, `mmx_search_query`, `mmx_quota_show`) are
 * registered too. When false (or unset), the six core tools are
 * registered and the bonus tools are absent from `tools/list`.
 */
export function registerAllTools(
  server: McpServer,
  client: MmxcClient,
  options: RegisterAllToolsOptions = {},
): void {
  registerImageTool(server, client);
  registerSpeechTool(server, client);
  registerMusicTool(server, client);
  registerVideoTools(server, client);
  if (options.enableBonus === true) {
    registerVisionTool(server, client);
    registerSearchTool(server, client);
    registerQuotaTool(server, client);
  }
}

// Note: `CORE_TOOL_NAMES` and `BONUS_TOOL_NAMES` are already exported
// above via `export const`, so the trailing `export { ... }` block
// re-exports only the function-typed helpers. ESM forbids declaring the
// same name twice in a module's export set.
export {
  registerImageTool,
  registerSpeechTool,
  registerMusicTool,
  registerVideoTools,
  registerVisionTool,
  registerSearchTool,
  registerQuotaTool,
};
