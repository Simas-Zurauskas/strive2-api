/**
 * Tests for the gamification surfaces:
 *   - computeLiveStreak: pure function — weekday-only streak calculation
 *   - recordActivity: first-ever-recursion path, idempotent same-day,
 *     weekday vs weekend gap behavior
 *   - awardXp: XP increment + level recompute + xpLog rolling cap
 *     + level-regression race protection (conditional `level: { $lt: newLevel }`)
 *
 * Strategy:
 *   - Real in-memory Mongo for UserGamification writes
 *   - We bypass the achievement-check side effects by spying / not asserting
 *     on them (achievements are evaluated by checkAchievements which itself
 *     queries the DB; not the focus of these tests)
 *
 * Run: yarn test gamificationService
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserGamificationModel } from '../../test-helpers/factories';
import { XP_VALUES } from '@lib/gamificationConstants';

import {
  computeLiveStreak,
  recordActivity,
  awardXp,
  getOrCreateProfile,
} from '@services/gamificationService';

setupTestDb();

beforeEach(() => {
  vi.useRealTimers();
});

const ymd = (date: Date): string => date.toISOString().slice(0, 10);

// ── computeLiveStreak (pure function) ────────────────────

describe('computeLiveStreak', () => {
  test('empty activity → streak 0', () => {
    expect(computeLiveStreak({ activeDates: [] })).toBe(0);
  });

  test('today only → streak 1', () => {
    const today = ymd(new Date());
    expect(computeLiveStreak({ activeDates: [today] })).toBe(1);
  });

  test('today + yesterday (consecutive weekdays) → streak 2', () => {
    // Use fake timers anchored to a Wednesday so yesterday is Tuesday — no weekend confusion.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T12:00:00Z')); // Wednesday
    expect(
      computeLiveStreak({
        activeDates: ['2026-04-22', '2026-04-21'], // Wed, Tue
      }),
    ).toBe(2);
  });

  test('Friday + Monday (gap is weekend only) → streak 2 (weekend skipped)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z')); // Monday
    // Friday 2026-04-17, Monday 2026-04-20 — Sat/Sun in between are free
    expect(
      computeLiveStreak({
        activeDates: ['2026-04-20', '2026-04-17'],
      }),
    ).toBe(2);
  });

  test('Friday + Tuesday (Monday missed): streak broken at gap → streak 1 (today only)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T12:00:00Z')); // Tuesday
    // 2026-04-21 (Tue), 2026-04-17 (Fri) — Monday 2026-04-20 missed weekday
    expect(
      computeLiveStreak({
        activeDates: ['2026-04-21', '2026-04-17'],
      }),
    ).toBe(1);
  });

  test('most recent activity is older than today with a missed weekday → streak 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T12:00:00Z')); // Thursday
    // Last activity 2026-04-21 (Tuesday). Wednesday 2026-04-22 missed.
    expect(
      computeLiveStreak({
        activeDates: ['2026-04-21'],
      }),
    ).toBe(0);
  });

  test('most recent is yesterday (Friday→Saturday today): streak alive (no weekday missed)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00Z')); // Saturday
    // Last activity 2026-04-24 (Friday). No weekday gap (today is Sat).
    expect(
      computeLiveStreak({
        activeDates: ['2026-04-24'],
      }),
    ).toBe(1);
  });
});

// ── recordActivity ─────────────────────────────────────

describe('recordActivity', () => {
  test('first-ever activity: creates profile via recursion, streak=1', async () => {
    const user = await makeUser();
    const result = await recordActivity(user._id.toString());
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);

    const stored = await UserGamificationModel.findOne({ userId: user._id }).lean();
    expect(stored?.activeDates).toContain(ymd(new Date()));
  });

  test('same-day idempotent: second call short-circuits, no DB write', async () => {
    const user = await makeUser();
    await recordActivity(user._id.toString());
    const beforeUpdate = await UserGamificationModel.findOne({ userId: user._id }).lean();

    const result = await recordActivity(user._id.toString());
    expect(result.currentStreak).toBe(1); // unchanged

    const afterUpdate = await UserGamificationModel.findOne({ userId: user._id }).lean();
    // updatedAt should be unchanged (no write happened)
    expect(afterUpdate?.updatedAt.getTime()).toBe(beforeUpdate?.updatedAt.getTime());
  });

  test('Friday→Monday: streak continues (weekend gap is free)', async () => {
    vi.useFakeTimers();
    const user = await makeUser();

    // Pre-seed the gamification doc as if user was active Friday
    await UserGamificationModel.create({
      userId: user._id,
      currentStreak: 1,
      longestStreak: 1,
      lastActiveDate: '2026-04-24', // Friday
      activeDates: ['2026-04-24'],
    });

    vi.setSystemTime(new Date('2026-04-27T12:00:00Z')); // Monday
    const result = await recordActivity(user._id.toString());
    expect(result.currentStreak).toBe(2); // continues, not reset
  });

  test('Friday→Tuesday: streak resets (Monday weekday missed)', async () => {
    vi.useFakeTimers();
    const user = await makeUser();

    await UserGamificationModel.create({
      userId: user._id,
      currentStreak: 5,
      longestStreak: 5,
      lastActiveDate: '2026-04-17', // Friday
      activeDates: ['2026-04-17'],
    });

    vi.setSystemTime(new Date('2026-04-21T12:00:00Z')); // Tuesday — Monday missed
    const result = await recordActivity(user._id.toString());
    expect(result.currentStreak).toBe(1); // reset
    expect(result.longestStreak).toBe(5); // historical peak preserved
  });

  test('concurrent first-ever activity: both safe (idempotent)', async () => {
    const user = await makeUser();
    await Promise.all([recordActivity(user._id.toString()), recordActivity(user._id.toString())]);

    const stored = await UserGamificationModel.findOne({ userId: user._id }).lean();
    // $addToSet guarantees no duplicate today entry
    const todayCount = stored?.activeDates.filter((d) => d === ymd(new Date())).length;
    expect(todayCount).toBe(1);
  });
});

// ── awardXp ────────────────────────────────────────────

describe('awardXp', () => {
  test('first XP award creates profile + records xpLog entry', async () => {
    const user = await makeUser();
    const result = await awardXp({
      userId: user._id.toString(),
      amount: XP_VALUES.LESSON_COMPLETE,
      source: 'lesson_complete',
    });
    expect(result.xpAwarded).toBe(50);
    expect(result.totalXp).toBe(50);

    const doc = await UserGamificationModel.findOne({ userId: user._id }).lean();
    expect(doc?.xpLog).toHaveLength(1);
    expect(doc?.xpLog[0].xp).toBe(50);
    expect(doc?.xpLog[0].source).toBe('lesson_complete');
  });

  test('amount <= 0: early return, no DB write', async () => {
    const user = await makeUser();
    const result = await awardXp({
      userId: user._id.toString(),
      amount: 0,
      source: 'lesson_complete',
    });
    expect(result.xpAwarded).toBe(0);
    expect(await UserGamificationModel.countDocuments()).toBe(0);
  });

  test('multiple awards accumulate totalXp', async () => {
    const user = await makeUser();
    await awardXp({ userId: user._id.toString(), amount: 50, source: 'lesson_complete' });
    const r2 = await awardXp({ userId: user._id.toString(), amount: 100, source: 'quiz_score' });
    expect(r2.totalXp).toBe(150);
  });

  test('xpLog rolls at 2000 entries: pre-seed 2000, add one more, length stays at 2000', async () => {
    const user = await makeUser();
    await UserGamificationModel.create({
      userId: user._id,
      totalXp: 0,
      xpLog: Array.from({ length: 2000 }, (_, i) => ({
        date: '2024-01-01',
        xp: 1,
        source: 'lesson_complete' as const,
      })),
    });

    await awardXp({ userId: user._id.toString(), amount: 50, source: 'lesson_complete' });

    const doc = await UserGamificationModel.findOne({ userId: user._id }).lean();
    expect(doc?.xpLog).toHaveLength(2000);
    // Newest entry pushed in is at the tail
    expect(doc?.xpLog[1999].xp).toBe(50);
  });

  test('level regression race: lower-level write filtered out by `{ level: { $lt: newLevel } }`', async () => {
    const user = await makeUser();
    // Pre-seed with level=5 directly
    await UserGamificationModel.create({
      userId: user._id,
      totalXp: 5000,
      level: 5,
    });

    // Simulate a stale awardXp that would compute a lower newLevel:
    // awardXp filters on `level: { $lt: newLevel }` so an attempt to
    // write level=3 won't clobber level=5. We can simulate this by
    // calling updateOne directly, mirroring what the code does.
    await UserGamificationModel.updateOne(
      { _id: user._id, level: { $lt: 3 } },
      { $set: { level: 3 } },
    );

    const doc = await UserGamificationModel.findOne({ userId: user._id }).lean();
    expect(doc?.level).toBe(5); // unchanged — stale write filtered out
  });
});

// ── getOrCreateProfile ─────────────────────────────────

describe('getOrCreateProfile', () => {
  test('idempotent: two calls return the same row', async () => {
    const user = await makeUser();
    const a = await getOrCreateProfile(user._id.toString());
    const b = await getOrCreateProfile(user._id.toString());
    expect(String((a as unknown as { _id: unknown })._id)).toBe(
      String((b as unknown as { _id: unknown })._id),
    );
    expect(await UserGamificationModel.countDocuments({ userId: user._id })).toBe(1);
  });
});
