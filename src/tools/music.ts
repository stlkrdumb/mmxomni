/**
 * mmx_music_generate — MiniMax music generation tool.
 *
 * Calls the MiniMax music generation endpoint (default model `music-2.5`).
 * Cross-field validation rules (`prompt`/`lyrics` at-least-one,
 * `instrumental=true` + `lyrics` mutual exclusion) are enforced at handler
 * runtime via `validateMusicInput`. Returns the audio URL as text by
 * default, or a base64 MCP `audio` content block when `embed=true`.
 */

import { z } from 'zod';
import { request as undiciRequest } from 'undici';

import { MmxcError, normalizeApiError } from '../errors.js';
import { log } from '../log.js';

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

/** mmx-cli default music generation endpoint path. */
export const MUSIC_GENERATE_PATH = '/music_generation';

/** MIME type for a given format. */
function mimeFromFormat(fmt: string): string {
  const f = fmt.toLowerCase();
  if (f === 'wav') return 'audio/wav';
  if (f === 'flac') return 'audio/flac';
  return 'audio/mpeg'; // mp3
}

/** Extension for a given format. */
function extFromFormat(fmt: string): string {
  const f = fmt.toLowerCase();
  if (f === 'wav') return 'wav';
  if (f === 'flac') return 'flac';
  return 'mp3';
}

/* ------------------------------------------------------------------ *
 * Types for the MiniMax music endpoint response.                     *
 * ------------------------------------------------------------------ */

