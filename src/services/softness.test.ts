/**
 * Self-executing tests for the softness heuristic + lesson-count hints.
 * Run: yarn test:softness
 *
 * Covers:
 *   - Every Phase-1 phrase fires on a representative answer
 *   - Every Phase-4 (2026-04-20 assessment) new phrase fires
 *   - FP-check positive/negative pairs for every category added in Phase 4
 *   - LESSON_COUNT_HINTS returns the tightened soft ceilings
 *   - Empty/missing answers → no softness
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  detectSoftnessHint,
  detectFinishPressure,
  getLessonCountHint,
  getEstimatedHoursRange,
  LESSON_COUNT_HINTS,
} from './softness';


const ans = (answer: string) => [{ questionId: 'q1', answer }];


// ── Baseline: no softness on empty / neutral answers ─────────

test('empty answers → no softness', () => {
  assert.equal(detectSoftnessHint({ answers: [] }).isSoft, false);
});

test('neutral answers → no softness', () => {
  const r = detectSoftnessHint({
    answers: [
      { questionId: 'q1', answer: 'I want to learn Kubernetes for my DevOps role.' },
      { questionId: 'q2', answer: 'Intermediate' },
    ],
  });
  assert.equal(r.isSoft, false);
  assert.deepEqual(r.cues, []);
});

// ── Phase 1 legacy phrases still work ────────────────────────

test('"just want to learn" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('i just want to learn some python') }).isSoft, true);
});

test('"easily overwhelmed" triggers softness (new phrase)', () => {
  assert.equal(detectSoftnessHint({ answers: ans('I get easily overwhelmed by long courses') }).isSoft, true);
});

test('"just exploring" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('Just exploring options for now') }).isSoft, true);
});

// ── Phase 4 new phrases: positive trigger ────────────────────

test('"not sure yet" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans("I'm not sure yet what direction to take") }).isSoft, true);
});

test('"thinking about" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('Thinking about switching careers') }).isSoft, true);
});

test('"can\'t commit" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans("I can't commit to a long curriculum right now") }).isSoft, true);
});

test('"moderately important" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('keigo is moderately important to me') }).isSoft, true);
});

test('"not a priority" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('Advanced algorithms are not a priority') }).isSoft, true);
});

test('"nice to have" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('Design patterns would be nice to have') }).isSoft, true);
});

test('"too much for me" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('a full deep-dive feels like too much for me') }).isSoft, true);
});

test('"part-time" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans("I'll be studying part-time around work") }).isSoft, true);
});

test('"on the side" triggers softness', () => {
  assert.equal(detectSoftnessHint({ answers: ans('Just something to learn on the side') }).isSoft, true);
});

// ── Phase 4 FP checks: legitimate uses DON'T trigger ─────────

test('"highly important" does NOT trigger (contrast with "moderately important")', () => {
  const r = detectSoftnessHint({ answers: ans('Type safety is highly important to me') });
  assert.equal(r.isSoft, false);
});

test('"critically important" does NOT trigger', () => {
  const r = detectSoftnessHint({ answers: ans('Performance is critically important for this app') });
  assert.equal(r.isSoft, false);
});

test('"busy industry" does NOT trigger ("busy" as adjective)', () => {
  const r = detectSoftnessHint({ answers: ans('I work in a busy industry with tight deadlines') });
  assert.equal(r.isSoft, false);
});

test('"too much detail" does NOT trigger ("too much" without anchor)', () => {
  const r = detectSoftnessHint({ answers: ans('I want a course with just enough detail, not too much detail in theory') });
  // "too much" by itself is not in the phrase list; only "too much for me" and "too much to".
  assert.equal(r.isSoft, false);
});

test('"thinking carefully" does NOT trigger ("thinking about" requires the preposition)', () => {
  const r = detectSoftnessHint({ answers: ans('Thinking carefully about which framework fits') });
  assert.equal(r.isSoft, false);
});

test('"sure enough" does NOT trigger ("not sure yet" requires the whole phrase)', () => {
  const r = detectSoftnessHint({ answers: ans('I was sure enough to pick Python over Ruby') });
  assert.equal(r.isSoft, false);
});

// ── Cue reporting ────────────────────────────────────────────

test('cues include every matched phrase (deduped)', () => {
  const r = detectSoftnessHint({
    answers: ans('I just want to learn the basics — nothing more, and part-time at that'),
  });
  assert.equal(r.isSoft, true);
  // Matches 'just want to learn' AND 'just the basics' AND 'part-time'
  assert.ok(r.cues.length >= 2, `expected ≥2 cues, got ${r.cues.length}: ${r.cues.join(' | ')}`);
});

test('cues are strings safe for prompt interpolation', () => {
  const r = detectSoftnessHint({ answers: ans("'; drop table users; --") });
  // The allowlist is the source of cues, not raw input. No injection reaches the prompt.
  assert.equal(r.isSoft, false);
  assert.deepEqual(r.cues, []);
});

// ── Case insensitivity ───────────────────────────────────────

test('case-insensitive matching', () => {
  assert.equal(detectSoftnessHint({ answers: ans('JUST EXPLORING') }).isSoft, true);
  assert.equal(detectSoftnessHint({ answers: ans('Not Sure Yet') }).isSoft, true);
});

// ── LESSON_COUNT_HINTS: tightened soft ceilings ──────────────

test('LESSON_COUNT_HINTS.overview soft band is tightened (Phase 4)', () => {
  const [min, max] = LESSON_COUNT_HINTS.overview.soft;
  assert.equal(min, 4);
  assert.equal(max, 8);
});

test('LESSON_COUNT_HINTS.comprehensive soft band is tightened (Phase 4)', () => {
  const [min, max] = LESSON_COUNT_HINTS.comprehensive.soft;
  assert.equal(min, 8);
  assert.equal(max, 16);
});

test('LESSON_COUNT_HINTS.deep_dive soft band is tightened (Phase 4)', () => {
  const [min, max] = LESSON_COUNT_HINTS.deep_dive.soft;
  assert.equal(min, 20);
  assert.equal(max, 32);
});

test('LESSON_COUNT_HINTS.normal bands are UNCHANGED', () => {
  assert.deepEqual(LESSON_COUNT_HINTS.overview.normal, [8, 14]);
  assert.deepEqual(LESSON_COUNT_HINTS.comprehensive.normal, [18, 28]);
  assert.deepEqual(LESSON_COUNT_HINTS.deep_dive.normal, [36, 56]);
});

test('getLessonCountHint returns soft band when isSoft=true', () => {
  assert.deepEqual(getLessonCountHint({ depth: 'comprehensive', isSoft: true }), [8, 16]);
});

test('getLessonCountHint returns normal band when isSoft=false', () => {
  assert.deepEqual(getLessonCountHint({ depth: 'comprehensive', isSoft: false }), [18, 28]);
});

// ── Regression tests for the three assessment failure cases ──

test('ella regression: "just exploring" in answer triggers softness', () => {
  const r = detectSoftnessHint({ answers: ans('just exploring personal finance options for now') });
  assert.equal(r.isSoft, true);
});

test('chloe regression: "easily overwhelmed" triggers softness', () => {
  const r = detectSoftnessHint({ answers: ans('I get easily overwhelmed when a course is too long') });
  assert.equal(r.isSoft, true);
});

test('david regression: "moderately important" triggers softness', () => {
  const r = detectSoftnessHint({ answers: ans('Mastering keigo is moderately important in my semi-formal workplace') });
  assert.equal(r.isSoft, true);
});

// ── Fix #1 (2026-04-21 assessment): finish-pressure detector ──

test('finish-pressure: empty answers → no pressure', () => {
  assert.equal(detectFinishPressure({ answers: [] }).isFinishPressure, false);
});

test('finish-pressure: Mike case "upcoming project at work"', () => {
  const r = detectFinishPressure({
    answers: ans('learn rust for upcoming project at work, already know c++'),
  });
  assert.equal(r.isFinishPressure, true);
  assert.ok(r.cues.length >= 1);
});

test('finish-pressure: "deadline" triggers', () => {
  const r = detectFinishPressure({ answers: ans('I have a deadline next week') });
  assert.equal(r.isFinishPressure, true);
});

test('finish-pressure: "tight timeline" triggers', () => {
  const r = detectFinishPressure({ answers: ans('Working on a tight timeline here') });
  assert.equal(r.isFinishPressure, true);
});

test('finish-pressure: neutral topic description does NOT trigger', () => {
  const r = detectFinishPressure({
    answers: ans('I want to learn Kubernetes for my DevOps role'),
  });
  assert.equal(r.isFinishPressure, false);
});

test('finish-pressure: "deadline-driven culture" DOES trigger (literal substring, accepted FP)', () => {
  // "deadline" alone is in the list; "deadline-driven culture" contains it.
  // This is an accepted false-positive trade-off — gate ack is cheap and the
  // broader false-positive rate guard is monitored in prod via metrics.
  const r = detectFinishPressure({ answers: ans('we have a deadline-driven culture here') });
  assert.equal(r.isFinishPressure, true);
});

test('finish-pressure: is separate signal from softness', () => {
  // Mike case — finish-pressure present but no softness cues.
  const a = ans('learn rust for upcoming project at work');
  assert.equal(detectSoftnessHint({ answers: a }).isSoft, false);
  assert.equal(detectFinishPressure({ answers: a }).isFinishPressure, true);
});

// ── Fix #1: estimated-hours range ─────────────────────────────

test('getEstimatedHoursRange: overview normal is ~4-6h', () => {
  const [lo, hi] = getEstimatedHoursRange({ depth: 'overview', isSoft: false });
  // [8, 14] lessons × 25 min = 200-350 min = ceil(3.33)-ceil(5.83) = 4-6 hours
  assert.equal(lo, 4);
  assert.equal(hi, 6);
});

test('getEstimatedHoursRange: comprehensive normal is ~8-12h', () => {
  const [lo, hi] = getEstimatedHoursRange({ depth: 'comprehensive', isSoft: false });
  // [18, 28] lessons × 25 min = 450-700 min = ceil(7.5)-ceil(11.67) = 8-12 hours
  assert.equal(lo, 8);
  assert.equal(hi, 12);
});

test('getEstimatedHoursRange: deep_dive normal is ~15-24h (Alex magnitude)', () => {
  const [lo, hi] = getEstimatedHoursRange({ depth: 'deep_dive', isSoft: false });
  // [36, 56] × 25 / 60 = 15-24 hours
  assert.equal(lo, 15);
  assert.equal(hi, 24);
});

test('getEstimatedHoursRange: soft band shrinks the range', () => {
  const soft = getEstimatedHoursRange({ depth: 'comprehensive', isSoft: true });
  const normal = getEstimatedHoursRange({ depth: 'comprehensive', isSoft: false });
  assert.ok(soft[1] < normal[1], 'soft max-hours must be smaller than normal max-hours');
});

test('getEstimatedHoursRange: min floor is at least 1h', () => {
  const [lo] = getEstimatedHoursRange({ depth: 'overview', isSoft: true });
  assert.ok(lo >= 1);
});

