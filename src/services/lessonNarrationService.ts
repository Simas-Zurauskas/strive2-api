import { createHash } from 'node:crypto';
import LessonContentModel from '@models/LessonContentModel';
import { blocksToNarrationScript, hasNarratableContent } from '@lib/narration/blocksToScript';
import {
  resolveNarrationVoice,
  clampNarrationRate,
} from '@lib/narration/voices';
import { objectExists, uploadBuffer } from './s3Service';
import { synthesizeNarration } from './googleTtsService';
import { recordUsage } from './usageService';
import { priceTtsUsage } from '@lib/pricing';

/**
 * Lesson narration orchestrator. Public entry point used by the job
 * runner. End-to-end:
 *
 *   1. Load lesson content; bail if no narratable text exists.
 *   2. Render blocks → deterministic plain-text script.
 *   3. Hash (script + voice + rate + provider) → stable S3 key.
 *   4. If S3 already has the object: persist the key, exit. No vendor call,
 *      no usage row — content-addressed cache hit, exactly like hero images.
 *   5. Else: call Google TTS, upload the buffer, persist the key, record
 *      vendor usage. The usage row carries `service: 'tts'`, which causes
 *      `applyStaticMarkup` to double the cost on the user-charged ledger
 *      side automatically.
 *
 * Why we hash into a shared `lessons/audio/{hash}.mp3` namespace rather
 * than a per-course path: identical scripts read in the same voice across
 * different courses (templated lessons, shared topics) reuse the same
 * file. It also means course deletion's `deleteByPrefix(lessons/{id}/)`
 * doesn't touch our cached audio — if course A's lesson and course B's
 * lesson resolve to the same hash, deleting A would otherwise yank
 * audio out from under B. Trade-off: orphaned audio accumulates slowly;
 * a future S3-lifecycle rule can sweep objects with no DB references.
 */

const PROVIDER_TAG = 'google-wavenet-v1';

export interface RunLessonNarrationParams {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  /** User-supplied voice id (may be empty / unknown — resolved here). */
  voiceId: string | null | undefined;
  /** User-supplied playback rate (clamped here). */
  rate: number | null | undefined;
}

export interface RunLessonNarrationResult {
  s3Key: string;
  cached: boolean;
  characters: number;
  voiceId: string;
  rate: number;
}

const buildContentHash = ({
  script,
  voiceId,
  rate,
}: {
  script: string;
  voiceId: string;
  rate: number;
}): string => {
  const hasher = createHash('sha256');
  hasher.update(PROVIDER_TAG);
  hasher.update('|');
  hasher.update(voiceId);
  hasher.update('|');
  // Quantise rate to 2 dp before hashing so 1.0 and 1.000000001 don't
  // produce different cache slots.
  hasher.update(rate.toFixed(2));
  hasher.update('|');
  hasher.update(script);
  return hasher.digest('hex');
};

const buildAudioS3Key = (hash: string): string => `lessons/audio/${hash}.mp3`;

export const runLessonNarration = async ({
  courseId,
  moduleIndex,
  lessonIndex,
  voiceId,
  rate,
}: RunLessonNarrationParams): Promise<RunLessonNarrationResult> => {
  const tag = `[narration ${courseId}/${moduleIndex}/${lessonIndex}]`;
  console.log(
    `${tag} run start — incomingVoiceId=${voiceId ?? 'unset'} incomingRate=${rate ?? 'unset'}`.cyan,
  );

  const lesson = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
  if (!lesson) {
    throw new Error(`Lesson content not found for ${courseId}/${moduleIndex}/${lessonIndex}`);
  }
  if (!hasNarratableContent(lesson.blocks)) {
    throw new Error('Lesson has no narratable content (only quizzes / images / code blocks)');
  }

  const voice = resolveNarrationVoice(voiceId);
  const resolvedRate = clampNarrationRate(rate);
  const script = blocksToNarrationScript(lesson.blocks);
  const contentHash = buildContentHash({ script, voiceId: voice.id, rate: resolvedRate });
  const s3Key = buildAudioS3Key(contentHash);

  console.log(
    `${tag} resolved → voice=${voice.id} rate=${resolvedRate} ` +
    `scriptChars=${script.length} hash=${contentHash.slice(0, 12)}…`.cyan,
  );

  const exists = await objectExists({ key: s3Key });
  console.log(
    `${tag} cache=${exists ? 'HIT' : 'MISS'} key=${s3Key}`.cyan,
  );

  if (!exists) {
    const { audio, billedCharacters } = await synthesizeNarration({
      script,
      voice,
      rate: resolvedRate,
    });
    await uploadBuffer({ key: s3Key, body: audio, contentType: 'audio/mpeg' });
    console.log(
      `${tag} synthesised + uploaded — bytes=${audio.length} billedChars=${billedCharacters}`.cyan,
    );

    // Record vendor cost. `applyStaticMarkup` doubles this on the user
    // ledger via the 'tts' entry in STATIC_MARKUP_SERVICES — no extra
    // wiring needed here. `recordUsage` is a no-op outside a usage
    // context, which means tests and ad-hoc scripts run free; in the
    // jobRunner path the context is always populated.
    const costMicroCents = priceTtsUsage({
      sku: voice.sku,
      characters: billedCharacters,
    });
    recordUsage({
      service: 'tts',
      action: 'lesson:narration',
      costMicroCents,
      metadata: {
        voice: voice.id,
        characters: billedCharacters,
        rate: resolvedRate,
        contentHash,
      },
    });
  }

  // Persist the audio metadata regardless of cache hit/miss so the lesson
  // doc reflects the latest synthesis attributes.
  await LessonContentModel.updateOne(
    { courseId, moduleIndex, lessonIndex },
    {
      audioUrl: s3Key,
      audioVoice: voice.id,
      audioRate: resolvedRate,
      audioContentHash: contentHash,
      audioGeneratedAt: new Date(),
    },
  );
  console.log(
    `${tag} done — voice=${voice.id} cached=${exists} key=${s3Key}`.green,
  );

  return {
    s3Key,
    cached: exists,
    characters: script.length,
    voiceId: voice.id,
    rate: resolvedRate,
  };
};

/**
 * Clear narration metadata on a lesson. Doesn't touch S3 — the audio
 * blob lives at a content-hashed key and may be referenced by other
 * lessons via cache hit. Orphaned objects are reaped by the future
 * S3-lifecycle rule, not synchronously here.
 */
export const clearLessonNarration = async ({
  courseId,
  moduleIndex,
  lessonIndex,
}: {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
}): Promise<void> => {
  const result = await LessonContentModel.updateOne(
    { courseId, moduleIndex, lessonIndex },
    {
      audioUrl: null,
      audioVoice: null,
      audioRate: null,
      audioContentHash: null,
      audioGeneratedAt: null,
    },
  );
  console.log(
    `[narration ${courseId}/${moduleIndex}/${lessonIndex}] cleared — ` +
    `matched=${result.matchedCount} modified=${result.modifiedCount}`.cyan,
  );
};
