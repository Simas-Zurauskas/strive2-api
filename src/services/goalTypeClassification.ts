/**
 * Schema + helpers for the pre-flight goalType classifier that runs inside
 * the `clarify` job. Split out of courseService.ts so tests can import the
 * validation surface without pulling in the LangChain/Anthropic SDKs (which
 * require ANTHROPIC_API_KEY + ENVIRONMENT at import time via @conf/env).
 *
 * The classifier itself lives in courseService.ts — it owns the Anthropic
 * SDK call. This module owns the schema, the per-goalType guidance map, and
 * the safe-default fallback so they can be unit-tested without env.
 */

import { z } from 'zod';
import { GOAL_TYPES, GOAL_TYPE_CONFIDENCES, GoalType } from '@lib/constants';

export const goalTypeClassificationSchema = z.object({
  goalType: z.enum(GOAL_TYPES),
  confidence: z.enum(GOAL_TYPE_CONFIDENCES),
  noun: z.string().min(1).max(80),
});
export type GoalTypeClassification = z.infer<typeof goalTypeClassificationSchema>;

export const GOAL_TYPE_GUIDANCE: Record<GoalType, string> = {
  master:
    "deeply learn / become an expert in / understand X. The default for goals where the learner names a SUBJECT but no project, channel, deliverable, or exam. Also the SAFE DEFAULT for short, vague, garbled, or non-English fragments.",
  monetize:
    "make money: become a YouTuber, run ads, freelance, sell on a platform, grow an audience, launch a side hustle, become a content creator. The deliverable is revenue, channel, audience, or clients.",
  pass:
    "exam, certification, school grade, standardized test, professional license, driving manual. Usually mentions a NAMED test (CPA, JEE, NEET, BITSAT, UPSC, CAT, AWS-SAA, GMAT, MCAT, SAT) or a date (\"by October\", \"before finals\").",
  build:
    "build / ship / launch / create / make a SPECIFIC NAMED PROJECT. The deliverable is the project (a chat app, a SaaS, a portfolio site, a game, a Chrome extension), not the topic.",
  fluency:
    "natural-language acquisition (Spanish, Japanese, Mandarin, German, French, ASL, etc.). NOT communication skills in the learner's own language — that's `master` over a `life-skills` domain.",
};

export const fallbackClassification = (goal: string): GoalTypeClassification => ({
  goalType: 'master',
  confidence: 'low',
  noun: goal.slice(0, 60).trim() || 'this topic',
});
