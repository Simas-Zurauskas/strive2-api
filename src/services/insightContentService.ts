import { Types } from 'mongoose';
import InsightModel, { IInsight } from '@models/InsightModel';
import LessonContentModel from '@models/LessonContentModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import { InsightKind, normalizeConceptTag } from '@lib/insightConstants';

// ── Types ──────────────────────────────────────────────────

/**
 * Raw insight emitted by the LangGraph generator. Not yet validated or
 * associated with a persisted lesson.
 */
export interface GeneratedInsight {
  kind: InsightKind;
  prompt: string;
  answer: string;
  conceptTags: string[];
  sourceBlockId: string;
}

export interface PersistInsightsParams {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  insights: GeneratedInsight[];
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

const dedupeWithinLesson = (insights: GeneratedInsight[]): GeneratedInsight[] => {
  const seen = new Set<string>();
  const unique: GeneratedInsight[] = [];
  for (const ins of insights) {
    const key = `${ins.kind}|${normalizeForDedup(ins.prompt)}|${normalizeForDedup(ins.answer)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ins);
  }
  return unique;
};

// ── Persist ──────────────────────────────────────────────

/**
 * Replace all insights for a given (course, module, lesson) coordinate with
 * the freshly generated set. Call this AFTER the LessonContent row exists.
 *
 * Strategy:
 *   1. Look up the LessonContent._id (required as FK).
 *   2. Delete existing insights tied to this lessonId.
 *   3. Insert the new set (dedup'd + validated).
 *   4. Orphaned UserInsightProgress rows (if any) become unreachable — they
 *      have no matching Insight. They're cleaned up lazily when the user's
 *      queue query filters against the insight collection, and swept on a
 *      background job later (deferred).
 *
 * Returns the list of persisted insight _ids.
 */
export const persistLessonInsights = async (params: PersistInsightsParams): Promise<string[]> => {
  const { courseId, moduleIndex, lessonIndex } = params;

  if (params.insights.length === 0) return [];

  const lesson = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex })
    .select('_id')
    .lean();

  if (!lesson) {
    console.warn(`[insightContent] ✗ LessonContent not found for ${courseId}/${moduleIndex}/${lessonIndex} — skipping insight persistence`.yellow);
    return [];
  }

  const lessonId = lesson._id as Types.ObjectId;
  const courseObjId = new Types.ObjectId(courseId);

  const deduped = dedupeWithinLesson(params.insights)
    .map((i) => normalizeInsight(i))
    .filter((i) => i !== null) as GeneratedInsight[];

  if (deduped.length === 0) {
    // Still clear any stale insights for this lesson so we don't leave them
    // orphaned after a regeneration that produced zero valid items.
    await InsightModel.deleteMany({ lessonId });
    return [];
  }

  // Atomic replace: delete old, insert new.
  await InsightModel.deleteMany({ lessonId });

  const docs: Omit<IInsight, 'createdAt' | 'updatedAt'>[] = deduped.map((i) => ({
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

  const inserted = await InsightModel.insertMany(docs);
  console.log(`[insightContent] ✓ Persisted ${inserted.length} insights for lesson ${courseId}/${moduleIndex}/${lessonIndex}`.green);

  return inserted.map((d) => (d._id as Types.ObjectId).toString());
};

/**
 * Best-effort normalization + validation. Returns null to filter out items
 * that are structurally invalid (e.g. empty text after trim, cloze without a
 * blank marker).
 */
const normalizeInsight = (raw: GeneratedInsight): GeneratedInsight | null => {
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
 * Remove all insights (and progress rows) tied to a course. Call from
 * courseCleanupService when a course is deleted.
 */
export const deleteCourseInsights = async (courseId: string): Promise<void> => {
  const courseObjId = new Types.ObjectId(courseId);

  // 1. Gather insight ids to cascade to UserInsightProgress.
  const insights = await InsightModel.find({ courseId: courseObjId }).select('_id').lean();
  const insightIds = insights.map((i) => i._id);

  if (insightIds.length === 0) return;

  await Promise.all([
    InsightModel.deleteMany({ courseId: courseObjId }),
    UserInsightProgressModel.deleteMany({ insightId: { $in: insightIds } }),
  ]);
};
