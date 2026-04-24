/**
 * Course-scoped in-memory cache for Tavily search results.
 *
 * Rationale: a single course-generation job chain runs `searchCandidates`
 * once per lesson with 2-5 topic queries per lesson. Related lessons often
 * share near-identical topics ("backpropagation intuition" surfaces in every
 * ML-intro course). Without dedup, each lesson pays $0.016 per query — a 15-
 * lesson course with 3 queries each = $0.72 minimum, often duplicating 30-40%
 * of queries across lessons.
 *
 * Scope: process-local Map keyed by `courseId`. Entries expire after TTL OR
 * when the scope cap forces LRU eviction, so long-lived servers don't
 * accumulate courses indefinitely. Running >1 pod would miss cross-pod hits
 * — acceptable given the single-instance deployment flagged in
 * `lib/langchain.ts:5`. Tavily advanced is idempotent on short windows so
 * serving a cross-lesson stale result is benign for bonus-reading links.
 *
 * Key normalization: lowercase + collapse whitespace. Avoids trivial misses
 * from capitalization / spacing drift between planner outputs on sibling
 * lessons.
 */
import { SearchCandidate } from './schemas';

interface CachedEntry {
  candidates: SearchCandidate[];
  cachedAt: number;
}

type CourseScope = Map<string, CachedEntry>; // normalizedQuery → candidates

const courseScopes = new Map<string, CourseScope>();

const COURSE_SCOPE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours covers any realistic course-gen span
const MAX_COURSE_SCOPES = 100; // hard cap to bound memory on a long-lived process

const normalizeQuery = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');

const mostRecentActivity = (scope: CourseScope): number => {
  let max = 0;
  for (const entry of scope.values()) {
    if (entry.cachedAt > max) max = entry.cachedAt;
  }
  return max;
};

const evictStaleAndOverflow = (): void => {
  const now = Date.now();
  // First: drop any scope that hasn't been touched within TTL
  for (const [courseId, scope] of courseScopes) {
    if (now - mostRecentActivity(scope) > COURSE_SCOPE_TTL_MS) {
      courseScopes.delete(courseId);
    }
  }
  // Then: if still over cap, evict oldest by most-recent activity
  if (courseScopes.size <= MAX_COURSE_SCOPES) return;
  const ordered = Array.from(courseScopes.entries())
    .map(([courseId, scope]) => ({ courseId, recent: mostRecentActivity(scope) }))
    .sort((a, b) => a.recent - b.recent);
  const overflow = courseScopes.size - MAX_COURSE_SCOPES;
  for (let i = 0; i < overflow; i++) courseScopes.delete(ordered[i].courseId);
};

export const getCachedSearch = ({
  courseId,
  query,
}: {
  courseId: string;
  query: string;
}): SearchCandidate[] | null => {
  const scope = courseScopes.get(courseId);
  if (!scope) return null;
  const key = normalizeQuery(query);
  const cached = scope.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > COURSE_SCOPE_TTL_MS) {
    scope.delete(key);
    return null;
  }
  return cached.candidates;
};

export const setCachedSearch = ({
  courseId,
  query,
  candidates,
}: {
  courseId: string;
  query: string;
  candidates: SearchCandidate[];
}): void => {
  let scope = courseScopes.get(courseId);
  if (!scope) {
    evictStaleAndOverflow();
    scope = new Map();
    courseScopes.set(courseId, scope);
  }
  scope.set(normalizeQuery(query), { candidates, cachedAt: Date.now() });
};
