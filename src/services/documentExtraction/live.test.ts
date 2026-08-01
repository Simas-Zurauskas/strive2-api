import { describe, it, expect } from 'vitest';
import { buildPdf, buildWav } from './__fixtures__/builders';
import { transcribePdfPages } from './visionEscalation';
import { extractAudio } from './audio';

/**
 * Opt-in live integration tests — hit the real Anthropic / OpenAI APIs.
 * Skipped unless RUN_LIVE=1 (and real keys in the environment):
 *
 *   RUN_LIVE=1 yarn vitest run src/services/documentExtraction/live.test.ts
 */
const LIVE = process.env.RUN_LIVE === '1';

describe.skipIf(!LIVE)('live: vision escalation', () => {
  it('transcribes a one-page pdf through the real Anthropic API', async () => {
    const pdf = buildPdf(['STRIVE LIVE TEST PAGE. The capital of France is Paris.']);
    const result = await transcribePdfPages({ pdf, pages: [1], pageCount: 1, filename: 'live.pdf' });
    expect(result.transcribedPages).toEqual([1]);
    expect(result.blocks[0].markdown.toLowerCase()).toContain('paris');
  }, 120_000);
});

describe.skipIf(!LIVE)('live: audio transcription', () => {
  it('transcribes a short wav through the real OpenAI API', async () => {
    // 2 s of silence at a real sample rate so the API accepts it.
    const wav = buildWav({ seconds: 2, sampleRate: 16_000 });
    const result = await extractAudio(
      { buffer: wav, mimeType: 'audio/wav', filename: 'live.wav', kind: 'file' },
      { mode: 'full' },
    );
    expect(result.audioDurationSec).toBeCloseTo(2, 0);
    expect(typeof result.markdown).toBe('string');
  }, 120_000);
});
