/**
 * The fetch half of a PDF export.
 *
 * The document builders in `lib/pdf/documents.ts` are deliberately free of
 * I/O, so everything they need is gathered here: lesson rows, hero bytes,
 * the structure that names modules and lessons, and who the export is for.
 */

import moment from 'moment-timezone';
import LessonContentModel from '@models/LessonContentModel';
import UserModel from '@models/UserModel';
import { heroJpeg } from '@lib/pdf/heroImage';
import type { CourseModuleForPdf, LessonForPdf } from '@lib/pdf/documents';

interface CourseStructure {
  modules?: { name?: string; lessons?: { name?: string }[] }[];
}

/** Module and lesson names, flattened with their coordinates. */
export const modulesFromStructure = (structure: unknown): CourseModuleForPdf[] => {
  const s = (structure ?? {}) as CourseStructure;
  return (s.modules ?? []).map((m, moduleIndex) => ({
    name: m.name ?? `Module ${moduleIndex + 1}`,
    lessons: (m.lessons ?? []).map((l, lessonIndex) => ({
      name: l.name ?? `Lesson ${lessonIndex + 1}`,
      moduleIndex,
      lessonIndex,
    })),
  }));
};

const nameAt = (
  modules: CourseModuleForPdf[],
  moduleIndex: number,
  lessonIndex: number,
): { moduleName: string; lessonName: string } => {
  const mod = modules[moduleIndex];
  const lesson = mod?.lessons[lessonIndex];
  return {
    moduleName: mod?.name ?? `Module ${moduleIndex + 1}`,
    lessonName: lesson?.name ?? `Lesson ${lessonIndex + 1}`,
  };
};

/**
 * "Generated for Ada Lovelace · 19 August 2026" for the cover.
 *
 * Deliberately name-or-nothing. `User.name` is optional
 * (`models/UserModel.ts:159`), and the obvious fallback — the account email —
 * would stamp a personal identifier onto a document the learner may print,
 * email or hand to someone else. A generic phrase is the safer default; the
 * cover is branding, not a receipt.
 */
export const exportAttribution = async (userId: string): Promise<{ generatedFor: string; generatedOn: string }> => {
  const user = await UserModel.findById(userId).select('name').lean<{ name?: string }>();
  return {
    generatedFor: user?.name?.trim() || 'a Strive learner',
    generatedOn: moment.utc().format('D MMMM YYYY'),
  };
};

/** Coordinates of the lesson a generation job is currently writing, if any. */
export interface ActiveLesson {
  moduleIndex: number;
  lessonIndex: number;
}

const isBeingGenerated = (
  active: ActiveLesson | null | undefined,
  moduleIndex: number,
  lessonIndex: number,
): boolean => !!active && active.moduleIndex === moduleIndex && active.lessonIndex === lessonIndex;

/**
 * Load one lesson for export.
 *
 * Returns null unless the lesson is finished, which takes TWO checks, not
 * one.
 *
 * `completed` covers a first generation: `jobRunner` upserts a partial row
 * every 500 ms without setting it (`services/jobRunner.ts:416-430`), so the
 * schema default `false` holds until the final write (`:579-595`).
 *
 * It does NOT cover a RE-generation. Nothing clears `completed` when a job
 * starts, so re-running an already-generated lesson leaves the row reading
 * `completed: true` while its `blocks` are being rewritten — and exporting
 * then yields a truncated lesson with no error. Fixing that at the source
 * would mean writing to `jobRunner`, which this task treats as read-only,
 * so the export uses the signal the Course row already carries:
 * `activeLesson` is stamped atomically with the job claim
 * (`services/jobRunner.ts:193`, `:207`) and cleared when the job ends.
 */
export const loadLessonForPdf = async ({
  courseId,
  moduleIndex,
  lessonIndex,
  modules,
  activeLesson,
}: {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  modules: CourseModuleForPdf[];
  activeLesson?: ActiveLesson | null;
}): Promise<LessonForPdf | null> => {
  if (isBeingGenerated(activeLesson, moduleIndex, lessonIndex)) return null;

  const row = await LessonContentModel.findOne({ courseId, moduleIndex, lessonIndex });
  if (!row || row.completed !== true) return null;

  const hero = await heroJpeg(row.heroImageUrl);
  return {
    moduleIndex,
    lessonIndex,
    ...nameAt(modules, moduleIndex, lessonIndex),
    blocks: row.blocks,
    heroDataUri: hero?.dataUri ?? null,
    completed: true,
  };
};

export interface LoadedCourseLessons {
  lessons: LessonForPdf[];
  heroHits: number;
  heroMisses: number;
}

/** Every completed lesson in a course, in structure order. */
export const loadCourseLessonsForPdf = async ({
  courseId,
  modules,
  activeLesson,
}: {
  courseId: string;
  modules: CourseModuleForPdf[];
  activeLesson?: ActiveLesson | null;
}): Promise<LoadedCourseLessons> => {
  const rows = await LessonContentModel.find({ courseId, completed: true }).sort({
    moduleIndex: 1,
    lessonIndex: 1,
  });

  const lessons: LessonForPdf[] = [];
  let heroHits = 0;
  let heroMisses = 0;

  for (const row of rows) {
    // Mid-regeneration: `completed` is still true from the previous run
    // while the blocks are being rewritten. Leave it out rather than ship
    // half a lesson; it appears in the "not yet generated" list instead.
    if (isBeingGenerated(activeLesson, row.moduleIndex, row.lessonIndex)) continue;

    const hero = await heroJpeg(row.heroImageUrl);
    if (hero) (hero.cached ? heroHits++ : heroMisses++);
    lessons.push({
      moduleIndex: row.moduleIndex,
      lessonIndex: row.lessonIndex,
      ...nameAt(modules, row.moduleIndex, row.lessonIndex),
      blocks: row.blocks,
      heroDataUri: hero?.dataUri ?? null,
      completed: true,
    });
  }

  return { lessons, heroHits, heroMisses };
};
