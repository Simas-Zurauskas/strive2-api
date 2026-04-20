/**
 * Self-executing tests for the seeded PRNG.
 * Run: yarn test:prng
 */

import assert from 'node:assert/strict';
import { createPrng } from './prng';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
};

console.log('prng');

test('same seed → same sequence (determinism)', () => {
  const a = createPrng('seed-one');
  const b = createPrng('seed-one');
  for (let i = 0; i < 100; i++) {
    assert.equal(a.nextFloat(), b.nextFloat());
  }
});

test('different seeds → different sequences', () => {
  const a = createPrng('seed-one');
  const b = createPrng('seed-two');
  const seqA = Array.from({ length: 10 }, () => a.nextFloat());
  const seqB = Array.from({ length: 10 }, () => b.nextFloat());
  let sameCount = 0;
  for (let i = 0; i < seqA.length; i++) {
    if (seqA[i] === seqB[i]) sameCount += 1;
  }
  assert.ok(sameCount <= 1, `expected different sequences; got ${sameCount} matches`);
});

test('nextFloat returns values in [0, 1)', () => {
  const p = createPrng('bounds-test');
  for (let i = 0; i < 10_000; i++) {
    const v = p.nextFloat();
    assert.ok(v >= 0 && v < 1, `expected [0, 1); got ${v}`);
  }
});

test('nextBool(0.3) hits ~30% over 10k iterations', () => {
  const p = createPrng('bool-prob-test');
  let hits = 0;
  const n = 10_000;
  for (let i = 0; i < n; i++) {
    if (p.nextBool(0.3)) hits += 1;
  }
  const rate = hits / n;
  assert.ok(rate > 0.28 && rate < 0.32, `expected rate near 0.3, got ${rate.toFixed(3)}`);
});

test('nextBool(0) never fires; nextBool(1) always fires', () => {
  const p1 = createPrng('edge-0');
  const p2 = createPrng('edge-1');
  for (let i = 0; i < 100; i++) {
    assert.equal(p1.nextBool(0), false);
    assert.equal(p2.nextBool(1), true);
  }
});

test('nextInt(4) produces roughly uniform 0..3', () => {
  const p = createPrng('int-uniform-test');
  const buckets = [0, 0, 0, 0];
  const n = 10_000;
  for (let i = 0; i < n; i++) {
    const v = p.nextInt(4);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 4);
    buckets[v] += 1;
  }
  for (const b of buckets) {
    const rate = b / n;
    assert.ok(rate > 0.23 && rate < 0.27, `expected ~0.25, got ${rate.toFixed(3)}`);
  }
});

test('rejects empty seed string', () => {
  assert.throws(() => createPrng(''));
});

test('rejects non-positive nextInt bounds', () => {
  const p = createPrng('bounds-guard-test');
  assert.throws(() => p.nextInt(0));
  assert.throws(() => p.nextInt(-1));
  assert.throws(() => p.nextInt(1.5));
});

test('rejects out-of-range probability', () => {
  const p = createPrng('prob-guard-test');
  assert.throws(() => p.nextBool(-0.1));
  assert.throws(() => p.nextBool(1.1));
});

test('seeded PRNG is stateful within an instance', () => {
  const p = createPrng('stateful-test');
  const first = p.nextFloat();
  const second = p.nextFloat();
  assert.notEqual(first, second, 'consecutive calls should not return identical values');
});

console.log(`\n\u2713 prng: ${passed} test(s) passed`);
