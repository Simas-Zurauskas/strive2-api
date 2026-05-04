/**
 * Self-executing tests for the link-dedupe pipeline.
 * Run: yarn test:links-dedupe
 *
 * Covers:
 *   - Tracking-parameter strippers (Phase 1 + 2026-04-21 additions)
 *   - Cross-host title-exact dedup (the 2026-04-21 fix for Emily's
 *     arxiv.org / mdpi.com duplicate cholesterol-MD paper)
 *   - Short-title pass-through (no false collisions)
 *   - URL-exact dedup still keeps highest-score survivor
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { dedupeCandidates } from './dedupe';
import { SearchCandidate } from './schemas';


const makeCandidate = (
  overrides: Partial<SearchCandidate> & Pick<SearchCandidate, 'id' | 'url' | 'title'>,
): SearchCandidate => ({
  snippet: overrides.snippet ?? 'snippet',
  hostname: overrides.hostname ?? (() => { try { return new URL(overrides.url).hostname; } catch { return ''; } })(),
  score: overrides.score ?? 0.5,
  queryTopic: overrides.queryTopic ?? 'default-topic',
  ...overrides,
});


// ── Tracking-parameter strippers ──────────────────────────────

test('srsltid is stripped (2026-04-21 addition, Sarah\'s tamron case)', () => {
  const input = [
    makeCandidate({
      id: 'a',
      url: 'https://tamron-americas.com/blog/how-to-create-beautiful-bokeh-effects/?srsltid=AfmBOopQ-KveMlCtvQMuYX6ek2qJaGZx',
      title: 'How to Create Beautiful Bokeh Effects — distinct title for slug test one',
      score: 0.6,
    }),
    makeCandidate({
      id: 'b',
      url: 'https://tamron-americas.com/blog/how-to-create-beautiful-bokeh-effects/?srsltid=DifferentTrackerString',
      title: 'How to Create Beautiful Bokeh Effects — distinct title for slug test one',
      score: 0.8,
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1, 'two tracker variants should collapse to one');
  assert.ok(!out[0].url.includes('srsltid'), 'canonical URL must not contain srsltid');
  assert.equal(out[0].id, 'b', 'higher-score survivor wins');
});

test('mkt_tok is stripped', () => {
  const input = [
    makeCandidate({
      id: 'a',
      url: 'https://example.com/post?mkt_tok=123',
      title: 'A sufficiently long article title for fingerprinting pass',
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1);
  assert.ok(!out[0].url.includes('mkt_tok'));
});

test('si (YouTube session) is stripped', () => {
  const input = [
    makeCandidate({
      id: 'a',
      url: 'https://www.youtube.com/watch?v=abc&si=XyZ',
      title: 'Example Video Title For Dedup Test Only',
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1);
  assert.ok(!out[0].url.includes('si='));
});

test('_hsenc and _hsmi (HubSpot) are stripped', () => {
  const input = [
    makeCandidate({
      id: 'a',
      url: 'https://example.com/blog?_hsenc=abc&_hsmi=42',
      title: 'HubSpot-tracked blog post title for dedup testing',
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1);
  assert.ok(!out[0].url.includes('_hsenc'));
  assert.ok(!out[0].url.includes('_hsmi'));
});

test('utm_* prefix still stripped (Phase 1 regression guard)', () => {
  const input = [
    makeCandidate({
      id: 'a',
      url: 'https://example.com/article?utm_source=google&utm_medium=cpc',
      title: 'Sufficiently long article title for UTM stripping test',
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1);
  assert.ok(!out[0].url.includes('utm_'));
});

// ── Cross-host title-exact dedup ─────────────────────────────

test('same title on different hosts collapses to highest-score survivor (Emily arxiv+mdpi case)', () => {
  const sharedTitle =
    'Comprehensive Recall into Cholesterol-Mediated Modulation of Membrane Function';
  const input = [
    makeCandidate({
      id: 'arxiv',
      url: 'https://arxiv.org/html/2504.05564v1',
      title: sharedTitle,
      score: 0.85,
    }),
    makeCandidate({
      id: 'mdpi',
      url: 'https://www.mdpi.com/2077-0375/15/6/173',
      title: sharedTitle,
      score: 0.72,
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1, 'cross-host same-title collapses to one');
  assert.equal(out[0].id, 'arxiv', 'higher-score (primary source) wins');
});

test('short titles do NOT collide cross-host (12-char slug threshold)', () => {
  const input = [
    makeCandidate({
      id: 'a',
      url: 'https://example-one.com/page',
      title: 'HTTP',
    }),
    makeCandidate({
      id: 'b',
      url: 'https://example-two.com/page',
      title: 'HTTP',
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 2, 'short titles should NOT trigger cross-host dedup');
});

test('different titles on different hosts both survive', () => {
  const input = [
    makeCandidate({
      id: 'a',
      url: 'https://example-one.com/article',
      title: 'Introduction to React: building your first component tree',
      score: 0.9,
    }),
    makeCandidate({
      id: 'b',
      url: 'https://example-two.com/article',
      title: 'State management in React: a practitioner guide to hooks',
      score: 0.8,
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 2);
});

// ── URL-exact dedup (regression guard) ────────────────────────

test('identical canonical URLs keep highest-score row', () => {
  const input = [
    makeCandidate({
      id: 'lo',
      url: 'https://example.com/post',
      title: 'Distinct long title preventing cross-host dedup from firing here',
      score: 0.4,
    }),
    makeCandidate({
      id: 'hi',
      url: 'https://example.com/post',
      title: 'Distinct long title preventing cross-host dedup from firing here',
      score: 0.9,
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'hi');
});

test('query-param ordering does not prevent URL-exact dedup', () => {
  const input = [
    makeCandidate({
      id: 'order1',
      url: 'https://example.com/post?a=1&b=2',
      title: 'A sufficiently long article title for the dedup test pair',
      score: 0.4,
    }),
    makeCandidate({
      id: 'order2',
      url: 'https://example.com/post?b=2&a=1',
      title: 'A sufficiently long article title for the dedup test pair',
      score: 0.8,
    }),
  ];
  const out = dedupeCandidates({ candidates: input });
  assert.equal(out.length, 1, 'param-order should not create two canonical URLs');
  assert.equal(out[0].id, 'order2');
});

// ── Hostname cap + order guard ────────────────────────────────

test('hostname cap still applies after new dedup passes', () => {
  const input = [1, 2, 3, 4].map((n) =>
    makeCandidate({
      id: `a${n}`,
      url: `https://one-host.com/path-${n}`,
      title: `Unique title number ${n} for hostname cap regression test long enough`,
      score: 0.5 + n * 0.01,
    }),
  );
  const out = dedupeCandidates({ candidates: input, hostnameCap: 2 });
  assert.equal(out.length, 2, 'host cap of 2 keeps only 2 rows per host');
});

