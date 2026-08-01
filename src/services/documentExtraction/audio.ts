import OpenAI, { toFile } from 'openai';
import { OPENAI_API_KEY } from '@conf/env';
import { recordUsage } from '@services/usageService';
import { priceFlatUnit } from '@lib/pricing';
import { withRetry } from '@lib/retry';
import { integrationLog } from '@lib/loggers';
import {
  DEFAULT_AUDIO_SECONDS_BUDGET,
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  normalizeExtractedText,
} from './types';

/**
 * Audio (mp3/m4a/wav) → OpenAI `gpt-4o-mini-transcribe` (existing
 * vendor + key; the client-construction idiom mirrors
 * `lib/openaiEmbeddings.ts`). Billed per minute actually transcribed:
 * `SERVICE_PRICING.openai_transcribe_minute` × minutes → `recordUsage`
 * (service `openai`, action `doc:transcribe`). Billing happens ONLY on
 * success — we don't pay-forward failed calls (embedBatch precedent).
 *
 * Duration probe: minimal header parsing per container — wav RIFF
 * (fmt byteRate + data size — exact), mp3 first-frame bitrate (CBR
 * estimate), m4a mvhd (timescale/duration — exact). Unknown duration
 * degrades to an estimate from the API's audio-token usage, then a
 * bitrate worst-case, each with a warning.
 *
 * Triage slicing decision (recorded per plan Phase 2): wav is sliced by
 * bytes (PCM data is byte-addressable — exact and cheap). mp3/m4a are
 * NOT reliably byte-sliceable (frame boundaries / moov atoms), and the
 * transcription API has no "first N seconds" parameter — so triage of
 * mp3/m4a transcribes the WHOLE file and says so in a warning
 * (`transcribedSec` = full duration). Cost stays bounded by the A9
 * upload cap (≤180 min/course).
 */

const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const TRANSCRIBE_LABEL = 'doc:transcribe';
// gpt-4o-class audio tokenization ≈ 10 tokens/second — used only as a
// duration fallback when header parsing failed.
const AUDIO_TOKENS_PER_SECOND = 10;
// Worst-case bitrate assumption for the last-resort duration estimate.
const FALLBACK_BITRATE_BPS = 128_000;
// The transcription endpoint rejects files over 25 MB.
const OPENAI_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

let client: OpenAI | null = null;
const getClient = (): OpenAI | null => {
  if (!OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
};

// ── Duration probes ────────────────────────────────────────

interface WavLayout {
  byteRate: number;
  dataOffset: number;
  dataLength: number;
  headerEnd: number;
}

const parseWavLayout = (buffer: Buffer): WavLayout | null => {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate: number | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      if (offset + 16 > buffer.length) return null;
      byteRate = buffer.readUInt32LE(offset + 16);
    }
    if (chunkId === 'data') {
      if (byteRate === null || byteRate <= 0) return null;
      const dataOffset = offset + 8;
      const dataLength = Math.min(chunkSize, buffer.length - dataOffset);
      return { byteRate, dataOffset, dataLength, headerEnd: dataOffset };
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return null;
};

// MPEG1 Layer III bitrate table (kbps), index = header bits.
const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];

const probeMp3DurationSec = (buffer: Buffer): number | null => {
  let offset = 0;
  // Skip ID3v2 tag if present.
  if (buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const size =
      ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size;
  }
  // Find the first frame sync.
  for (; offset + 4 <= buffer.length; offset++) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) break;
  }
  if (offset + 4 > buffer.length) return null;
  const bitrateKbps = MP3_BITRATES[(buffer[offset + 2] >> 4) & 0x0f];
  if (!bitrateKbps) return null;
  // CBR estimate — honest enough for billing/triage decisions.
  return ((buffer.length - offset) * 8) / (bitrateKbps * 1000);
};

