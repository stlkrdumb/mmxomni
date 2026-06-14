/**
 * Tests for `src/tools/music.ts` (AC-7).
 *
 * Mirrors the request/response coverage we give `mmx_image_generate` in
 * `test/image.test.ts` and `mmx_speech_synthesize` in
 * `test/speech.test.ts`, but for the music path. The AC-7 text is
 * primarily about *validation* (cross-field rules + per-field bounds
 * in the JSON-Schema), so the test cases focus on:
 *
 *   - (1) `validateMusicInput` returns ok=false with the
 *         at-least-one-of message when both `prompt` and `lyrics` are
 *         missing;
 *   - (2) `validateMusicInput` returns ok=true when only `prompt` is
 *         set;
 *   - (3) `validateMusicInput` returns ok=true when only `lyrics` is
 *         set;
 *   - (4) `validateMusicInput` returns ok=false with the
 *         mutually-exclusive message when `instrumental:true` AND
 *         `lyrics` are both set;
 *   - (5) `validateMusicInput` returns ok=true when `instrumental:true`
 *         and no `lyrics`;
 *   - (6) the JSON-Schema rejects an out-of-enum `sample_rate` (e.g.
 *         99999) at input-validation time with the refine() error
 *         message;
 *   - (7) the JSON-Schema rejects an out-of-range `bpm` (e.g. 500
 *         above the 220 maximum) at input-validation time.
 *
 * Tests (1)-(5) are pure-function tests against the exported
 * `validateMusicInput`. Tests (6) and (7) ride on zod's
 * `z.object({...MusicGenerateInputSchema})` parse — the same shape
 * the MCP SDK uses internally when it validates `tools/call` input.
 *
 * The tests are pure and synchronous; no `MockAgent` is needed.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  MusicGenerateInputSchema,
  validateMusicInput,
} from '../src/tools/music.js';

// Wrap the flat exported shape in a z.object() so we can drive
// zod's per-field validation directly. This mirrors what the MCP
// SDK does internally when it validates `tools/call` arguments,
// so an error here is the exact same error an agent would see
// when it sent the bad payload over stdio.
const MusicInputObject = z.object(MusicGenerateInputSchema);

describe('validateMusicInput (AC-7 cross-field validation)', () => {
  it('(1) returns ok=false with the at-least-one-of message when both prompt and lyrics are missing', () => {
    const result = validateMusicInput({});
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('At least one of');
    expect(result.error).toContain('prompt');
    expect(result.error).toContain('lyrics');
  });

  it('(1b) returns ok=false when prompt and lyrics are both empty strings', () => {
    // The validator must not treat empty strings as "present".
    const result = validateMusicInput({ prompt: '', lyrics: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('At least one of');
  });

  it('(2) returns ok=true when only prompt is set', () => {
    const result = validateMusicInput({ prompt: 'upbeat folk with acoustic guitar' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('(3) returns ok=true when only lyrics is set', () => {
    const result = validateMusicInput({ lyrics: '[verse]\nhello world\n[chorus]\nla la la' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('(4) returns ok=false with the mutually-exclusive message when instrumental=true AND lyrics are both set', () => {
    const result = validateMusicInput({ instrumental: true, lyrics: '[verse] hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('mutually exclusive');
    expect(result.error).toContain('instrumental');
    expect(result.error).toContain('lyrics');
  });

  it('(5) returns ok=true when instrumental=true and no lyrics', () => {
    const result = validateMusicInput({ instrumental: true, prompt: 'cinematic orchestral' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('(5b) returns ok=true when neither instrumental nor lyrics is set, and only prompt is provided', () => {
    // Edge case: caller relies on the default false and does not set
    // instrumental at all. The schema default + the cross-field
    // validator must both accept it.
    const result = validateMusicInput({ prompt: 'lo-fi study beats' });
    expect(result.ok).toBe(true);
  });
});

describe('MusicGenerateInputSchema (AC-7 per-field bounds)', () => {
  it('(6) rejects an out-of-enum sample_rate (99999) with the refine() error message', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'jazz piano',
      sample_rate: 99999,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    // The refine() message is the only diagnostic the agent gets.
    const sampleRateIssue = parsed.error.issues.find((i) => i.path.includes('sample_rate'));
    expect(sampleRateIssue).toBeDefined();
    expect(sampleRateIssue?.message).toContain('sample_rate must be one of');
    expect(sampleRateIssue?.message).toContain('16000');
    expect(sampleRateIssue?.message).toContain('48000');
  });

  it('(6b) accepts every allowed sample_rate value', () => {
    for (const sr of [16000, 22050, 24000, 32000, 44100, 48000]) {
      const parsed = MusicInputObject.safeParse({ prompt: 'jazz piano', sample_rate: sr });
      expect(parsed.success).toBe(true);
    }
  });

  it('(7) rejects an out-of-range bpm (500) above the 220 maximum', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'fast drum and bass',
      bpm: 500,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    const bpmIssue = parsed.error.issues.find((i) => i.path.includes('bpm'));
    expect(bpmIssue).toBeDefined();
    // zod's min/max validators emit a 'too_big' code; the issue is
    // still attached to the bpm path so the agent can see which
    // field failed.
    expect(bpmIssue?.code).toBe('too_big');
  });

  it('(7b) rejects bpm below the 40 minimum', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'extremely slow funeral doom',
      bpm: 5,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    const bpmIssue = parsed.error.issues.find((i) => i.path.includes('bpm'));
    expect(bpmIssue).toBeDefined();
    expect(bpmIssue?.code).toBe('too_small');
  });

  it('(7c) accepts a bpm within [40, 220]', () => {
    for (const bpm of [40, 90, 120, 180, 220]) {
      const parsed = MusicInputObject.safeParse({ prompt: 'pop', bpm });
      expect(parsed.success).toBe(true);
    }
  });

  it('(7d) accepts the full mmx-cli control set in a single call', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'warm indie folk with rich harmonies',
      vocals: 'male and female duet',
      genre: 'folk',
      mood: 'nostalgic',
      instruments: 'acoustic guitar, mandolin, brushed drums',
      tempo: 'moderate',
      bpm: 96,
      key: 'G major',
      structure: 'verse-chorus-verse-bridge-chorus',
      references: 'similar to The Lumineers',
      avoid: 'distorted electric guitar',
      use_case: 'film soundtrack',
      instrumental: false,
      aigc_watermark: true,
      format: 'mp3',
      sample_rate: 44100,
      bitrate: 256000,
      save_path: '/tmp/out.mp3',
      model: 'music-2.5',
    });
    expect(parsed.success).toBe(true);
  });

  it('(7e) rejects an out-of-enum format', () => {
    const parsed = MusicInputObject.safeParse({
      prompt: 'rock',
      format: 'ogg', // not in the allowed enum
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const formatIssue = parsed.error.issues.find((i) => i.path.includes('format'));
    expect(formatIssue).toBeDefined();
  });
});
