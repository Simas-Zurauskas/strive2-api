import { TtsSku } from '@lib/pricing';

/**
 * Curated catalog of TTS voices we expose to users.
 *
 * Why a hand-picked subset rather than Google's full ~200-voice list:
 *   - Choice paralysis. Users picking from 6 well-described voices ship
 *     more often than users scrolling 200 codes.
 *   - Stable hashes. Including a voice in the catalog implicitly promises
 *     it will keep producing identical audio for the same script. If
 *     Google deprecates a voice we control rotation here.
 *   - Pricing tier. Every entry is mapped to a `TtsSku` so the cost path
 *     is unambiguous — no risk of shipping a Studio-tier voice priced at
 *     30× the rate the user expected.
 *
 * To add a voice:
 *   1. Pick the Google id from https://cloud.google.com/text-to-speech/docs/voices
 *   2. Confirm its tier (Standard / WaveNet / Neural2 / Studio / Chirp3-HD)
 *   3. Add an entry below with the matching `sku` so cost lookups map cleanly.
 *   4. Mention the voice's character (warm / energetic / authoritative) so
 *      the picker UI can show something more useful than the raw id.
 */

export interface NarrationVoice {
  /** Google Cloud TTS voice id (e.g. "en-US-Wavenet-F"). */
  id: string;
  /** Display label shown in the picker. */
  label: string;
  /** ISO BCP-47 locale; passed through to the TTS request as `languageCode`. */
  locale: string;
  /** Reported gender — kept loose so we don't promise more than vendor metadata. */
  gender: 'male' | 'female' | 'neutral';
  /** Pricing SKU resolved by `priceTtsUsage`. */
  sku: TtsSku;
  /** One-line characterisation so users can pick by feel. */
  description: string;
}

export const NARRATION_VOICES: readonly NarrationVoice[] = [
  {
    id: 'en-US-Wavenet-F',
    label: 'Nova (US, female)',
    locale: 'en-US',
    gender: 'female',
    sku: 'google_wavenet',
    description: 'Warm, conversational. Good default for tutorials.',
  },
  {
    id: 'en-US-Wavenet-D',
    label: 'Atlas (US, male)',
    locale: 'en-US',
    gender: 'male',
    sku: 'google_wavenet',
    description: 'Steady and clear; reads long passages without strain.',
  },
  {
    id: 'en-US-Wavenet-C',
    label: 'Iris (US, female)',
    locale: 'en-US',
    gender: 'female',
    sku: 'google_wavenet',
    description: 'Bright and energetic — pairs well with fast-paced content.',
  },
  {
    id: 'en-US-Wavenet-A',
    label: 'Orion (US, male)',
    locale: 'en-US',
    gender: 'male',
    sku: 'google_wavenet',
    description: 'Deeper register; lecture-style delivery.',
  },
  {
    id: 'en-GB-Wavenet-C',
    label: 'Saoirse (UK, female)',
    locale: 'en-GB',
    gender: 'female',
    sku: 'google_wavenet',
    description: 'British English; precise diction.',
  },
  {
    id: 'en-GB-Wavenet-B',
    label: 'Callum (UK, male)',
    locale: 'en-GB',
    gender: 'male',
    sku: 'google_wavenet',
    description: 'British English; calm, measured pace.',
  },
];

/** First entry doubles as the system default when a user has no preference. */
export const DEFAULT_NARRATION_VOICE_ID = NARRATION_VOICES[0].id;

const VOICES_BY_ID = new Map(NARRATION_VOICES.map((v) => [v.id, v] as const));

/**
 * Resolve a (possibly user-supplied or empty) voice id to a real catalog
 * entry. Falls back to the default rather than throwing so a stale client
 * payload never blocks playback. Server-side validation of "is this voice
 * id known?" still happens at the controller boundary; this helper is the
 * synthesis-time safety net.
 */
export const resolveNarrationVoice = (voiceId: string | null | undefined): NarrationVoice => {
  if (voiceId) {
    const found = VOICES_BY_ID.get(voiceId);
    if (found) return found;
  }
  return VOICES_BY_ID.get(DEFAULT_NARRATION_VOICE_ID)!;
};

export const isKnownNarrationVoice = (voiceId: string): boolean => VOICES_BY_ID.has(voiceId);

/** Inclusive, server-enforced bounds for the `speakingRate` query param. */
export const NARRATION_RATE_MIN = 0.5;
export const NARRATION_RATE_MAX = 2.0;
export const DEFAULT_NARRATION_RATE = 1.0;

export const clampNarrationRate = (rate: number | null | undefined): number => {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return DEFAULT_NARRATION_RATE;
  return Math.min(NARRATION_RATE_MAX, Math.max(NARRATION_RATE_MIN, rate));
};