const probeM4aDurationSec = (buffer: Buffer): number | null => {
  // Walk top-level boxes for moov → mvhd (version 0: 32-bit fields).
  const findBox = (start: number, end: number, type: string): { offset: number; size: number } | null => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = buffer.readUInt32BE(offset);
      const boxType = buffer.toString('ascii', offset + 4, offset + 8);
      if (size < 8) return null;
      if (boxType === type) return { offset, size };
      offset += size;
    }
    return null;
  };
  const moov = findBox(0, buffer.length, 'moov');
  if (!moov) return null;
  const mvhd = findBox(moov.offset + 8, Math.min(moov.offset + moov.size, buffer.length), 'mvhd');
  if (!mvhd || mvhd.offset + 32 > buffer.length) return null;
  const version = buffer[mvhd.offset + 8];
  if (version === 1) {
    const timescale = buffer.readUInt32BE(mvhd.offset + 28);
    const duration = Number(buffer.readBigUInt64BE(mvhd.offset + 32));
    return timescale > 0 ? duration / timescale : null;
  }
  const timescale = buffer.readUInt32BE(mvhd.offset + 20);
  const duration = buffer.readUInt32BE(mvhd.offset + 24);
  return timescale > 0 ? duration / timescale : null;
};

export interface AudioProbe {
  durationSec?: number;
  method: 'wav-header' | 'mp3-bitrate' | 'm4a-mvhd' | 'unknown';
}

export const probeAudioDuration = ({
  buffer,
  mimeType,
}: {
  buffer: Buffer;
  mimeType: string;
}): AudioProbe => {
  if (/wav/i.test(mimeType)) {
    const layout = parseWavLayout(buffer);
    if (layout) return { durationSec: layout.dataLength / layout.byteRate, method: 'wav-header' };
    return { method: 'unknown' };
  }
  if (/mpeg|mp3/i.test(mimeType)) {
    const durationSec = probeMp3DurationSec(buffer);
    return durationSec ? { durationSec, method: 'mp3-bitrate' } : { method: 'unknown' };
  }
  if (/mp4|m4a/i.test(mimeType)) {
    const durationSec = probeM4aDurationSec(buffer);
    return durationSec ? { durationSec, method: 'm4a-mvhd' } : { method: 'unknown' };
  }
  return { method: 'unknown' };
};

/** Byte-exact PCM slice: keep the header, cut `data` to `seconds`. */
export const sliceWavToSeconds = (buffer: Buffer, seconds: number): Buffer => {
  const layout = parseWavLayout(buffer);
  if (!layout) return buffer;
  const maxDataLength = Math.floor(layout.byteRate * seconds);
  if (layout.dataLength <= maxDataLength) return buffer;
  const header = Buffer.from(buffer.subarray(0, layout.headerEnd));
  const data = buffer.subarray(layout.dataOffset, layout.dataOffset + maxDataLength);
  // Patch RIFF + data chunk sizes for the shorter payload.
  header.writeUInt32LE(layout.headerEnd - 8 + data.length, 4);
  header.writeUInt32LE(data.length, layout.headerEnd - 4);
  return Buffer.concat([header, data]);
};

// ── Extraction ─────────────────────────────────────────────

const FILE_EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav', // file-type's canonical sniffed mime for RIFF/WAVE
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
};

