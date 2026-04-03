import { z } from 'zod';
import { CHAT_ROLES, COURSE_DEPTHS, COURSE_STATUSES } from '@lib/constants';

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
