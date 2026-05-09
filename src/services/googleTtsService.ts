import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GOOGLE_TTS_PRIVATE_KEY } from '@conf/env';
import type { NarrationVoice } from '@lib/narration/voices';

// Non-secret service-account identifiers. The matching private_key lives in
// GOOGLE_TTS_PRIVATE_KEY env var. See conf/env.ts for the rationale.
const GOOGLE_TTS_CLIENT_EMAIL = 'strive-tts-runtime@strive-454313.iam.gserviceaccount.com';
const GOOGLE_TTS_PROJECT_ID = 'strive-454313';

/**
 * Wraps the Google Cloud Text-to-Speech client. Single-purpose: turn a
 * narration script into an MP3 buffer, chunked under Google's 5,000-byte
 * per-request limit.
 *
 * Why MP3 (not WAV/Ogg): smaller payloads, browser-native playback, S3
 * cost. We don't need waveform fidelity — narration is voice-only.
 */

// Google's hard limit on input bytes per synthesizeSpeech call. We give
// ourselves headroom for the SSML wrapper overhead and to avoid splitting
// a UTF-8 byte sequence in the middle of a multi-byte character.
const MAX_CHARS_PER_REQUEST = 4500;

let cachedClient: TextToSpeechClient | null = null;

const getClient = (): TextToSpeechClient => {
  if (cachedClient) return cachedClient;
  cachedClient = new TextToSpeechClient({
    projectId: GOOGLE_TTS_PROJECT_ID,
    credentials: {
      client_email: GOOGLE_TTS_CLIENT_EMAIL,
      private_key: GOOGLE_TTS_PRIVATE_KEY,
    },
  });
  return cachedClient;
};

/**
 * Split a long narration script into chunks below Google's per-request
 * limit, breaking on paragraph boundaries first, then sentence boundaries,
 * never mid-word. Lossless: re-joining chunks reproduces the original text
 * byte-for-byte (modulo the join strategy in `synthesizeNarration`, where
 * we accept tiny silence at boundaries as the cost of MP3 concatenation).
 */
export const splitForSynthesis = (script: string): string[] => {
  if (script.length <= MAX_CHARS_PER_REQUEST) return [script];

  const chunks: string[] = [];
  // Paragraph-first: lessons are paragraph-structured, so this almost
  // always lands every chunk on a clean break.
  const paragraphs = script.split(/\n{2,}/);
  let buffer = '';

  const flush = () => {
    if (buffer.length > 0) {
      chunks.push(buffer);
      buffer = '';
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    // Paragraph fits in the current buffer.
    if ((buffer.length + paragraph.length + 2) <= MAX_CHARS_PER_REQUEST) {
      buffer = buffer.length === 0 ? paragraph : `${buffer}\n\n${paragraph}`;
      continue;
    }
    // Paragraph doesn't fit. Flush what we have, then handle the paragraph
    // alone — which itself may exceed the limit (rare for lessons but we
    // shouldn't crash on it).
    flush();
    if (paragraph.length <= MAX_CHARS_PER_REQUEST) {
      buffer = paragraph;
      continue;
    }
    // Single paragraph > limit: fall back to sentence splitting. Match a
    // run ending with .!? followed by whitespace; the final run may have
    // no terminator (we already normalise that upstream but defending).
    const sentences = paragraph.match(/[^.!?]+[.!?]+|\S+/g) ?? [paragraph];
    for (const sentence of sentences) {
      if ((buffer.length + sentence.length + 1) <= MAX_CHARS_PER_REQUEST) {
        buffer = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
      } else {
        flush();
        // Sentences longer than the limit are extremely unlikely in lesson
        // text but if it happens we still emit the chunk — Google will
        // truncate or error and we'll surface that to the caller.
        buffer = sentence;
      }
    }
  }
  flush();
  return chunks;
};

export interface SynthesizeNarrationParams {
  script: string;
  voice: NarrationVoice;
  rate: number;
}

export interface SynthesizeNarrationResult {
  audio: Buffer;
  /** Number of characters billed by Google. Sum across chunks; matches
   * `script.length` modulo whitespace normalisation done in chunking. */
  billedCharacters: number;
}

/**
 * Synthesise an entire narration script into a single MP3 buffer.
 *
 * Concatenation strategy: we synthesise each chunk to MP3 with the same
 * encoder settings (default 24 kHz LAME) and concatenate the raw byte
 * streams. MP3 is a frame-stream format, so naive concat plays back
 * correctly in every modern browser at the cost of a tiny audible click
 * at chunk boundaries on some encoders. Acceptable for narration; if it
 * becomes a problem we can layer in a re-encode via ffmpeg.
 *
 * The Google client returns a Buffer-like ArrayBuffer/Uint8Array depending
 * on encoding; we normalise to Buffer for downstream `uploadBuffer()`.
 */
export const synthesizeNarration = async ({
  script,
  voice,
  rate,
}: SynthesizeNarrationParams): Promise<SynthesizeNarrationResult> => {
  const chunks = splitForSynthesis(script);
  const client = getClient();

  const audioBuffers: Buffer[] = [];
  let billedCharacters = 0;

  for (const chunk of chunks) {
    const [response] = await client.synthesizeSpeech({
      input: { text: chunk },
      voice: { languageCode: voice.locale, name: voice.id },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: rate,
      },
    });
    const content = response.audioContent;
    if (!content) {
      throw new Error('Google TTS returned an empty audio payload');
    }
    // The SDK returns Uint8Array (or string for some legacy paths).
    // Buffer.from handles both reliably.
    audioBuffers.push(Buffer.isBuffer(content) ? content : Buffer.from(content as Uint8Array));
    billedCharacters += chunk.length;
  }

  return {
    audio: Buffer.concat(audioBuffers),
    billedCharacters,
  };
};
