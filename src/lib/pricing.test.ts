/**
 * Self-executing test file for the pricing table. Matches the zero-framework
 * style of the other `*.test.ts` files in this repo.
 *
 * Run: yarn test:pricing
 *
 * Exits 0 on success; assertion failures throw and exit non-zero.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  priceLlmUsage,
  priceFlatUnit,
  LLM_PRICING,
  SERVICE_PRICING,
  applyMarkup,
  markupFor,
  type CreditBucket,
} from './pricing';
import { PRICING_CONFIG } from './pricingConfig';


const zeroTokens = { cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, uncached: 0, output: 0 };


// ── priceLlmUsage ─────────────────────────────────────────

test('zero tokens → 0 microcents', () => {
  const cost = priceLlmUsage({ model: 'claude-sonnet-4-6', ...zeroTokens });
  assert.equal(cost, 0);
});

test('uncached input tokens priced at Sonnet input rate', () => {
  // 1M uncached @ $3.00/M = 300 ¢ = 3_000_000 μ¢
  const cost = priceLlmUsage({
    model: 'claude-sonnet-4-6',
    ...zeroTokens,
    uncached: 1_000_000,
  });
  assert.equal(cost, LLM_PRICING['claude-sonnet-4-6'].inputMicroCentsPerMTok);
});

test('cache-read tokens priced at the cache-read rate (cheaper than input)', () => {
  const sonnet = LLM_PRICING['claude-sonnet-4-6'];
  const cost = priceLlmUsage({
    model: 'claude-sonnet-4-6',
    ...zeroTokens,
    cacheRead: 1_000_000,
  });
  assert.equal(cost, sonnet.cacheReadMicroCentsPerMTok);
  assert.ok(cost < sonnet.inputMicroCentsPerMTok, 'cache reads should cost less than uncached input');
});

test('5-minute cache-creation tokens priced at the 5m rate (1.25× input)', () => {
  const sonnet = LLM_PRICING['claude-sonnet-4-6'];
  const cost = priceLlmUsage({
    model: 'claude-sonnet-4-6',
    ...zeroTokens,
    cacheCreation5m: 1_000_000,
  });
  assert.equal(cost, sonnet.cacheWrite5mMicroCentsPerMTok);
  assert.ok(cost > sonnet.inputMicroCentsPerMTok, '5m cache writes should cost more than uncached input');
});

test('1-hour cache-creation tokens priced at the 1h rate (2× input) — pricier than 5m', () => {
  const sonnet = LLM_PRICING['claude-sonnet-4-6'];
  const cost = priceLlmUsage({
    model: 'claude-sonnet-4-6',
    ...zeroTokens,
    cacheCreation1h: 1_000_000,
  });
  assert.equal(cost, sonnet.cacheWrite1hMicroCentsPerMTok);
  assert.ok(cost > sonnet.cacheWrite5mMicroCentsPerMTok, '1h cache writes must cost more than 5m');
  assert.equal(cost, 2 * sonnet.inputMicroCentsPerMTok, '1h cache must be exactly 2× input');
});

test('haiku 1h cache-creation tokens priced at 2× input', () => {
  const haiku = LLM_PRICING['claude-haiku-4-5'];
  const cost = priceLlmUsage({
    model: 'claude-haiku-4-5',
    ...zeroTokens,
    cacheCreation1h: 1_000_000,
  });
  assert.equal(cost, haiku.cacheWrite1hMicroCentsPerMTok);
  assert.equal(cost, 2 * haiku.inputMicroCentsPerMTok);
});

test('output tokens priced at the output rate (pricier than input)', () => {
  const sonnet = LLM_PRICING['claude-sonnet-4-6'];
  const cost = priceLlmUsage({
    model: 'claude-sonnet-4-6',
    ...zeroTokens,
    output: 1_000_000,
  });
  assert.equal(cost, sonnet.outputMicroCentsPerMTok);
});

test('mixed breakdown sums each bucket correctly', () => {
  const sonnet = LLM_PRICING['claude-sonnet-4-6'];
  // 500k cache-read + 200k 5m-write + 50k 1h-write + 100k uncached + 300k output
  const cost = priceLlmUsage({
    model: 'claude-sonnet-4-6',
    cacheRead: 500_000,
    cacheCreation5m: 200_000,
    cacheCreation1h: 50_000,
    uncached: 100_000,
    output: 300_000,
  });
  const expected = Math.round(
    (500_000 * sonnet.cacheReadMicroCentsPerMTok +
      200_000 * sonnet.cacheWrite5mMicroCentsPerMTok +
      50_000 * sonnet.cacheWrite1hMicroCentsPerMTok +
      100_000 * sonnet.inputMicroCentsPerMTok +
      300_000 * sonnet.outputMicroCentsPerMTok) /
      1_000_000,
  );
  assert.equal(cost, expected);
});

test('unknown model → 0 microcents (and one warn line, not thrown)', () => {
  const cost = priceLlmUsage({
    model: 'claude-made-up-99-0',
    ...zeroTokens,
    cacheRead: 1_000_000,
    uncached: 1_000_000,
    output: 1_000_000,
  });
  assert.equal(cost, 0);
});

test('haiku is cheaper per token than sonnet', () => {
  const args = { ...zeroTokens, uncached: 1_000_000, output: 1_000_000 } as const;
  const sonnetCost = priceLlmUsage({ model: 'claude-sonnet-4-6', ...args });
  const haikuCost = priceLlmUsage({ model: 'claude-haiku-4-5', ...args });
  assert.ok(haikuCost < sonnetCost, 'haiku must price below sonnet for the same token mix');
});

// ── claude-sonnet-5 (2026-08 migration) ───────────────────
// Sticker rates, deliberately equal to sonnet-4-6 per-token (the intro
// $2/$10 pricing lapses 2026-08-31 and must NOT be in this table).

test('sonnet-5 entry exists and prices identically to sonnet-4-6 per token', () => {
  const s5 = LLM_PRICING['claude-sonnet-5'];
  const s46 = LLM_PRICING['claude-sonnet-4-6'];
  assert.ok(s5, 'claude-sonnet-5 must be in LLM_PRICING before any call site emits it');
  assert.deepEqual(s5, s46, 'sonnet-5 sticker rates must equal sonnet-4-6 rates');
});

test('sonnet-5 uncached input priced at $3/MTok (nonzero — no silent free metering)', () => {
  const cost = priceLlmUsage({
    model: 'claude-sonnet-5',
    ...zeroTokens,
    uncached: 1_000_000,
  });
  assert.equal(cost, 3_000_000);
  assert.ok(cost > 0, 'a priced model must never meter 0');
});

test('sonnet-5 cache economics: read < input < 5m write < 1h write (2× input)', () => {
  const s5 = LLM_PRICING['claude-sonnet-5'];
  assert.ok(s5.cacheReadMicroCentsPerMTok < s5.inputMicroCentsPerMTok);
  assert.ok(s5.inputMicroCentsPerMTok < s5.cacheWrite5mMicroCentsPerMTok);
  assert.ok(s5.cacheWrite5mMicroCentsPerMTok < s5.cacheWrite1hMicroCentsPerMTok);
  assert.equal(s5.cacheWrite1hMicroCentsPerMTok, 2 * s5.inputMicroCentsPerMTok);
});

test('sonnet-5 output priced at $15/MTok', () => {
  const cost = priceLlmUsage({
    model: 'claude-sonnet-5',
    ...zeroTokens,
    output: 1_000_000,
  });
  assert.equal(cost, 15_000_000);
});

test('always returns an integer', () => {
  const cost = priceLlmUsage({
    model: 'claude-sonnet-4-6',
    cacheRead: 1,
    cacheCreation5m: 2,
    cacheCreation1h: 1,
    uncached: 3,
    output: 4,
  });
  assert.equal(Number.isInteger(cost), true);
});

test('Jina Reader priced at $0.05/MTok via the uncached bucket', () => {
  const cost = priceLlmUsage({
    model: 'jina_reader_paid',
    ...zeroTokens,
    uncached: 1_000_000,
  });
  // $0.05/MTok → 5¢/MTok → 50,000 μ¢/MTok. 1M uncached tokens = 50,000 μ¢.
  assert.equal(cost, 50_000, 'Jina Reader $0.05/MTok = 50,000 μ¢');
});

// ── priceFlatUnit ─────────────────────────────────────────

test('priceFlatUnit returns the sku rate for a single unit', () => {
  for (const sku of Object.keys(SERVICE_PRICING) as (keyof typeof SERVICE_PRICING)[]) {
    assert.equal(priceFlatUnit({ sku }), SERVICE_PRICING[sku].perUnitMicroCents);
  }
});

test('priceFlatUnit scales linearly with units', () => {
  const single = priceFlatUnit({ sku: 'tavily_search_basic' });
  const triple = priceFlatUnit({ sku: 'tavily_search_basic', units: 3 });
  assert.equal(triple, single * 3);
});

test('priceFlatUnit clamps negative units to 0', () => {
  const cost = priceFlatUnit({ sku: 'bfl_flux_dev', units: -5 });
  assert.equal(cost, 0);
});

// Unit anchor: 1¢ = 10,000 μ¢. $0.025 = 25,000 μ¢; $0.016 = 16,000 μ¢.
// These tests pin the canonical values after a prior 10× inflation bug
// (all SKUs were entered with the wrong scale factor).

test('BFL Flux dev priced at $0.025/image = 25,000 μ¢', () => {
  assert.equal(priceFlatUnit({ sku: 'bfl_flux_dev' }), 25_000);
});

test('Tavily basic search priced at $0.008/query = 8,000 μ¢', () => {
  assert.equal(priceFlatUnit({ sku: 'tavily_search_basic' }), 8_000);
});

test('Judge0 RapidAPI priced at $0.002/exec = 2,000 μ¢', () => {
  assert.equal(priceFlatUnit({ sku: 'judge0_rapidapi' }), 2_000);
});

// ── applyMarkup (action-driven) ────────────────────────────

// Markup is resolved per call from the action label, NOT from a scope-level
// category. Only actions listed in LESSON_PREMIUM_ACTIONS bill at the lesson
// row of MARKUP; everything else bills at the `other` row. The bucket
// (allowance vs bonus) is supplied by the caller; the category is derived.
const BUCKETS = ['allowance', 'bonus'] as const satisfies readonly CreditBucket[];

const LESSON_ACTION = 'lesson:content';
const OTHER_ACTION = 'mentor:chat';

test('markupFor: lesson:content resolves to MARKUP.lesson', () => {
  for (const bucket of BUCKETS) {
    assert.equal(
      markupFor({ action: LESSON_ACTION, creditBucket: bucket }),
      PRICING_CONFIG.markup.lesson[bucket],
      `lesson:content / ${bucket} must read MARKUP.lesson.${bucket}`,
    );
  }
});

test('markupFor: every non-premium action resolves to MARKUP.other', () => {
  // Supporting calls INSIDE lesson generation also fall through to `other`.
  for (const action of ['mentor:chat', 'image:hero', 'lesson:recall', 'lesson:links.plan', 'search:basic', 'structure:generate', 'utility', 'embedding:index', 'upsert', 'reader:fetch']) {
    for (const bucket of BUCKETS) {
      assert.equal(
        markupFor({ action, creditBucket: bucket }),
        PRICING_CONFIG.markup.other[bucket],
        `${action} / ${bucket} must read MARKUP.other.${bucket}`,
      );
    }
  }
});

test('applyMarkup multiplies vendor cost by the per-action factor', () => {
  for (const bucket of BUCKETS) {
    const lessonFactor = PRICING_CONFIG.markup.lesson[bucket];
    const otherFactor = PRICING_CONFIG.markup.other[bucket];
    assert.equal(
      applyMarkup({ action: LESSON_ACTION, creditBucket: bucket, costMicroCents: 1_000 }),
      1_000 * lessonFactor,
    );
    assert.equal(
      applyMarkup({ action: OTHER_ACTION, creditBucket: bucket, costMicroCents: 1_000 }),
      1_000 * otherFactor,
    );
  }
});

test('applyMarkup of a zero cost is zero (no surprise charge on dedup-hit rows)', () => {
  for (const action of [LESSON_ACTION, OTHER_ACTION]) {
    for (const bucket of BUCKETS) {
      assert.equal(applyMarkup({ action, creditBucket: bucket, costMicroCents: 0 }), 0);
    }
  }
});

test('applyMarkup of a negative or NaN cost is zero (defensive)', () => {
  assert.equal(applyMarkup({ action: LESSON_ACTION, creditBucket: 'allowance', costMicroCents: -1 }), 0);
  assert.equal(applyMarkup({ action: LESSON_ACTION, creditBucket: 'allowance', costMicroCents: NaN }), 0);
});

test('applyMarkup returns an integer for fractional inputs', () => {
  // Math.round inside applyMarkup keeps the ledger field integer-clean.
  const factor = PRICING_CONFIG.markup.lesson.allowance;
  const charged = applyMarkup({ action: LESSON_ACTION, creditBucket: 'allowance', costMicroCents: 1.5 });
  assert.equal(Number.isInteger(charged), true);
  assert.equal(charged, Math.round(1.5 * factor));
});

test('top-up lesson markup is strictly greater than allowance lesson markup (subscribe-to-save)', () => {
  // The "subscribe to save" promise lives in this gap. If they're ever equal,
  // we've stopped charging the top-up tax that's supposed to push subscriptions.
  assert.ok(
    markupFor({ action: LESSON_ACTION, creditBucket: 'bonus' }) >
      markupFor({ action: LESSON_ACTION, creditBucket: 'allowance' }),
    'lesson bonus markup must be > lesson allowance markup',
  );
});

test('lesson:content markup is strictly greater than non-lesson markup (lesson is the premium product)', () => {
  for (const bucket of BUCKETS) {
    assert.ok(
      markupFor({ action: LESSON_ACTION, creditBucket: bucket }) >
        markupFor({ action: OTHER_ACTION, creditBucket: bucket }),
      `lesson:content markup (${bucket}) must exceed mentor:chat markup`,
    );
  }
});

// ── Done ──────────────────────────────────────────────────

