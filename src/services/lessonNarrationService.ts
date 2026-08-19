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
import { ttsLog } from '@lib/loggers';

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

/**
 * Per-lesson TTS cooldown — bound on legitimate use is "user clicks
 * Generate, waits 60 s, clicks again with new voice". 60 s is enough
 * to short-circuit double-clicks and rapid voice toggling without
 * blocking deliberate iteration. Enforced in the controller before job
 * submission so cooldown denials are immediate 429s, not silent
 * job-failed states.
 */
export const TTS_COOLDOWN_MS = 60_000;

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

/**
 * Exported so the transcript endpoint can tell whether the audio a learner
 * is about to download still corresponds to the lesson text. Regenerating a
 * lesson replaces `blocks` and leaves every audio field untouched, so the
 * two can drift. Nothing else about this function changes — its output is
 * the S3 cache key and must stay byte-stable.
 */
export const buildContentHash = ({
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
  const coord = `${courseId}/${moduleIndex}/${lessonIndex}`;
  const startedAt = Date.now();
  ttsLog.info(`run:start lesson=${coord} incomingVoice=${voiceId ?? 'unset'} incomingRate=${rate ?? 'unset'}`);

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

  ttsLog.info(
    `resolve lesson=${coord} voice=${voice.id} rate=${resolvedRate} chars=${script.length} hash=${contentHash.slice(0, 12)}…`,
  );

  const exists = await objectExists({ key: s3Key });
  ttsLog.info(`cache:${exists ? 'hit' : 'miss'} lesson=${coord} key=${s3Key}`);

  if (!exists) {
    const { audio, billedCharacters } = await synthesizeNarration({
      script,
      voice,
      rate: resolvedRate,
    });
    await uploadBuffer({ key: s3Key, body: audio, contentType: 'audio/mpeg' });
    ttsLog.info(
      `synth:done lesson=${coord} bytes=${audio.length} billedChars=${billedCharacters}`,
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
  // doc reflects the latest synthesis attributes. `lastTtsSpendAt` is
  // bumped only on cache miss — it gates the per-lesson cooldown that
  // prevents accidental double-spend (see generateLessonNarrationController).
  const now = new Date();
  await LessonContentModel.updateOne(
    { courseId, moduleIndex, lessonIndex },
    {
      audioUrl: s3Key,
      audioVoice: voice.id,
      audioRate: resolvedRate,
      audioContentHash: contentHash,
      audioGeneratedAt: now,
      ...(exists ? {} : { lastTtsSpendAt: now }),
    },
  );
  ttsLog.info(
    `run:done lesson=${coord} voice=${voice.id} cached=${exists} key=${s3Key} ms=${Date.now() - startedAt}`,
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
      // Reset the cooldown stamp too — clearing narration is an explicit
      // operator action, not abuse, so the next synthesize attempt should
      // not be gated by a stale spend timestamp.
      lastTtsSpendAt: null,
    },
  );
  ttsLog.info(
    `clear lesson=${courseId}/${moduleIndex}/${lessonIndex} matched=${result.matchedCount} modified=${result.modifiedCount}`,
  );
};
