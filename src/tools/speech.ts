/**
 * mmx_speech_synthesize — MiniMax text-to-speech tool (AC-6).
 *
 * Calls the MiniMax TTS endpoint (`/t2a_v2`) with the documented
 * `speech-2.8-hd` defaults, builds the standard mmx-cli request body
 * (`model` + `text` + `voice_setting` + `audio_setting` + optional
 * `language_boost`), and returns:
 *
 *   - text containing the hosted audio URL (default), or
 *   - one MCP `audio` content block per generated audio asset when
 *     `embed=true` (base64 bytes the host can play inline).
 *
 * Optionally downloads the generated audio to `save_path` in addition
 * to the return value.
 *
 * API errors are normalized via `src/errors.ts` and surfaced as
 * `{ isError: true, content: [...] }` tool results with the mapped MCP
 * code (1 / 3 / 4 / 10) included in the human-readable text — same
 * envelope as `mmx_image_generate` so downstream agents can parse it
 * the same way.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';
import { request as undiciRequest } from 'undici';

import type { MmxcClient } from '../client.js';
import { MmxcError, normalizeApiError } from '../errors.js';
import { log } from '../log.js';

/** Canonical mmx-cli default TTS model. Pinned for stable agent defaults. */
export const SPEECH_DEFAULT_MODEL = 'speech-2.8-hd';

/** Canonical mmx-cli default voice ID. */
export const SPEECH_DEFAULT_VOICE = 'English_expressive_narrator';

/**
 * mmx-cli TTS endpoint path. Sourced from the MiniMax public API
 * reference (v2 TTS). The MiniMax TTS API uses `voice_setting` and
 * `audio_setting` nested objects, plus an explicit `output_format`
 * field that controls whether the response carries hex-encoded audio
 * bytes or a hosted URL.
 */
export const SPEECH_TTS_PATH = '/t2a_v2';

/**
 * Allowed `sample_rate` values. We use `z.union([z.literal(), ...])` so
 * the enum round-trips through zod-to-json-schema — downstream agents
 * that introspect the JSON-Schema (rather than the zod source) see the
 * allowed values, not just min/max bounds.
 */
const SAMPLE_RATE_VALUES = [8000, 16000, 22050, 24000, 32000, 44100] as const;
type SampleRate = (typeof SAMPLE_RATE_VALUES)[number];
const sampleRateSchema = z
  .union(SAMPLE_RATE_VALUES.map((v) => z.literal(v)) as readonly [z.Literal<SampleRate>, ...z.Literal<SampleRate>[]])
  .default(32000)
  .describe('Audio sample rate in Hz. Allowed: 8000, 16000, 22050, 24000, 32000 (default), 44100.');

/** Allowed `bitrate` values (bps). */
const BITRATE_VALUES = [32000, 64000, 128000, 256000] as const;
type Bitrate = (typeof BITRATE_VALUES)[number];
const bitrateSchema = z
  .union(BITRATE_VALUES.map((v) => z.literal(v)) as readonly [z.Literal<Bitrate>, ...z.Literal<Bitrate>[]])
  .default(128000)
  .describe('Audio bitrate in bps. Allowed: 32000, 64000, 128000 (default), 256000.');

export const SpeechSynthesizeInputSchema = {
  text: z
    .string()
    .min(1, 'text is required')
    .max(10_000, 'text exceeds MiniMax TTS 10k char limit')
    .describe('Text to synthesize. Max 10,000 characters (mmx-cli limit).'),
  model: z
    .string()
    .default(SPEECH_DEFAULT_MODEL)
    .describe(
      `TTS model ID. Default: \`${SPEECH_DEFAULT_MODEL}\` (mmx-cli canonical). Other supported values: \`speech-2.6\`, \`speech-02\`.`,
    ),
  voice: z
    .string()
    .default(SPEECH_DEFAULT_VOICE)
    .describe(
      `Voice ID. Default: \`${SPEECH_DEFAULT_VOICE}\`. See MiniMax voice library for the full list (e.g. \`English_expressive_narrator\`, \`English_captivating_female1\`, \`male_english_uk\`, etc.).`,
    ),
  format: z
    .enum(['mp3', 'wav', 'flac', 'pcm'])
    .default('mp3')
    .describe('Audio container/encoding. Default: `mp3`.'),
  speed: z
    .number()
    .min(0.5)
    .max(2.0)
    .optional()
    .describe('Speed multiplier (0.5 - 2.0). 1.0 is normal speed.'),
  volume: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe('Volume level (0 - 10). Default leaves server value unchanged.'),
  pitch: z
    .number()
    .int()
    .min(-12)
    .max(12)
    .optional()
    .describe('Pitch adjustment in semitones (-12 - 12).'),
  sample_rate: sampleRateSchema,
  bitrate: bitrateSchema,
  language_boost: z
    .string()
    .optional()
    .describe('Language hint (e.g. `en`, `zh`, `ja`) to improve pronunciation for mixed-language text.'),
  save_path: z
    .string()
    .optional()
    .describe('If set, save the generated audio to this local file path in addition to returning the URL.'),
  embed: z
    .boolean()
    .default(false)
    .describe(
      'When `true`, embed the audio as a base64 MCP `audio` content block. When `false` (default), return the hosted URL as text.',
    ),
};

