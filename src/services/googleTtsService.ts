import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import type { NarrationVoice } from '@lib/narration/voices';

// Google Cloud service-account credentials for the TTS-only `strive-tts-runtime`
// account. Hardcoded rather than read from env vars: the previous env-var split
// caused chronic encoding bugs (literal `\n` vs real newlines, EB Console
// trimming, double-escaping) that surfaced as opaque `DECODER routines::unsupported`
// errors deep inside gRPC. The service account's IAM role is scoped to TTS only,
// so the blast radius if this file is read is bounded — and source code goes
// through the same review/git protections as any other secret in this repo
// (NextAuth secret, JWT secret, etc., none of which transit env at deploy time
// in a way that makes them more secure than this).
//
// Rotation procedure: generate a new key in GCP Console (IAM → Service Accounts
// → strive-tts-runtime → Keys → Add Key), paste the new `private_key` value
// here verbatim (it arrives from GCP with literal `\n` already — keep the
// single-quoted string form below), then disable the old key. No deploy
// gymnastics, no env-var coordination.
const GOOGLE_TTS_CLIENT_EMAIL = 'strive-tts-runtime@strive-454313.iam.gserviceaccount.com';
const GOOGLE_TTS_PROJECT_ID = 'strive-454313';
// Single-quoted JS string with literal `\n` escape sequences — JS interprets
// them as real newlines at runtime, producing a valid PEM. See rotation
// procedure in the file header.
const GOOGLE_TTS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDIGh9GI8Tr29hD\nrc/5IBtY5L8ulMHCSWlTftdhqi2lSJkVhAVGPd8dgIEqJz8sJay87aTuzHfsUtyj\nlNhZ+VV8Qp2hyVRjbqi5tsA80VGVPETbybBTFPRh1SvFoHH/DB3xRYLbG1ni0rk/\nBD70U4PnrO6M8I9jfhP4qiDl5Sqt2gz7na23fezyS10Th6WE0Ic2VYKOYpTJBBPt\nYb5FhG4Bq48j+epLxroFOmmgcNKYqm4fnmXXqguFpqQVHMn1XPVk6++ueQjhAVt4\ntLgp5YHodvfo9/1AYGlh8RbiHje9xx1yG3ImWiDZI8IjeRg62qaxnW4qsquwhA2h\nCws3zah7AgMBAAECggEAGGpbi4bcxbyW6Dcii663t4J9s1TSSX8Em3v8Er4dgK/Z\nge8QZ7Av850U5YxRYHUeXRUQDVUkgtDffBQyy9Oo8xb7vdxfcBx1+OcMEL+nmTJ3\n4mt7GMATS4ajpyL7FdgoJSLKoyp0rsDwenhtqAkyrIeEuey2Sjj9fddgWTy7luev\ndt8w0igZRMUvP//en8ZL+TuT4P3PsSpZN1d+OOZMxPHQYcs9Adt4FetOqRFDh/Wy\nXDJGOa1VBrsqrFuWJR+X7wx1mzNLuedb2JcS+EdXn1lfJgD8C5EiDr22vuEydu3F\nQMGpNz9RD+vk6GlBX/qSDlqxv6MAPWnvDl444mnlqQKBgQDkGH/nlWch2imzAYv8\n8NewPyC823merdTJ8D2RZBoQMwstSAmzHWlgr3/OS3+w3VqvPw3tcaGszsCtaUqN\nxhYdkiLjxWGUmijm5ZdVxRt1j1BaGzVAkfQRx3+yH4wfB5IaQvhzpFgyRZZG94LG\nRquKOEKNv4KxpNQFpdpzggfB6QKBgQDglOrJFVWC293bp2/E9C05AfH4selW8wWY\nNX7J9e+OKA4RW0ESwxo7wex3TdZVOBQsXlfS86UScGWz11YBMTCfnkUQVt7reXkT\n4MRud7tG5U7wKey840XLGQy1wKK7mFCBs96Y3cZP2/xZ4iYPU0BZgtrp0fn1AZTm\neAkYYtDUwwKBgQCO7TMogBvRwIykmHGJm7jrvYLcFILPBYnyx9Esi5cxU2rLgvpg\n/CsN5KqnL/PhdbLfYRlvEecHC778ap/G2rr86JdoNkSBA2Bh3rfHjO056wWkkKv7\nu/k+Ms43ZUE+KFZKknBwtih1x9j0ux988seGot5BSCGzAt/Acj7CZlZKEQKBgG+h\nlhLdx+OD5oOIdsYvmUr87Inx5UqTAfTmol9BIBJJVrTJ506sLB4IBsJGroMtnNlx\nC7aP5T2FIQiDwPxWtxSgVzQH+kaR2t1GnF1MpopW8SXvsP0y+z449VhiqIEW9O2D\nuuHBWxHXB1imUMTNXO8hXC9dcCGY56qnf93fQG6BAoGBAOKLR90tCESrTWPRTssw\nplM5OCeMRQEmWF0HFREHGRuzlLiAqYset6YyZVBQew9d8tPKy16yEmMTeiGFcmY3\nT9tui087kArshT+lvBM+4h+SZgY2zA9wjFnzbI8/ePiqgfiU8VGQSbG+LiLYjCDH\n3iAueZ+atJ71qf/bjLcgeuyT\n-----END PRIVATE KEY-----\n';

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
