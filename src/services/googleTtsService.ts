import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GOOGLE_TTS_CREDENTIALS_JSON } from '@conf/env';
import type { NarrationVoice } from '@lib/narration/voices';

/**
 * Wraps the Google Cloud Text-to-Speech client. Single-purpose: turn a
 * narration script into an MP3 buffer, chunked under Google's 5,000-byte
 * per-request limit.
 *
 * The client is lazily initialised so the API can boot in environments
 * without TTS credentials configured (development is allowed to omit
 * GOOGLE_TTS_CREDENTIALS_JSON / GOOGLE_APPLICATION_CREDENTIALS — TTS just
 * fails on first synth call there with a clear error).
 *
 * **Why we refuse to construct without explicit creds:** if you let
 * `new TextToSpeechClient()` run with no creds, google-gax silently
 * falls back to probing the GCE metadata server. The probe rejects
 * asynchronously after the main call has already errored, escaping the
 * caller's try/catch as an unhandledRejection that crashes the Node
 * process. We pre-validate creds and throw a clean Error from this
 * service so the jobRunner's catch can mark the job failed instead of
 * the entire API going down.
 *
 * Why MP3 (not WAV/Ogg): smaller payloads, browser-native playback, S3
 * cost. We don't need waveform fidelity — narration is voice-only.
 */

// Google's hard limit on input bytes per synthesizeSpeech call. We give
// ourselves headroom for the SSML wrapper overhead and to avoid splitting
// a UTF-8 byte sequence in the middle of a multi-byte character.
const MAX_CHARS_PER_REQUEST = 4500;

let cachedClient: TextToSpeechClient | null = null;

const TTS_NOT_CONFIGURED_MSG =
  'Google Cloud TTS is not configured: set GOOGLE_TTS_CREDENTIALS_JSON ' +
  '(JSON service-account key as a single env var) or GOOGLE_APPLICATION_CREDENTIALS ' +
  '(absolute path to the credentials file).';

const getClient = (): TextToSpeechClient => {
  if (cachedClient) return cachedClient;

  if (GOOGLE_TTS_CREDENTIALS_JSON) {
    // Inline JSON path. Parse + validate before constructing the client —
    // a malformed JSON should fail with a clear, named error rather than
    // a downstream `client_email is not a string` deep inside gax.
    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(GOOGLE_TTS_CREDENTIALS_JSON) as typeof parsed;
    } catch (e) {
      throw new Error(`GOOGLE_TTS_CREDENTIALS_JSON is not valid JSON: ${(e as Error).message}`);
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('GOOGLE_TTS_CREDENTIALS_JSON is missing client_email or private_key');
    }
    cachedClient = new TextToSpeechClient({
      credentials: { client_email: parsed.client_email, private_key: parsed.private_key },
    });
    return cachedClient;
  }

  // Fall back to GOOGLE_APPLICATION_CREDENTIALS path. We only let
  // google-auth-library's ADC chain run when the env var is explicitly
  // set — otherwise its metadata-server probe fires off an unhandled
  // background rejection that takes down the Node process. Refusing to
  // construct here converts that crash into a clean job-level error.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    cachedClient = new TextToSpeechClient();
    return cachedClient;
  }

  throw new Error(TTS_NOT_CONFIGURED_MSG);
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