export const SPEECH_SYNTHESIZE_DESCRIPTION =
  'Synthesize speech from text via the MiniMax TTS API (default model `speech-2.8-hd`, voice `English_expressive_narrator`). ' +
  'By default returns the audio URL as text. Pass `embed=true` to receive a base64 MCP `audio` content block, or `save_path` ' +
  'to also write the file to disk.';

export const SPEECH_TOOL_NAME = 'mmx_speech_synthesize';

/* ------------------------------------------------------------------ *
 * Types for the MiniMax TTS endpoint response.                      *
 * ------------------------------------------------------------------ */

interface SpeechSynthResponse {
  /** Hex-encoded audio bytes. Returned when `output_format=hex`. */
  data?: {
    audio?: string;
    /** Hosted audio URL. Returned when `output_format=url`. */
    audio_url?: string;
  };
  /** Server-side timing / billing info. */
  extra_info?: Record<string, unknown>;
  /** Application-level status envelope (often non-zero on HTTP 200). */
  base_resp?: { status_code?: number; status_msg?: string };
}

/** MIME type for a given format. */
function mimeFromFormat(fmt: string): string {
  const f = fmt.toLowerCase();
  if (f === 'wav' || f === 'pcm') return 'audio/wav';
  if (f === 'flac') return 'audio/flac';
  return 'audio/mpeg'; // mp3
}

/** Extension for a given format. */
function extFromFormat(fmt: string): string {
  const f = fmt.toLowerCase();
  if (f === 'wav' || f === 'pcm') return 'wav';
  if (f === 'flac') return 'flac';
  return 'mp3';
}

/** Download a single URL to a buffer; throws on non-2xx. */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await undiciRequest(url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`download failed: HTTP ${res.statusCode} for ${url}`);
  }
  return Buffer.from(await res.body.arrayBuffer());
}

/** Hex string → Buffer. */
function hexToBuffer(hex: string): Buffer {
  // Node's Buffer supports 'hex' encoding directly.
  return Buffer.from(hex, 'hex');
}

/* ------------------------------------------------------------------ *
 * MCP tool result shape.                                            *
 * ------------------------------------------------------------------ */

type AudioContentBlock = { type: 'audio'; data: string; mimeType: string };
type TextContentBlock = { type: 'text'; text: string };

export interface SpeechToolResult {
  content: Array<AudioContentBlock | TextContentBlock>;
  isError?: boolean;
  // Loose index signature mirrors the MCP SDK's `CallToolResult`
  // `$loose` zod schema. Concrete properties are still enforced at
  // runtime by the zod-derived `CallToolResultSchema`.
  [key: string]: unknown;
}

