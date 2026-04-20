import { ILessonBlock } from '@models/LessonContentModel';
import { bgError } from '@lib/bg';
import {
  bumpLinksGenerationOutcome,
  recordLinksCandidateCount,
} from '@lib/metrics';
import { LessonState } from '../state';
import { planQueries } from './queryPlanner';
import { searchCandidates } from './searchCandidates';
import { dedupeCandidates } from './dedupe';
import { fetchCandidateContent } from './fetchContent';
import { rerankCandidates } from './rerank';
import { selectFinalLinks } from './selectFinal';
import { FinalLink } from './schemas';

const formatBlockContent = (links: FinalLink[]): string =>
  links.map((l) => `- [${l.title}](${l.url}) — ${l.description}`).join('\n');

const toLinksBlock = (links: FinalLink[]): ILessonBlock => ({
  id: 'links-1',
  type: 'links',
  content: formatBlockContent(links),
  metadata: { links },
  order: 9999,
});

/**
 * Empty-state block that ships when no candidate cleared the judge threshold,
 * or when the whole links pipeline is aborted by the node-level timeout.
 * Kept as a block so the client can render a visible "we didn't find good
 * external resources" message rather than silently omitting the section.
 */
export const toEmptyStateBlock = (): ILessonBlock => ({
  id: 'links-1',
  type: 'links',
  content: '',
  metadata: { links: [] },
  order: 9999,
});

/**
 * Run the full curated-links pipeline end-to-end.
 *
 * Stages (each degrades gracefully when the next has nothing to work with):
 *   1. plan 2–5 engaging bonus-reading topics (LLM picks count and flavor)
 *   2. parallel Tavily advanced search, sized to ~20 total candidates
 *   3. dedupe (URL canonicalize + title-fingerprint near-dup) + hostname cap + meta-page blocklist
 *   4. parallel Jina Reader content fetch
 *   5. LLM judge against full content
 *   6. diversity-aware final selection (threshold ≥ 6/10)
 *
 * Always resolves to an ILessonBlock — never null — because the empty-state
 * UI is the designed outcome when no link clears the bar, and the caller
 * wants to stream a "further reading" block regardless.
 */
export const curateLinks = async (state: LessonState): Promise<ILessonBlock> => {
  try {
    // Stage 1
    const plan = await planQueries({
      lessonName: state.lessonName,
      lessonDescription: state.lessonDescription,
      contentSummary: state.contentSummary,
      domain: state.domain,
    });

    // Stage 2
    const rawCandidates = await searchCandidates(plan);
    if (rawCandidates.length === 0) {
      bumpLinksGenerationOutcome('zero_candidates');
      recordLinksCandidateCount(0);
      return toEmptyStateBlock();
    }

    // Stage 3
    const deduped = dedupeCandidates({ candidates: rawCandidates });
    if (deduped.length === 0) {
      bumpLinksGenerationOutcome('zero_candidates');
      recordLinksCandidateCount(0);
      return toEmptyStateBlock();
    }

    // Stage 4
    const fetched = await fetchCandidateContent({ candidates: deduped });
    if (fetched.length === 0) {
      bumpLinksGenerationOutcome('zero_fetched');
      recordLinksCandidateCount(0);
      return toEmptyStateBlock();
    }

    // Stage 5
    const judged = await rerankCandidates({
      candidates: fetched,
      lessonName: state.lessonName,
      lessonDescription: state.lessonDescription,
      lessonSummary: state.contentSummary,
      domain: state.domain,
    });

    // Stage 6
    const finalLinks = selectFinalLinks({ candidates: judged });
    if (finalLinks.length === 0) {
      bumpLinksGenerationOutcome('zero_judged_above_threshold');
      recordLinksCandidateCount(0);
      return toEmptyStateBlock();
    }

    bumpLinksGenerationOutcome('shipped');
    recordLinksCandidateCount(finalLinks.length);
    return toLinksBlock(finalLinks);
  } catch (e) {
    bgError('linksGeneration.curateLinks')(e);
    bumpLinksGenerationOutcome('error');
    recordLinksCandidateCount(0);
    return toEmptyStateBlock();
  }
};
