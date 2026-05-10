import { TavilySearch } from '@langchain/tavily';
import { TAVILY_API_KEY } from '@conf/env';
import { withRetry } from '@lib/retry';
import { bgError } from '@lib/bg';
import { priceFlatUnit } from '@lib/pricing';
import { bumpTavilySearchDedupHit } from '@lib/metrics';
import { recordUsage } from '@services/usageService';
import { genLog, integrationLog } from '@lib/loggers';
import { TopicPlan, SearchCandidate } from './schemas';
import { getCachedSearch, setCachedSearch } from './searchCache';

// Aim for ~20 raw candidates across the topic plan, divided evenly per topic
// and capped per topic so a single Tavily query never floods the pool. The
// planner produces exactly 2 topics today, so the typical layout is 10+10;
// the divider stays generic in case the planner cap is loosened later.
const TARGET_TOTAL_CANDIDATES = 20;
const MAX_PER_TOPIC = 10;

// TavilySearch has no built-in request timeout — a stalled HTTP connection
// would never throw, so the surrounding try/catch in this file (and the
// pipeline-level catch in index.ts) never fires, and `Promise.all` across
// the topic queries hangs until the lesson's 5-min stream budget kills the
// whole lesson. 15s covers ~p99 of legitimate advanced-search latency; a
// slow query that exceeds it is cheaper to drop than to wait for.
const TAVILY_QUERY_TIMEOUT_MS = 15_000;

const withTavilyTimeout = <T>(p: Promise<T>, query: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tavily query "${query}" timed out after ${TAVILY_QUERY_TIMEOUT_MS}ms`)),
      TAVILY_QUERY_TIMEOUT_MS,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

const perTopicMax = (topicCount: number): number =>
  Math.min(MAX_PER_TOPIC, Math.max(1, Math.ceil(TARGET_TOTAL_CANDIDATES / Math.max(1, topicCount))));

interface TavilyRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
}

const extractResults = (raw: unknown): TavilyRawResult[] => {
  if (Array.isArray(raw)) return raw as TavilyRawResult[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results)) {
    return (raw as { results: TavilyRawResult[] }).results;
  }
  return [];
};

// Slugify a topic into a stable short id prefix so candidate ids stay
// human-readable in logs but never collide across topics. Keeps lowercase
// alphanumerics, replaces everything else with `-`, trims to 32 chars.
const topicSlug = (topic: string, fallbackIndex: number): string => {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || `topic-${fallbackIndex}`;
};

const toCandidate = (
  r: TavilyRawResult,
  topic: string,
  idPrefix: string,
  indexInQuery: number,
): SearchCandidate | null => {
  const url = typeof r.url === 'string' ? r.url : null;
  const title = typeof r.title === 'string' ? r.title : null;
  if (!url || !title) return null;
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return {
    id: `${idPrefix}-${indexInQuery}`,
    url,
    title,
    snippet: typeof r.content === 'string' ? r.content : '',
    hostname,
    score: typeof r.score === 'number' ? r.score : 0,
    queryTopic: topic,
  };
};

/**
 * Run the planned topic queries in parallel and flatten into raw candidates.
 *
 * Per-topic result count is computed from `TARGET_TOTAL_CANDIDATES = 20` and
 * the topic count, capped by `MAX_PER_TOPIC = 10`. `searchDepth: 'basic'`
 * costs half what `'advanced'` does (1 Tavily credit vs 2 = $0.008 vs $0.016
 * per query); the downstream rerank LLM judge re-scores every snippet anyway,
 * so the longer advanced-snippet preview rarely changes the final ranking.
 *
 * Each query is wrapped with a single retry to absorb transient 5xx / timeouts.
 * A failed query contributes zero candidates but never fails the pipeline —
 * we'd rather ship with N-1 topics' worth than zero.
 */
export const searchCandidates = async ({
  topics,
  courseId,
}: TopicPlan & { courseId: string }): Promise<SearchCandidate[]> => {
  const maxResults = perTopicMax(topics.length);
  const tavily = new TavilySearch({
    tavilyApiKey: TAVILY_API_KEY,
    searchDepth: 'basic',
    maxResults,
  });

  const perQuery = await Promise.all(
    topics.map(async ({ topic, query }, topicIndex) => {
      const idPrefix = topicSlug(topic, topicIndex);

      // Cross-lesson cache. A sibling lesson in the same course with the
      // same normalized query reuses candidates here — zero Tavily spend
      // for the hit. `setCachedSearch` below lands the miss path's results
      // for the next lesson.
      const cached = getCachedSearch({ courseId, query });
      if (cached) {
        bumpTavilySearchDedupHit();
        genLog.info(`links:search-cache-hit q="${query}" candidates=${cached.length}`);
        return cached;
      }

      try {
        const raw = await withRetry(
          () => withTavilyTimeout(tavily.invoke({ query }), query),
          { maxRetries: 1, baseDelayMs: 500 },
        );
        recordUsage({
          service: 'tavily',
          action: 'search:basic',
          costMicroCents: priceFlatUnit({ sku: 'tavily_search_basic' }),
          metadata: { query, topic, maxResults },
        });
        const results = extractResults(raw);
        const candidates = results
          .map((r, i) => toCandidate(r, topic, idPrefix, i))
          .filter((c): c is SearchCandidate => c !== null);
        setCachedSearch({ courseId, query, candidates });
        genLog.info(`links:search-ok q="${query}" candidates=${candidates.length}`);
        return candidates;
      } catch (e) {
        bgError('linksGeneration.tavilySearch')(e);
        const reason = e instanceof Error ? e.message : String(e);
        integrationLog.error(`tavily:search fail q="${query}" reason=${reason}`);
        return [];
      }
    }),
  );
  const flat = perQuery.flat();
  genLog.info(`links:search-done topics=${topics.length} raw=${flat.length} target~${TARGET_TOTAL_CANDIDATES}`);
  return flat;
};
