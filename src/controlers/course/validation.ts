import { z } from 'zod';
import { CHAT_ROLES, COURSE_DEPTHS, COURSE_STATUSES, LESSON_PROGRESS_STATUSES } from '@lib/constants';
import LessonContentModel from '@models/LessonContentModel';

export const createCourseSchema = z.object({
  goal: z.string().min(1, 'Goal is required').max(500, 'Goal must be at most 500 characters'),
});

export const updateCourseSchema = z.object({
  goal: z.string().min(1).max(500).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  depth: z.enum(COURSE_DEPTHS).optional(),
  status: z.enum(COURSE_STATUSES).optional(),
});

export const chatStreamSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(CHAT_ROLES),
        content: z.string().min(1).max(20000),
      }),
    )
    .min(1),
});

export const refineStructureSchema = z.object({
  feedback: z.string().min(1, 'Feedback is required').max(1000, 'Feedback must be at most 1000 characters'),
});

export const generateLessonSchema = z.object({
  moduleIndex: z.number().int().min(0, 'moduleIndex must be a non-negative integer'),
  lessonIndex: z.number().int().min(0, 'lessonIndex must be a non-negative integer'),
  includeImage: z.boolean().optional().default(true),
  includeLinks: z.boolean().optional().default(true),
});

export const upsertProgressSchema = z.object({
  status: z.enum(LESSON_PROGRESS_STATUSES).optional(),
  notes: z.string().max(10000).nullable().optional(),
  bookmarked: z.boolean().optional(),
  timeSpentDelta: z.number().int().min(0).max(3600).optional(),
  quizResponse: z
    .object({
      blockId: z.string(),
      selectedOption: z.number().int().min(0),
      correct: z.boolean(),
    })
    .optional(),
  exerciseAttempt: z
    .object({
      blockId: z.string(),
      code: z.string().max(200000),
      passed: z.boolean(),
    })
    .optional(),
});

export const submitQuizAttemptSchema = z.object({
  responses: z
    .array(
      z.object({
        questionId: z.string(),
        selectedOption: z.number().int().min(0).max(3),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * Parses a route param as a non-negative integer. Throws 400 if invalid.
 */
export const parseIndexParam = (value: string | string[] | undefined, name: string): number => {
  if (Array.isArray(value)) value = value[0];
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw Object.assign(new Error(`Invalid ${name}: must be a non-negative integer`), { statusCode: 400 });
  }
  return num;
};

/**
 * Ensures the previous lesson in the course has been generated before allowing
 * generation of the current one. Enforces sequential lesson generation order.
 * The very first lesson (module 0, lesson 0) is always allowed.
 */
export const assertPreviousLessonGenerated = async (
  courseId: string,
  moduleIndex: number,
  lessonIndex: number,
  structure: { modules: { lessons: unknown[] }[] },
): Promise<void> => {
  // First lesson in the course — always allowed
  if (moduleIndex === 0 && lessonIndex === 0) return;

  // Compute previous lesson coordinates
  let prevModule: number;
  let prevLesson: number;

  if (lessonIndex > 0) {
    prevModule = moduleIndex;
    prevLesson = lessonIndex - 1;
  } else {
    // First lesson of this module → previous is last lesson of prior module
    prevModule = moduleIndex - 1;
    prevLesson = structure.modules[prevModule].lessons.length - 1;
  }

  const exists = await LessonContentModel.findOne(
    { courseId, moduleIndex: prevModule, lessonIndex: prevLesson },
  ).select('_id').lean();

  if (!exists) {
    throw Object.assign(
      new Error(`Generate the previous lesson first (module ${prevModule + 1}, lesson ${prevLesson + 1})`),
      { statusCode: 400 },
    );
  }
};