export async function speechSynthesizeHandler(
  rawArgs: Record<string, unknown>,
  client: MmxcClient,
): Promise<SpeechToolResult> {
  const args = rawArgs as Partial<{
    text: string;
    model: string;
    voice: string;
    format: 'mp3' | 'wav' | 'flac' | 'pcm';
    speed: number;
    volume: number;
    pitch: number;
    sample_rate: number;
    bitrate: number;
    language_boost: string;
    save_path: string;
    embed: boolean;
  }>;

  const text = args.text ?? '';
  const model = args.model ?? SPEECH_DEFAULT_MODEL;
  const voice = args.voice ?? SPEECH_DEFAULT_VOICE;
  const format = (args.format ?? 'mp3') as 'mp3' | 'wav' | 'flac' | 'pcm';
  const embed = args.embed === true;
  const savePath = typeof args.save_path === 'string' && args.save_path ? args.save_path : undefined;
  const sampleRate = typeof args.sample_rate === 'number' ? args.sample_rate : 32000;
  const bitrate = typeof args.bitrate === 'number' ? args.bitrate : 128000;

  // Build the mmx-cli TTS request body. Default to `output_format=url`
  // so the response carries a hosted audio URL (cheap to return as
  // text). When `embed=true` we ask the server for hex bytes so we
  // can base64-encode them locally without an extra round-trip.
  const body: Record<string, unknown> = {
    model,
    text,
    stream: false,
    output_format: embed ? 'hex' : 'url',
    voice_setting: {
      voice_id: voice,
      ...(typeof args.speed === 'number' ? { speed: args.speed } : {}),
      ...(typeof args.volume === 'number' ? { vol: args.volume } : {}),
      ...(typeof args.pitch === 'number' ? { pitch: args.pitch } : {}),
    },
    audio_setting: {
      sample_rate: sampleRate,
      bitrate,
      format,
      channel: 1,
    },
  };
  if (typeof args.language_boost === 'string' && args.language_boost) {
    body.language_boost = args.language_boost;
  }

  let response: SpeechSynthResponse;
  try {
    response = await client.request<SpeechSynthResponse>({
      method: 'POST',
      path: SPEECH_TTS_PATH,
      body,
    });
    // Surface non-zero `base_resp.status_code` (HTTP 200 + business
    // error) through the same MmxcError -> formatted text path that
    // `mmx_image_generate` uses, so the (mmx_code=..., mcp_code=...)
    // envelope is consistent across tools.
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
              `mmx_speech_synthesize: ${err.message} ` +
              `(mmx_code=${err.code}, http_status=${err.httpStatus}, mcp_code=${code})`,
          },
        ],
      };
    }
    throw err;
  }

  // Resolve the audio payload to a buffer + source URL. With
  // output_format=hex the bytes are inline; with output_format=url
  // we download the hosted asset.
  const mimeType = mimeFromFormat(format);
  const ext = extFromFormat(format);
  let buffer: Buffer | undefined;
  let sourceUrl: string | undefined;
  if (response.data?.audio && embed) {
    buffer = hexToBuffer(response.data.audio);
  } else if (response.data?.audio_url) {
    sourceUrl = response.data.audio_url;
    if (embed) {
      try {
        buffer = await downloadToBuffer(sourceUrl);
      } catch (err) {
        log.warn(`mmx_speech_synthesize: failed to embed ${sourceUrl}:`, err);
      }
    }
  }

  if (!buffer && !sourceUrl) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'mmx_speech_synthesize: API returned no audio. ' +
            `Response: ${JSON.stringify(response).slice(0, 2000)}`,
        },
      ],
    };
  }

  // Optional: download to disk before returning.
  const savedPaths: string[] = [];
  if (savePath && buffer) {
    try {
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, buffer);
      savedPaths.push(savePath);
    } catch (err) {
      log.warn(`mmx_speech_synthesize: failed to save audio to ${savePath}:`, err);
    }
  } else if (savePath && sourceUrl) {
    try {
      await mkdir(dirname(savePath), { recursive: true });
      const buf = await downloadToBuffer(sourceUrl);
      await writeFile(savePath, buf);
      savedPaths.push(savePath);
      buffer = buf;
    } catch (err) {
      log.warn(`mmx_speech_synthesize: failed to save audio to ${savePath}:`, err);
    }
  }

  if (embed) {
    if (!buffer) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'mmx_speech_synthesize: failed to obtain audio bytes for embed=true',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'audio',
          data: buffer.toString('base64'),
          mimeType,
        },
      ],
    };
  }

  // Default: return the URL as a text block.
  const lines: string[] = [];
  if (sourceUrl) {
    lines.push(`Audio generated (${format}, ${ext}):`, sourceUrl);
  } else if (buffer && savePath && savedPaths.length > 0) {
    lines.push(`Audio generated (${format}, ${ext}); saved to: ${savePath}`);
  } else {
    // We have a buffer but no URL — only happens if the server returned
    // hex bytes with output_format=url (misconfig) or embed was set
    // but the embed branch above was skipped. Surface what we know.
    lines.push(`Audio generated (${format}, ${ext}, ${buffer.length} bytes).`);
  }
  if (savedPaths.length > 0) {
    lines.push('', 'Saved to:', ...savedPaths);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/* ------------------------------------------------------------------ *
 * MCP registration.                                                 *
 * ------------------------------------------------------------------ */

export function registerSpeechTool(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  client: MmxcClient,
): void {
  server.tool(SPEECH_TOOL_NAME, SPEECH_SYNTHESIZE_DESCRIPTION, SpeechSynthesizeInputSchema, async (args) => {
    return speechSynthesizeHandler(args as Record<string, unknown>, client);
  });
}
