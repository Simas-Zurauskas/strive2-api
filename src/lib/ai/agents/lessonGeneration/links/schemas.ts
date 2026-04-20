import { z } from 'zod';
import { jsonish } from '@lib/zodHelpers';

// ── Pipeline-internal types ────────────────────────────

/** Raw candidate produced by a Tavily search hit. */
export interface SearchCandidate {
  id: string;
  url: string;
  title: string;
  snippet: string;
  hostname: string;
  score: number;
  queryTopic: string;
}

/** Candidate augmented with full markdown content from the reader. */
export interface FetchedCandidate extends SearchCandidate {
  fetchedContent: string;
}

/** Candidate after the LLM judge has scored it. */
export interface JudgedCandidate extends FetchedCandidate {
  judgedScore: number;
  judgedReason: string;
  suggestedTitle: string;
  suggestedDescription: string;
}

/** What ships on the block. */
export interface FinalLink {
  url: string;
  title: string;
  description: string;
}

// ── Topic planner ──────────────────────────────────────

export const topicPlanSchema = z.object({
  topics: jsonish(
    z
      .array(
        z.object({
          topic: z.string().min(3).max(160).describe('Short headline a learner could read on a tab title and feel pulled to click'),
          angle: z.string().min(3).max(280).describe('One sentence on what makes this engaging or worth the learner\'s time'),
          query: z.string().min(3).max(200).describe('3–12 word natural-language search query (no operators)'),
        }),
      )
      .min(2)
      .max(5),
  ),
});

export type TopicPlan = z.infer<typeof topicPlanSchema>;

// ── Judge ──────────────────────────────────────────────

export const judgedCandidateSchema = z.object({
  id: z.string(),
  score: z.number().min(0).max(10),
  reason: z.string().describe('Why this score — target ≤ 240 chars, overshoots are accepted'),
  suggestedTitle: z.string().describe('Target ≤ 200 chars, overshoots are accepted'),
  suggestedDescription: z.string().describe('Target ≤ 280 chars, overshoots are accepted'),
});

export const judgeOutputSchema = z.object({
  verdicts: jsonish(z.array(judgedCandidateSchema)),
});

export type JudgeVerdict = z.infer<typeof judgedCandidateSchema>;
