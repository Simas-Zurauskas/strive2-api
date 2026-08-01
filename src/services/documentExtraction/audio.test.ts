import { describe, it, expect, vi, beforeEach } from 'vitest';

const { transcriptionsCreate, toFileMock, recordUsageMock } = vi.hoisted(() => ({
  transcriptionsCreate: vi.fn(),
  toFileMock: vi.fn(async (buf: Buffer, name: string) => ({ buf, name })),
  recordUsageMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    audio = { transcriptions: { create: transcriptionsCreate } };
  },
  toFile: toFileMock,
}));

vi.mock('@services/usageService', () => ({ recordUsage: recordUsageMock }));

import { extractAudio, probeAudioDuration, sliceWavToSeconds } from './audio';
import { buildWav } from './__fixtures__/builders';

/** Minimal MPEG1 Layer3 128 kbps 44.1 kHz frame header + filler. */
const buildFakeMp3 = (bytes: number): Buffer => {
  const buf = Buffer.alloc(bytes);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x90; // 128 kbps, 44.1 kHz
  buf[3] = 0x00;
  return buf;
};

beforeEach(() => {
  transcriptionsCreate.mockReset();
  toFileMock.mockClear();
  recordUsageMock.mockReset();
  transcriptionsCreate.mockResolvedValue({ text: 'lecture transcript text' });
});

describe('probeAudioDuration', () => {
  it('parses wav header duration', () => {
    const wav = buildWav({ seconds: 1200 });
    const probe = probeAudioDuration({ buffer: wav, mimeType: 'audio/wav' });
    expect(probe.durationSec).toBeCloseTo(1200, 0);
  });

  it('estimates mp3 duration from the first frame bitrate', () => {
    // 128 kbps → 16_000 bytes/s; 160_000 bytes ≈ 10 s.
    const mp3 = buildFakeMp3(160_000);
    const probe = probeAudioDuration({ buffer: mp3, mimeType: 'audio/mpeg' });
    expect(probe.durationSec).toBeCloseTo(10, 0);
  });

  it('returns undefined duration for garbage', () => {
    const probe = probeAudioDuration({ buffer: Buffer.from('nonsense'), mimeType: 'audio/wav' });
    expect(probe.durationSec).toBeUndefined();
  });
});

describe('sliceWavToSeconds', () => {
  it('produces a valid shorter wav', () => {
    const wav = buildWav({ seconds: 1200 });
    const sliced = sliceWavToSeconds(wav, 600);
    expect(sliced.length).toBeLessThan(wav.length);
    const probe = probeAudioDuration({ buffer: sliced, mimeType: 'audio/wav' });
    expect(probe.durationSec).toBeCloseTo(600, 0);
  });

  it('returns the original when the budget exceeds duration', () => {
    const wav = buildWav({ seconds: 30 });
    expect(sliceWavToSeconds(wav, 600).length).toBe(wav.length);
  });
});

describe('extractAudio', () => {
  it('triage on wav: slices to the budget, bills sliced minutes, warns', async () => {
    const wav = buildWav({ seconds: 1200 });
    const result = await extractAudio(
      { buffer: wav, mimeType: 'audio/wav', filename: 'talk.wav', kind: 'file' },
      { mode: 'triage', audioSecondsBudget: 600 },
    );
    expect(result.audioDurationSec).toBeCloseTo(1200, 0);
    expect(result.transcribedSec).toBeCloseTo(600, 0);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('text');
    expect(result.markdown).toContain('lecture transcript text');
    expect(result.warnings.some((w) => w.toLowerCase().includes('triage'))).toBe(true);
    // The API received the SLICED buffer, not the full file.
    const sent = toFileMock.mock.calls[0][0] as Buffer;
    expect(sent.length).toBeLessThan(wav.length);
    // Billed at 10 min × 3_000 µ¢/min.
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'openai', action: 'doc:transcribe', costMicroCents: 30_000 }),
    );
  });

  it('full mode on wav: whole file, full billing', async () => {
    const wav = buildWav({ seconds: 1200 });
    const result = await extractAudio(
      { buffer: wav, mimeType: 'audio/wav', filename: 'talk.wav', kind: 'file' },
      { mode: 'full' },
    );
    expect(result.transcribedSec).toBeCloseTo(1200, 0);
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ costMicroCents: 60_000 }),
    );
  });

  it('triage on mp3: sends the whole file and warns that triage cost full transcription', async () => {
    const mp3 = buildFakeMp3(160_000); // ≈10 s
    const result = await extractAudio(
      { buffer: mp3, mimeType: 'audio/mpeg', filename: 'talk.mp3', kind: 'file' },
      { mode: 'triage', audioSecondsBudget: 5 },
    );
    const sent = toFileMock.mock.calls[0][0] as Buffer;
    expect(sent.length).toBe(mp3.length);
    expect(result.transcribedSec).toBeCloseTo(result.audioDurationSec!, 0);
    expect(result.warnings.some((w) => w.includes('full transcription'))).toBe(true);
  });

  it('rejects unparseable wav bytes with audio_parse_failed', async () => {
    await expect(
      extractAudio(
        { buffer: Buffer.from('not audio at all'), mimeType: 'audio/wav', filename: 'x.wav', kind: 'file' },
        { mode: 'triage' },
      ),
    ).rejects.toMatchObject({ name: 'ExtractionError', reason: 'audio_parse_failed' });
  });

  it('maps API failure to audio_transcription_failed and bills nothing', async () => {
    transcriptionsCreate.mockRejectedValue(new Error('boom'));
    const wav = buildWav({ seconds: 30 });
    await expect(
      extractAudio(
        { buffer: wav, mimeType: 'audio/wav', filename: 'x.wav', kind: 'file' },
        { mode: 'full' },
      ),
    ).rejects.toMatchObject({ reason: 'audio_transcription_failed' });
    expect(recordUsageMock).not.toHaveBeenCalled();
  });
});
