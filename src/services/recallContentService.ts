import { Types } from 'mongoose';
import RecallCardModel, { IRecallCard } from '@models/RecallCardModel';
import LessonContentModel from '@models/LessonContentModel';
import UserRecallProgressModel from '@models/UserRecallProgressModel';
import { RecallCardKind, normalizeConceptTag } from '@lib/recallConstants';
import { genLog } from '@lib/loggers';

// ── Types ──────────────────────────────────────────────────

/**
 * Raw recall card emitted by the LangGraph generator. Not yet validated or
 * associated with a persisted lesson.
 */
export interface GeneratedRecallCard {
  kind: RecallCardKind;
  prompt: string;
  answer: string;
  conceptTags: string[];
  sourceBlockId: string;
}

export interface PersistRecallCardsParams {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  cards: GeneratedRecallCard[];
}

// ── Dedup helpers ─────────────────────────────────────────

/**
 * Lexical-only dedup for MVP (no embedding call on the persistence path).
 * Semantic dedup across courses is deferred to Phase 2 per
 * insigts-research.md §6.4.
 */
const normalizeForDedup = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();

const dedupeWithinLesson = (cards: GeneratedRecallCard[]): GeneratedRecallCard[] => {
  const seen = new Set<string>();
  const unique: GeneratedRecallCard[] = [];
  for (const ins of cards) {
    const key = `${ins.kind}|${normalizeForDedup(ins.prompt)}|${normalizeForDedup(ins.answer)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ins);
  }
  return unique;
};

// ── Persist ──────────────────────────────────────────────

/**
 * Replace all recall cards for a given (course, module, lesson) coordinate with
 * the freshly generated set. Call this AFTER the LessonContent row exists.
 *
 * Strategy:
 *   1. Look up the LessonContent._id (required as FK).
 *   2. Delete existing recall cards tied to this lessonId.
 *   3. Insert the new set (dedup'd + validated).
 *   4. Orphaned UserRecallProgress rows (if any) become unreachable — they
 *      have no matching RecallCard. They're cleaned up lazily when the user's
 *      queue query filters against the recall card collection, and swept on a
 *      background job later (deferred).
 *
 * Returns the list of persisted recall card _ids.
 */
export const persistLessonRecallCards = async (params: PersistRecallCardsParams): Promise<string[]> => {
  const { courseId, moduleIndex, lessonIndex } = params;

  if (params.cards.length === 0) return [];

  const lesson = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex })
    .select('_id')
    .lean();

  if (!lesson) {
    genLog.warn(`lesson:recall persist-skip lesson=${courseId}/${moduleIndex}/${lessonIndex} reason=lesson_content_not_found`);
    return [];
  }

  const lessonId = lesson._id as Types.ObjectId;
  const courseObjId = new Types.ObjectId(courseId);

  const deduped = dedupeWithinLesson(params.cards)
    .map((i) => normalizeRecallCard(i))
    .filter((i) => i !== null) as GeneratedRecallCard[];

  if (deduped.length === 0) {
    // Still clear any stale recall cards for this lesson so we don't leave them
    // orphaned after a regeneration that produced zero valid items.
    await RecallCardModel.deleteMany({ lessonId });
    return [];
  }

  // Atomic replace: delete old, insert new.
  await RecallCardModel.deleteMany({ lessonId });

  const docs: Omit<IRecallCard, 'createdAt' | 'updatedAt'>[] = deduped.map((i) => ({
    courseId: courseObjId,
    lessonId,
    moduleIndex,
    lessonIndex,
    sourceBlockId: i.sourceBlockId,
    kind: i.kind,
    prompt: i.prompt,
    answer: i.answer,
    conceptTags: i.conceptTags,
    version: 1,
  }));

  const inserted = await RecallCardModel.insertMany(docs);
  genLog.info(`lesson:recall persist-ok count=${inserted.length} lesson=${courseId}/${moduleIndex}/${lessonIndex}`);

  return inserted.map((d) => (d._id as Types.ObjectId).toString());
};

/**
 * Best-effort normalization + validation. Returns null to filter out items
 * that are structurally invalid (e.g. empty text after trim, cloze without a
 * blank marker).
 */
const normalizeRecallCard = (raw: GeneratedRecallCard): GeneratedRecallCard | null => {
  const prompt = raw.prompt?.trim();
  const answer = raw.answer?.trim();
  if (!prompt || !answer) return null;

  if (raw.kind === 'cloze' && !/\{\{\s*blank\s*\}\}/i.test(prompt)) {
    // Cloze prompts must contain a {{blank}} marker.
    return null;
  }

  const tags = Array.from(
    new Set((raw.conceptTags ?? []).map(normalizeConceptTag).filter((t) => t.length > 0)),
  ).slice(0, 4);

  return {
    kind: raw.kind,
    prompt,
    answer,
    conceptTags: tags,
    sourceBlockId: raw.sourceBlockId,
  };
};

// ── Cleanup on course/lesson delete ──────────────────────

/**
 * Remove all recall cards (and progress rows) tied to a course. Call from
 * courseCleanupService when a course is deleted.
 */
export const deleteCourseRecallCards = async (courseId: string): Promise<void> => {
  const courseObjId = new Types.ObjectId(courseId);

  // 1. Gather recall card ids to cascade to UserRecallProgress.
  const cards = await RecallCardModel.find({ courseId: courseObjId }).select('_id').lean();
  const recallCardIds = cards.map((i) => i._id);

  if (recallCardIds.length === 0) return;

  await Promise.all([
    RecallCardModel.deleteMany({ courseId: courseObjId }),
    UserRecallProgressModel.deleteMany({ recallCardId: { $in: recallCardIds } }),
  ]);
};
