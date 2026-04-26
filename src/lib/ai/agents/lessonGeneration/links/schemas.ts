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
          topic: z.string().min(3).describe('Short headline a learner could read on a tab title — target ≤ 160 chars, overshoots accepted'),
          angle: z.string().min(3).describe('One sentence on what makes this engaging — target ≤ 280 chars, overshoots accepted'),
          query: z.string().min(3).describe('3–12 word natural-language search query (no operators) — target ≤ 200 chars, overshoots accepted'),
        }),
      )
      .min(2)
      .max(5),
  ),
});

export type TopicPlan = z.infer<typeof topicPlanSchema>;

// ── Judge ──────────────────────────────────────────────

// Fields other than `id` are nullable to absorb the judge's occasional
// "skip sentinel" — when it believes a candidate id it was given is actually
// unknown, it emits `{ id, score: null, suggestedTitle: null, ... }` instead
// of omitting the entry. Rejecting the whole response on one such entry drops
// every valid verdict alongside it (the rerank catch returns []). Nullable
// here + null-filter in the mapping loop = one bad entry, not zero links.
export const judgedCandidateSchema = z.object({
  id: z.string(),
  score: z.number().min(0).max(10).nullable(),
  reason: z.string().describe('Why this score — target ≤ 240 chars, overshoots are accepted'),
  suggestedTitle: z.string().describe('Target ≤ 200 chars, overshoots are accepted').nullish(),
  suggestedDescription: z.string().describe('Target ≤ 280 chars, overshoots are accepted').nullish(),
});

export const judgeOutputSchema = z.object({
  verdicts: jsonish(z.array(judgedCandidateSchema)),
});

export type JudgeVerdict = z.infer<typeof judgedCandidateSchema>;
