/**
 * mmx_music_generate — MiniMax music generation tool.
 *
 * Declares the tool name, description, and JSON-Schema inputSchema for
 * `mmx_music_generate`. Cross-field validation rules (`prompt`/`lyrics`
 * at-least-one, `instrumental=true` + `lyrics` mutual exclusion) are
 * enforced at handler runtime via `validateMusicInput`.
 */

import { z } from 'zod';

/** Canonical mmx-cli default model for music generation. */
export const MUSIC_DEFAULT_MODEL = 'music-2.5';

/**
 * Raw Zod shape for `mmx_music_generate` input.
 * Cross-field constraints live in `validateMusicInput` and the handler.
 */
export const MusicGenerateInputSchema = {
  prompt: z
    .string()
    .optional()
    .describe('Music style description. Can be a short tag (`upbeat pop`) or a rich structured brief.'),
  lyrics: z
    .string()
    .optional()
    .describe(
      'Song lyrics with structure tags (e.g. `[verse] ... [chorus] ...`). ' +
        'Use the literal string `"\u65e0\u6b4c\u8bcd"` for instrumental (or pass `instrumental=true` instead).',
    ),
  vocals: z.string().optional().describe('Vocal style hint, e.g. `warm male baritone`, `bright female soprano`.'),
  genre: z.string().optional().describe('Music genre, e.g. `folk`, `pop`, `jazz`, `electronic`.'),
  mood: z.string().optional().describe('Mood or emotion, e.g. `warm`, `melancholic`, `uplifting`.'),
  instruments: z
    .string()
    .optional()
    .describe('Featured instruments, e.g. `acoustic guitar, piano, soft drums`.'),
  tempo: z.string().optional().describe('Tempo description, e.g. `fast`, `slow`, `moderate`.'),
  bpm: z.number().int().min(40).max(220).optional().describe('Exact tempo in beats per minute (40-220).'),
  key: z.string().optional().describe('Musical key, e.g. `C major`, `A minor`, `G sharp minor`.'),
  structure: z
    .string()
    .optional()
    .describe('Song structure, e.g. `verse-chorus-verse-bridge-chorus`.'),
  references: z
    .string()
    .optional()
    .describe('Reference tracks or artists, e.g. `similar to Ed Sheeran`.'),
  avoid: z.string().optional().describe('Elements to avoid in the generated music.'),
  use_case: z
    .string()
    .optional()
    .describe('Use case context, e.g. `background music for video`, `theme song`.'),
  instrumental: z
    .boolean()
    .default(false)
    .describe('Generate an instrumental track (no vocals). Mutually exclusive with `lyrics`.'),
  aigc_watermark: z
    .boolean()
    .default(false)
    .describe('Embed the AIGC content watermark in the generated audio.'),
  format: z.enum(['mp3', 'wav', 'flac']).default('mp3').describe('Audio container. Default: `mp3`.'),
  sample_rate: z
    .number()
    .int()
    .refine((v) => [16000, 22050, 24000, 32000, 44100, 48000].includes(v), {
      message: 'sample_rate must be one of 16000, 22050, 24000, 32000, 44100, 48000',
    })
    .default(44100)
    .describe('Audio sample rate in Hz. Default: `44100`.'),
  bitrate: z
    .number()
    .int()
    .refine((v) => [64000, 128000, 192000, 256000, 320000].includes(v), {
      message: 'bitrate must be one of 64000, 128000, 192000, 256000, 320000',
    })
    .default(256000)
    .describe('Audio bitrate in bps. Default: `256000`.'),
  save_path: z
    .string()
    .optional()
    .describe('If set, save the generated audio to this local file path in addition to returning the URL.'),
  embed: z
    .boolean()
    .default(false)
    .describe('When `true`, embed the audio as a base64 MCP `audio` content block. Default: text URL.'),
  model: z
    .string()
    .default(MUSIC_DEFAULT_MODEL)
    .describe(`Music model ID. Default: \`${MUSIC_DEFAULT_MODEL}\` (mmx-cli canonical).`),
};

/** Result of cross-field validation. */
export interface MusicValidationResult {
  ok: boolean;
  /** Human-readable error message when `ok` is false. */
  error?: string;
}

/**
 * Cross-field validation for the music input. Returns the first failure
 * as a human-readable message; on success returns `{ ok: true }`.
 *
 * Encodes the two AC-7 rules:
 *   1. At least one of `prompt` or `lyrics` must be present.
 *   2. `instrumental=true` and `lyrics` are mutually exclusive.
 */
export function validateMusicInput(args: Record<string, unknown>): MusicValidationResult {
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  const lyrics = typeof args.lyrics === 'string' ? args.lyrics : '';
  const instrumental = args.instrumental === true;

  if (prompt.length === 0 && lyrics.length === 0) {
    return {
      ok: false,
      error: 'At least one of `prompt` or `lyrics` must be provided.',
    };
  }
  if (instrumental && lyrics.length > 0) {
    return {
      ok: false,
      error: '`instrumental=true` and `lyrics` are mutually exclusive. Omit `lyrics` (or set `instrumental=false`).',
    };
  }
  return { ok: true };
}

export const MUSIC_GENERATE_DESCRIPTION =
  'Generate music from a style prompt and/or lyrics via the MiniMax music API (default model `music-2.5`). ' +
  'At least one of `prompt` or `lyrics` is required. `instrumental=true` cannot be combined with `lyrics`. ' +
  'Returns the audio URL as text by default; pass `embed=true` for a base64 MCP `audio` block, or `save_path` to write to disk.';

export const MUSIC_TOOL_NAME = 'mmx_music_generate';

/**
 * Music handler. Runs the cross-field validator first, returns an MCP
 * `isError` result on failure, and otherwise returns a placeholder
 * response (the live HTTP call is not yet wired).
 */
export async function musicGenerateHandler(args: Record<string, unknown>): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const v = validateMusicInput(args);
  if (!v.ok) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `mmx_music_generate validation error: ${v.error}` }],
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text:
          'mmxomni: music generation is declared and validates input, but the live API ' +
          'call has not been wired up in this build.',
      },
    ],
  };
}

export function registerMusicTool(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  _client: import('../client.js').MmxcClient,
): void {
  server.tool(MUSIC_TOOL_NAME, MUSIC_GENERATE_DESCRIPTION, MusicGenerateInputSchema, musicGenerateHandler);
}
