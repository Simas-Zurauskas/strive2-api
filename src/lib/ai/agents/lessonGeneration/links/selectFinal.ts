import { genLog } from '@lib/loggers';
import { FinalLink, JudgedCandidate } from './schemas';

// Match the judge's "7–8: genuinely expands the lesson; clear recommend" band.
// 6 ("reasonable but not a standout") was admitting filler that pushed runs to
// the MAX_LINKS cap; 7 keeps only candidates the judge actually wants to recommend.
// Empty-state ships when nothing clears the bar — that's preferred over padding.
const SCORE_THRESHOLD = 8;
const MAX_LINKS = 5;
const HOSTNAME_CAP = 2;

type Decision = 'kept' | 'below_threshold' | 'host_cap' | 'over_max';

const decisionGlyph: Record<Decision, string> = {
  kept: '✓',
  below_threshold: '✗',
  host_cap: '⊘',
  over_max: '⊗',
};

const padRight = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

interface SelectFinalInput {
  candidates: JudgedCandidate[];
}

/**
 * Final diversity-aware selection.
 *
 * Rules:
 *   1. Drop anything below the absolute score threshold (8/10). No padding —
 *      filler is strictly worse than the empty-state UI.
 *   2. Sort by score desc, break ties by Tavily relevance.
 *   3. Enforce hostname cap (already applied at dedupe, reasserted here so a
 *      future dedupe config change can't silently loosen this guard).
 *   4. Cap at MAX_LINKS.
 *   5. Prefer the judge's suggested title/description; fall back to original
 *      title + a short snippet-derived description if the judge left one blank.
 *
 * Logs a per-candidate decision table so the threshold and caps can be tuned
 * by reading recent runs (`✓ kept`, `✗ below_threshold`, `⊘ host_cap`,
 * `⊗ over_max`).
 */
export const selectFinalLinks = ({ candidates }: SelectFinalInput): FinalLink[] => {
  // Sort *all* candidates (not just those above threshold) so the log walks
  // the full distribution top-to-bottom.
  const sorted = [...candidates].sort((a, b) => b.judgedScore - a.judgedScore || b.score - a.score);

  const perHost = new Map<string, number>();
  const out: FinalLink[] = [];
  const decisions: { candidate: JudgedCandidate; decision: Decision }[] = [];

  for (const c of sorted) {
    if (c.judgedScore < SCORE_THRESHOLD) {
      decisions.push({ candidate: c, decision: 'below_threshold' });
      continue;
    }
    if (out.length >= MAX_LINKS) {
      decisions.push({ candidate: c, decision: 'over_max' });
      continue;
    }
    const count = perHost.get(c.hostname) ?? 0;
    if (count >= HOSTNAME_CAP) {
      decisions.push({ candidate: c, decision: 'host_cap' });
      continue;
    }
    perHost.set(c.hostname, count + 1);

    const title = c.suggestedTitle.trim() || c.title;
    const description =
      c.suggestedDescription.trim() || c.snippet.trim().slice(0, 180) || 'Further reading for this lesson.';

    out.push({ url: c.url, title, description });
    decisions.push({ candidate: c, decision: 'kept' });
  }

  const counts = decisions.reduce<Record<Decision, number>>(
    (acc, d) => ({ ...acc, [d.decision]: (acc[d.decision] ?? 0) + 1 }),
    { kept: 0, below_threshold: 0, host_cap: 0, over_max: 0 },
  );
  // Per-candidate table is useful for tuning the threshold and caps —
  // hostname + score + decision keeps the line compact.
  for (const { candidate, decision } of decisions) {
    const score = candidate.judgedScore.toFixed(1);
    const host = padRight(candidate.hostname, 28);
    const title = candidate.title.slice(0, 60);
    genLog.info(`links:select  ${decisionGlyph[decision]} ${score} ${host} ${title}${decision === 'kept' ? '' : ` (${decision})`}`);
  }
  genLog.info(
    `links:select-done shipped=${out.length} kept=${counts.kept} threshold=${counts.below_threshold} hostCap=${counts.host_cap} overMax=${counts.over_max} threshold=${SCORE_THRESHOLD} max=${MAX_LINKS}`,
  );

  return out;
};