interface MusicGenerateResponse {
  /** Hosted audio URL from the server. */
  audio_url?: string;
  /** Hex-encoded audio bytes (when format=hex is requested). */
  data?: {
    audio?: string;
  };
  /** Application-level status envelope. */
  base_resp?: { status_code?: number; status_msg?: string };
  /** Server-side metadata. */
  extra_info?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * MCP tool result shape.                                            *
 * ------------------------------------------------------------------ */

type AudioContentBlock = { type: 'audio'; data: string; mimeType: string };
type TextContentBlock = { type: 'text'; text: string };

export interface MusicToolResult {
  content: Array<AudioContentBlock | TextContentBlock>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Format an error caught during the handler into the MCP result shape. */
function formatMusicError(toolName: string, err: unknown): MusicToolResult {
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

/* ------------------------------------------------------------------ *
 * Real HTTP handler.                                                *
 * ------------------------------------------------------------------ */

/**
 * Music handler. Runs the cross-field validator, calls the MiniMax
 * music generation API, and returns the audio as a URL (default) or
 * as a base64 MCP `audio` content block when `embed=true`.
 */
export async function musicGenerateHandler(
  rawArgs: Record<string, unknown>,
  client: import('../client.js').MmxcClient,
): Promise<MusicToolResult> {
  const TOOL = MUSIC_TOOL_NAME;

  // Cross-field validation.
  const v = validateMusicInput(rawArgs);
  if (!v.ok) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `${TOOL} validation error: ${v.error}` }],
    };
  }

  const model = typeof rawArgs.model === 'string' && rawArgs.model ? rawArgs.model : MUSIC_DEFAULT_MODEL;
  const format = (rawArgs.format === 'wav' || rawArgs.format === 'flac' ? rawArgs.format : 'mp3') as 'mp3' | 'wav' | 'flac';
  const embed = rawArgs.embed === true;
  const savePath = typeof rawArgs.save_path === 'string' && rawArgs.save_path ? rawArgs.save_path : undefined;
  const instrumental = rawArgs.instrumental === true;

  // Build the request body matching the MiniMax music generation API.
  const body: Record<string, unknown> = {
    model,
    ...(typeof rawArgs.prompt === 'string' && rawArgs.prompt ? { prompt: rawArgs.prompt } : {}),
    ...(typeof rawArgs.lyrics === 'string' && rawArgs.lyrics ? { lyrics: rawArgs.lyrics } : {}),
    instrumental,
    ...(typeof rawArgs.sample_rate === 'number' ? { sample_rate: rawArgs.sample_rate } : { sample_rate: 44100 }),
    ...(typeof rawArgs.bitrate === 'number' ? { bitrate: rawArgs.bitrate } : { bitrate: 256000 }),
    ...(rawArgs.format ? { format } : { format: 'mp3' }),
    ...(rawArgs.aigc_watermark === true ? { aigc_watermark: true } : {}),
  };

  // Add optional control fields only when set.
  if (typeof rawArgs.vocals === 'string' && rawArgs.vocals) body.vocals = rawArgs.vocals;
  if (typeof rawArgs.genre === 'string' && rawArgs.genre) body.genre = rawArgs.genre;
  if (typeof rawArgs.mood === 'string' && rawArgs.mood) body.mood = rawArgs.mood;
  if (typeof rawArgs.instruments === 'string' && rawArgs.instruments) body.instruments = rawArgs.instruments;
  if (typeof rawArgs.tempo === 'string' && rawArgs.tempo) body.tempo = rawArgs.tempo;
  if (typeof rawArgs.bpm === 'number') body.bpm = rawArgs.bpm;
  if (typeof rawArgs.key === 'string' && rawArgs.key) body.key = rawArgs.key;
  if (typeof rawArgs.structure === 'string' && rawArgs.structure) body.structure = rawArgs.structure;
  if (typeof rawArgs.references === 'string' && rawArgs.references) body.references = rawArgs.references;
  if (typeof rawArgs.avoid === 'string' && rawArgs.avoid) body.avoid = rawArgs.avoid;
  if (typeof rawArgs.use_case === 'string' && rawArgs.use_case) body.use_case = rawArgs.use_case;

  let response: MusicGenerateResponse;
  try {
    response = await client.request<MusicGenerateResponse>({
      method: 'POST',
      path: MUSIC_GENERATE_PATH,
      body,
    });
    const br = response.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
      throw new MmxcError(normalizeApiError(200, response));
    }
  } catch (err) {
    log.debug(`${TOOL} request failed:`, err);
    return formatMusicError(TOOL, err);
  }

  // Resolve the audio URL or inline bytes.
  const mimeType = mimeFromFormat(format);
  const ext = extFromFormat(format);
  let sourceUrl: string | undefined;
  let audioData: string | undefined;

  if (typeof response.audio_url === 'string' && response.audio_url) {
    sourceUrl = response.audio_url;
  } else if (response.data?.audio) {
    // Hex-encoded inline audio.
    audioData = Buffer.from(response.data.audio, 'hex').toString('base64');
  }

  // If embed is requested and we have a URL, download the bytes.
  if (embed && sourceUrl && !audioData) {
    try {
      const { request as undiciRequest } = await import('undici');
      const dlRes = await undiciRequest(sourceUrl);
      if (dlRes.statusCode >= 200 && dlRes.statusCode < 300) {
        const ab = await dlRes.body.arrayBuffer();
        audioData = Buffer.from(ab).toString('base64');
      } else {
        log.warn(`${TOOL}: failed to download ${sourceUrl} for embed (HTTP ${dlRes.statusCode})`);
      }
    } catch (dlErr) {
      log.warn(`${TOOL}: failed to download ${sourceUrl} for embed:`, dlErr);
    }
  }

  if (!sourceUrl && !audioData) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${TOOL}: API returned no audio. ` +
            `Response: ${JSON.stringify(response).slice(0, 2000)}`,
        },
      ],
    };
  }

  // Optional: download to disk.
  const savedPaths: string[] = [];
  if (savePath && audioData) {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, Buffer.from(audioData, 'base64'));
      savedPaths.push(savePath);
    } catch (writeErr) {
      log.warn(`${TOOL}: failed to save audio to ${savePath}:`, writeErr);
    }
  } else if (savePath && sourceUrl) {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const { request as undiciRequest } = await import('undici');
      await mkdir(dirname(savePath), { recursive: true });
      const dlRes = await undiciRequest(sourceUrl);
      if (dlRes.statusCode >= 200 && dlRes.statusCode < 300) {
        const ab = await dlRes.body.arrayBuffer();
        await writeFile(savePath, Buffer.from(ab));
        savedPaths.push(savePath);
      } else {
        log.warn(`${TOOL}: failed to download for save_path (HTTP ${dlRes.statusCode})`);
      }
    } catch (writeErr) {
      log.warn(`${TOOL}: failed to save to ${savePath}:`, writeErr);
    }
  }

  // Build the result content.
  const content: Array<AudioContentBlock | TextContentBlock> = [];
  if (embed && audioData) {
    content.push({ type: 'audio', data: audioData, mimeType });
  } else if (sourceUrl) {
    const parts = [`${TOOL}: audio generated at ${sourceUrl}`];
    if (savedPaths.length > 0) parts.push(`Saved to: ${savedPaths.join(', ')}`);
    content.push({ type: 'text', text: parts.join('\n') });
  } else if (audioData) {
    // Fallback: we have inline data but embed was false — unlikely but safe.
    content.push({ type: 'text', text: `${TOOL}: audio generated (inline, ${audioData.length} base64 bytes)` });
  }

  return { content };
}

export function registerMusicTool(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  client: import('../client.js').MmxcClient,
): void {
  server.tool(MUSIC_TOOL_NAME, MUSIC_GENERATE_DESCRIPTION, MusicGenerateInputSchema, async (args) => {
    return musicGenerateHandler(args as Record<string, unknown>, client);
  });
}
