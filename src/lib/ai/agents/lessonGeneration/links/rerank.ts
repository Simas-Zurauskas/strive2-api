import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getUtilityModel } from '@lib/langchain';
import { sanitizePromptInput } from '@lib/sanitize';
import { CourseDomain } from '@lib/constants';
import { bgError } from '@lib/bg';
import { genLog } from '@lib/loggers';
import { FetchedCandidate, JudgedCandidate, judgeOutputSchema } from './schemas';

// How many characters of fetched content to show the judge per candidate.
// Smaller than the 4000-char stored body to keep the token budget in check
// across ~10 candidates.
const CONTENT_CHARS_FOR_JUDGE = 2_000;

// Shuffling the candidate list before the LLM sees it mitigates positional
// bias — LLM rerankers tend to score the first and last items higher than
// equally-relevant items in the middle. A simple Fisher-Yates is enough.
const shuffle = <T,>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const buildJudgeSystemPrompt = (todayIso: string): string => `You are a strict curator for a lesson's "Further Reading" section. Each candidate below was surfaced by a web search, its full main-content has been fetched, and it's now your job to score how valuable it would be for a learner who just finished this lesson.

You are scoring on ${todayIso} (today's UTC date). Use this to evaluate publication freshness and to flag implausible future-dated paths.

Score each candidate from 0 to 10 using this filler-detection checklist. Every "no" should pull the score down; every strong "yes" should pull it up.

1. Does the content DEEPEN what the lesson taught, not just repeat it? A mere re-summary scores low.
2. Is the source primary / canonical (official docs, original paper, reference implementation, recognised practitioner), or a derived re-summary?
3. Does the subject matter match the declared course domain? A PDF of art-school drawings on a Spanish-storytelling lesson is a catastrophic mismatch even if the Tavily snippet looked plausible.
4. Would a learner click this and actually learn something NEW they didn't get from the lesson?
5. Is the content pragmatically accessible? Avoid login walls, paywall-only abstracts, or gated previews.
6. Is it current enough for topics where recency matters (frameworks, APIs, policy) — and not penalised for timelessness on topics where recency doesn't matter (foundational concepts, classic texts)?
7. Would the author be a credible teacher on this topic? Domain, author signals, and in-body expertise all count.
8. Is the content length meaningful (not a 100-word blog stub, not a Wikipedia stub, not a table-of-contents page)?
9. Does it complement, extend, or productively CONTRADICT the lesson? Productive opposition (e.g. a recognised critique) is valuable.
10. Would you be comfortable recommending this link to a senior expert in the subject? If embarrassing, score ≤ 4.
11. **Future-date implausibility.** If the URL path contains a year that is STRICTLY GREATER than the current year (e.g. a "/2027/..." slug scored in 2026), penalize by -3. A legitimate tutorial is not dated in the future; such paths are almost always retrieval artifacts or fabrications. Year-shaped tokens that aren't dates (version numbers like "v2024.03", API paths) should be judged contextually — look at the fetched content to decide.
12. **Vendor-topic mismatch.** If the publishing domain's primary business is unrelated to the lesson topic — an observability vendor's blog hosting a SQL tutorial, a product-marketing microsite on general engineering concepts, a camera-seller blog posing as a canonical photography reference — penalize by -2. Prefer primary sources: official docs, reference implementations, recognised practitioner blogs, academic publishers.

Scoring band guidance:
- 9–10: must-read for any serious learner of this topic; they'd feel the lesson was incomplete without it.
- 7–8: genuinely expands the lesson; clear recommend.
- 6: a reasonable reference but not a standout.
- 3–5: keyword-matches the topic but doesn't add real value.
- 0–2: off-topic, filler, or actively misleading.

Do NOT invent or modify URLs. You are scoring a fixed candidate set. Every entry in your output must correspond to exactly one candidate id from the input. Score every candidate whose id appears in the input list — do not skip entries and do not emit entries with null fields. If for any reason you cannot score a candidate, OMIT it entirely rather than including a placeholder row.

The suggestedTitle should be a reader-friendly title (cleaner than the raw scraped title when it contains site chrome); suggestedDescription should be ONE short sentence explaining WHY this is worth the learner's time — not a summary of the page.

Return ONLY a JSON object of shape { verdicts: Array<{ id, score, reason, suggestedTitle, suggestedDescription }> }.`;

