import { z } from 'zod';
import { CHAT_ROLES, COURSE_DEPTHS, COURSE_STATUSES, GOAL_TYPES, LESSON_PROGRESS_STATUSES } from '@lib/constants';
import LessonContentModel from '@models/LessonContentModel';

export const createCourseSchema = z.object({
  goal: z.string().min(1, 'Goal is required').max(500, 'Goal must be at most 500 characters'),
});

// Each clarify answer is either a single text response (free-text fields)
// or a small set of multiple-choice selections (chip-pickers). Bound both
// shapes tightly so a malicious client can't persist arbitrary nested JSON
// that later flows back into LLM prompts (self-amplification of prompt
// injection) or that could carry Mongo-operator keys (`$gt`, `$ne`) in
// later lookups.
const answerValueSchema = z.union([
  z.string().max(2000),
  z.array(z.string().max(500)).max(20),
]);

export const updateCourseSchema = z.object({
  goal: z.string().min(1).max(500).optional(),
  // Question-id keys are arbitrary strings (the clarify agent invents them
  // per question), but we cap key length so abusive payloads can't blow up
  // the document. The .superRefine() below additionally rejects any key
  // starting with `$` (Mongo operator) or `__` (prototype escape) — they
  // have no place in a learner's answer payload.
  answers: z
    .record(z.string().max(120), answerValueSchema)
    .superRefine((rec, ctx) => {
      for (const key of Object.keys(rec)) {
        if (key.startsWith('$') || key.startsWith('__')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid answer key: ${key}`,
            path: [key],
          });
        }
      }
    })
    .optional(),
  depth: z.enum(COURSE_DEPTHS).optional(),
  status: z.enum(COURSE_STATUSES).optional(),
  /**
   * User-selected goalType from the Purpose step. Setting this field marks
   * the value as user-confirmed (`goalTypeConfidence = 'high'`), which
   * causes the next clarify job to skip the auto-classifier and use this
   * value verbatim. The cascade — clearing clarifyData and triggering a
   * clarify regen — is orchestrated by the client in `useWizardHandlers`,
   * mirroring the goal-text overwrite path.
   */
  goalType: z.enum(GOAL_TYPES).optional(),
  /**
   * Stamp written by the Purpose step on Next. Accepts the literal string
   * `'now'` (server stamps `new Date()`) or `null` (clears the stamp,
   * forcing the resume logic to land back on Purpose). Used by
   * `determineStepFromCourse` on the client to distinguish "purpose
   * unconfirmed" from "purpose confirmed, on questions step" — a signal
   * `goalTypeConfidence` cannot provide because the AI classifier itself
   * can output `'high'`.
   */
  goalTypeConfirmedAt: z.union([z.literal('now'), z.null()]).optional(),
  /**
   * Client-side acknowledgement that the learner saw the "your answers
   * suggest a lighter-effort course" warning and still wants the deeper
   * tier. Enforced in updateCourseController — when a soft learner (per
   * detectSoftnessHint) tries to upgrade depth beyond the recommendation,
   * the request is rejected with 409 DEPTH_OVERRIDE_REQUIRES_ACK unless
   * this field is true. Optional + default-undefined means all existing
   * clients that pick the recommended depth, or who upgrade on a non-soft
   * course, are unaffected.
   */
  depthOverrideAcknowledged: z.boolean().optional(),
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
  /**
   * Mentor-only: ids of attachments to associate with the new user
   * turn. The actual content lives on `LessonMentorChatModel.attachments`
   * (already validated and capped at attach time). This array is just
   * the per-turn pointer set. Capped at 1 per turn — server-side
   * enforcement of the "one paperclip per send" UX. Optional + max
   * keeps the existing course-design chat (which doesn't use this
   * field) trivially valid.
   */
  attachmentIds: z.array(z.string()).max(1).optional(),
});

export const refineStructureSchema = z.object({
  feedback: z.string().min(1, 'Feedback is required').max(1000, 'Feedback must be at most 1000 characters'),
});

export const generateLessonSchema = z.object({
  moduleIndex: z.number().int().min(0, 'moduleIndex must be a non-negative integer'),
  lessonIndex: z.number().int().min(0, 'lessonIndex must be a non-negative integer'),
  includeImage: z.boolean().optional().default(true),
  includeLinks: z.boolean().optional().default(false),
  // Defaults TRUE — spaced retrieval is the highest-value optional feature
  // pedagogically, so we want the typical user to get it without thinking.
  // Users who opt out per lesson can regenerate via /regenerate-recall later.
  includeRecallCards: z.boolean().optional().default(true),
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
export const parseIndexParam = ({ value, name }: { value: string | string[] | undefined; name: string }): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = Number(raw);
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
export const assertPreviousLessonGenerated = async ({
  courseId,
  moduleIndex,
  lessonIndex,
  structure,
}: {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  structure: { modules: { lessons: unknown[] }[] };
}): Promise<void> => {
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
