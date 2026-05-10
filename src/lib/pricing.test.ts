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
  applyStaticMarkup,
  STATIC_MARKUP_FACTOR,
  STATIC_MARKUP_SERVICES,
} from './pricing';


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

// ── applyStaticMarkup ─────────────────────────────────────

test('applyStaticMarkup doubles cost for every marked service', () => {
  for (const service of STATIC_MARKUP_SERVICES) {
    assert.equal(
      applyStaticMarkup({ service, costMicroCents: 1_000 }),
      1_000 * STATIC_MARKUP_FACTOR,
      `${service} should be charged at ${STATIC_MARKUP_FACTOR}× vendor cost`,
    );
  }
});

test('applyStaticMarkup covers exactly the expected services', () => {
  // Pin the list — adding a service to the markup set is a deliberate billing
  // change and should require updating this assertion.
  assert.deepEqual(
    [...STATIC_MARKUP_SERVICES].sort(),
    ['bfl', 'jina', 'judge0', 'openai', 'pinecone', 'tavily', 'tts'],
  );
});

test('applyStaticMarkup leaves anthropic untouched', () => {
  assert.equal(applyStaticMarkup({ service: 'anthropic', costMicroCents: 1_234 }), 1_234);
});

test('applyStaticMarkup of a zero cost is zero (no surprise charge on dedup-hit rows)', () => {
  for (const service of STATIC_MARKUP_SERVICES) {
    assert.equal(applyStaticMarkup({ service, costMicroCents: 0 }), 0);
  }
});

test('applyStaticMarkup returns an integer for fractional inputs', () => {
  // Math.round inside applyStaticMarkup keeps the ledger field integer-clean.
  const charged = applyStaticMarkup({ service: 'tavily', costMicroCents: 1.5 });
  assert.equal(Number.isInteger(charged), true);
  assert.equal(charged, 3);
});

// ── Done ──────────────────────────────────────────────────