interface RerankInput {
  candidates: FetchedCandidate[];
  lessonName: string;
  lessonDescription: string;
  lessonSummary: string;
  domain: CourseDomain | null;
}

const formatCandidate = (c: FetchedCandidate, displayIndex: number): string => {
  const content = c.fetchedContent.slice(0, CONTENT_CHARS_FOR_JUDGE);
  return `### Candidate ${displayIndex + 1}  (id: ${c.id})
- URL: ${c.url}
- Hostname: ${c.hostname}
- Tavily relevance score: ${c.score.toFixed(3)}
- Bonus-reading topic: ${c.queryTopic}
- Title: ${c.title}
- Fetched content (first ${CONTENT_CHARS_FOR_JUDGE} chars):
\`\`\`
${content}
\`\`\``;
};

/**
 * Score each fetched candidate against the lesson.
 *
 * The LLM judges against the FULL fetched content, not just the snippet —
 * that's the whole reason the fetch stage exists. Shuffles the input order
 * before sending to mitigate positional bias. Returns the candidates back in
 * their original input order, each enriched with the judge's verdict.
 *
 * Any candidate the LLM doesn't return a verdict for is dropped. Any verdict
 * referencing an unknown id is ignored (defensive against the LLM drifting
 * off-list — we never ship a URL the model invented).
 */
export const rerankCandidates = async ({
  candidates,
  lessonName,
  lessonDescription,
  lessonSummary,
  domain,
}: RerankInput): Promise<JudgedCandidate[]> => {
  if (candidates.length === 0) return [];

  const shuffled = shuffle(candidates);
  const humanBody = `## Lesson
**Title:** ${sanitizePromptInput(lessonName)}

**Description:** ${sanitizePromptInput(lessonDescription)}

**Course domain:** ${domain ?? 'unclassified'}

## Lesson summary
${sanitizePromptInput(lessonSummary || '(not yet generated)')}

## Candidates
${shuffled.map((c, i) => formatCandidate(c, i)).join('\n\n')}

Score every candidate.`;

  try {
    const model = getUtilityModel().withStructuredOutput(judgeOutputSchema);
    const todayIso = new Date().toISOString().slice(0, 10);
    const result = await model.invoke(
      [new SystemMessage(buildJudgeSystemPrompt(todayIso)), new HumanMessage(humanBody)],
      { metadata: { llmLabel: 'lesson:links.rerank' } },
    );

    const candidatesById = new Map(candidates.map((c) => [c.id, c]));
    const out: JudgedCandidate[] = [];
    for (const verdict of result.verdicts) {
      const base = candidatesById.get(verdict.id);
      if (!base) continue; // defense against hallucinated ids
      // Skip-sentinel guard: judge occasionally emits an entry with nulls
      // instead of omitting it (see judgedCandidateSchema note). Drop those
      // rather than shipping a link with score 0 / empty description.
      if (verdict.score === null || verdict.suggestedDescription == null) continue;
      out.push({
        ...base,
        judgedScore: verdict.score,
        judgedReason: verdict.reason,
        suggestedTitle: verdict.suggestedTitle?.trim() || base.title,
        suggestedDescription: verdict.suggestedDescription.trim(),
      });
    }
    genLog.info(`links:rerank judged=${out.length}/${candidates.length}`);
    return out;
  } catch (e) {
    bgError('linksGeneration.rerank')(e);
    const reason = e instanceof Error ? e.message : String(e);
    genLog.error(`links:rerank-fail reason=${reason} — judge LLM failed, returning 0`);
    return [];
  }
};