export const extractAudio = async (
  input: ExtractionInput,
  opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const warnings: string[] = [];
  const isWav = /wav/i.test(input.mimeType);

  const probe = probeAudioDuration({ buffer: input.buffer, mimeType: input.mimeType });
  if (isWav && probe.durationSec === undefined) {
    // A wav we cannot even parse the header of will not transcribe either.
    throw new ExtractionError('audio_parse_failed', 'could not parse the audio container');
  }
  if (probe.durationSec === undefined) {
    warnings.push('audio: duration could not be determined from the file header');
  }

  const budgetSec = opts.audioSecondsBudget ?? DEFAULT_AUDIO_SECONDS_BUDGET;
  let sendBuffer = input.buffer;
  let transcribedSec = probe.durationSec;

  if (opts.mode === 'triage' && probe.durationSec !== undefined && probe.durationSec > budgetSec) {
    if (isWav) {
      sendBuffer = sliceWavToSeconds(input.buffer, budgetSec);
      transcribedSec = Math.min(probe.durationSec, budgetSec);
      warnings.push(
        `audio: triage transcribed the first ${Math.round(budgetSec / 60)} min of ${Math.round(probe.durationSec / 60)} min; the rest is transcribed when you continue`,
      );
    } else {
      // mp3/m4a are not byte-sliceable — see module header decision.
      warnings.push(
        'audio: triage required full transcription for this format (mp3/m4a cannot be sliced reliably)',
      );
    }
  }

  if (sendBuffer.length > OPENAI_AUDIO_MAX_BYTES) {
    throw new ExtractionError(
      'audio_parse_failed',
      `audio file exceeds the ${Math.round(OPENAI_AUDIO_MAX_BYTES / (1024 * 1024))} MB transcription limit`,
    );
  }

  const openai = getClient();
  if (!openai) {
    throw new ExtractionError('audio_transcription_failed', 'transcription is not configured');
  }

  const ext = FILE_EXT[input.mimeType.toLowerCase()] ?? 'mp3';
  let text: string;
  let usageAudioTokens = 0;
  try {
    // Explicit per-call deadline: the OpenAI SDK default is 10 min —
    // the whole job budget. 3 attempts × 180 s stays strictly inside
    // the 600 s job timeout (resilience: inner < outer).
    const response = await withRetry(
      async () =>
        openai.audio.transcriptions.create(
          {
            file: await toFile(sendBuffer, `audio.${ext}`),
            model: TRANSCRIBE_MODEL,
            response_format: 'json',
          },
          { timeout: 180_000 },
        ),
      { maxRetries: 2, label: TRANSCRIBE_LABEL },
    );
    text = (response as { text?: string }).text ?? '';
    const usage = (response as { usage?: { input_token_details?: { audio_tokens?: number } } }).usage;
    usageAudioTokens = usage?.input_token_details?.audio_tokens ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    integrationLog.warn(`doc:transcribe fail file=${input.filename} reason=${message.slice(0, 200)}`);
    throw new ExtractionError('audio_transcription_failed', 'transcription failed');
  }

  // Best available billed-seconds source: header probe (sliced value) →
  // API audio-token usage → byte-length worst case (each step warned).
  let billedSec = transcribedSec;
  let billedSecSource: 'probe' | 'api-usage' | 'bytes-estimate' = 'probe';
  if (billedSec === undefined && usageAudioTokens > 0) {
    billedSec = usageAudioTokens / AUDIO_TOKENS_PER_SECOND;
    billedSecSource = 'api-usage';
  }
  if (billedSec === undefined) {
    billedSec = (sendBuffer.length * 8) / FALLBACK_BITRATE_BPS;
    billedSecSource = 'bytes-estimate';
    warnings.push('audio: transcription billed from an estimated duration');
  }

  recordUsage({
    service: 'openai',
    action: TRANSCRIBE_LABEL,
    costMicroCents: priceFlatUnit({ sku: 'openai_transcribe_minute', units: billedSec / 60 }),
    metadata: {
      model: TRANSCRIBE_MODEL,
      seconds: Math.round(billedSec),
      secondsSource: billedSecSource,
      bytes: sendBuffer.length,
      mode: opts.mode,
    },
  });

  const markdown = normalizeExtractedText(text);
  if (!markdown) {
    warnings.push('audio: no speech detected');
  }

  integrationLog.info(
    `doc:transcribe ok file=${input.filename} durationSec=${probe.durationSec ?? '?'} transcribedSec=${Math.round(billedSec)}`,
  );

  return {
    markdown,
    blocks: markdown ? [{ type: 'text', markdown, headingPath: [] }] : [],
    audioDurationSec: probe.durationSec,
    transcribedSec: transcribedSec ?? billedSec,
    warnings,
  };
};
