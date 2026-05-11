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
    "build / ship / launch / create / make / migrate / port / refactor a SPECIFIC NAMED DELIVERABLE. The deliverable can be a personal project (chat app, SaaS, portfolio site, game, Chrome extension) OR a workplace task (production migration, infrastructure rollout, system port, payments refactor, internal tool). Trigger phrases include 'for a migration at work', 'to ship our X', 'to refactor our Y', 'to set up our Z', 'for a production rollout'. The deliverable, not the topic, is the goal — the learner is learning Kubernetes/Spring/Terraform AS A MEANS to a named end.",
  fluency:
    "natural-language acquisition (Spanish, Japanese, Mandarin, German, French, ASL, etc.). NOT communication skills in the learner's own language — that's `master` over a `life-skills` domain.",
};

// One-sentence behavioral lens injected into mentor system context (both
// lesson and course scope). Distinct from GOAL_TYPE_GUIDANCE (classifier
// disambiguation) and GOAL_TYPE_STRUCTURE_GUIDANCE (curriculum shaping):
// this map shapes how the mentor REPLIES — what to prioritize, where to
// steer the learner — not what the curriculum looks like.
export const GOAL_TYPE_MENTOR_LENS: Record<GoalType, string> = {
  master:
    'Learner wants depth and understanding. Conceptual tangents and cross-module connections are welcome when they sharpen the mental model.',
  monetize:
    "Learner wants revenue, audience, or clients. Prefer tactical next-actions over theory; tie examples to the learner's named niche / product / channel when present in the goal.",
  pass:
    'Learner is preparing for an exam or certification. Bias toward retrieval practice and exam-traps; steer to Module Quizzes or the Recall queue over re-explanation when the question is testable.',
  build:
    'Learner is shipping a specific project. Anchor answers to that project; prefer concrete decisions and code-level specifics over background theory.',
  fluency:
    'Learner is acquiring a natural language. Encourage attempts in the target language and active recall; the Recall queue is the right surface for vocabulary drilling.',
};

export const fallbackClassification = (goal: string): GoalTypeClassification => ({
  goalType: 'master',
  confidence: 'low',
  noun: goal.slice(0, 60).trim() || 'this topic',
});
