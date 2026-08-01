/**
 * `executeJob`'s DISPATCH surface — not generation.
 *
 * The production bug this file exists to prevent: a new `JOB_TYPE` added to
 * `JOB_TYPES` (and therefore accepted by `submitJob`, and stored on a Job
 * row) with no matching `case` in `executeJob`'s switch. The first real user
 * to trigger it gets a job that fails with `Unknown job type` after their
 * credits pre-flight has already passed — or, if the `default` throw were
 * ever removed, a job that silently reports "completed" having done nothing.
 *
 * PLAN Phase 8 closes the *primary* version of this at COMPILE time: the
 * `type` parameter is `JobType`, and `default` assigns it to `never`, so a
 * missing `case` fails `yarn tsc` on the developer's machine before any test
 * runs. This file is the belt behind that brace, and it covers the two
 * things the compiler cannot:
 *
 *   1. a Job row written by an OLDER deploy, a migration, or by hand, whose
 *      `type` string is not in today's union — no type system sees that
 *      value, and it must still fail loudly at runtime; and
 *   2. someone widening the parameter back to `string`, which would silently
 *      remove the compile-time guarantee with no test failing.
 *
 * Every case here throws before any agent is reached, so no agent module
 * needs mocking and nothing in this file calls an LLM.
 *
 * Run: yarn test jobRunner.executeJob
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse } from '../../test-helpers/factories';
import { executeJob } from '@services/jobRunner';
import { JOB_TYPES, type JobType } from '@lib/constants';

setupTestDb();

const SOURCE = readFileSync(path.resolve(__dirname, 'jobRunner.ts'), 'utf-8');

describe('executeJob — the runtime belt', () => {
  test('a job type that is not in the union throws "Unknown job type" and does NOT silently return', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id });

    // The cast is the point of the test, not a workaround: it simulates a
    // Job row persisted by an older deploy carrying a string today's union
    // does not contain. No type system can see that value.
    const staleType = 'generate_podcast' as unknown as JobType;

    await expect(
      executeJob({
        jobId: new mongoose.Types.ObjectId().toString(),
        userId: user._id.toString(),
        courseId: course._id.toString(),
        type: staleType,
        metadata: null,
      }),
    ).rejects.toThrow(/Unknown job type/);
  });

  test('a missing course throws "Course not found" BEFORE the switch is reached', async () => {
    const user = await makeUser();

    await expect(
      executeJob({
        jobId: new mongoose.Types.ObjectId().toString(),
        userId: user._id.toString(),
        courseId: new mongoose.Types.ObjectId().toString(),
        type: 'clarify',
        metadata: null,
      }),
    ).rejects.toThrow('Course not found');
  });

  test('the unknown-type throw happens AFTER the course lookup — the two failures are distinguishable', async () => {
    // Ordering matters for triage: "Unknown job type" on a course that does
    // not exist would be a misleading error to page on.
    const user = await makeUser();
    await expect(
      executeJob({
        jobId: new mongoose.Types.ObjectId().toString(),
        userId: user._id.toString(),
        courseId: new mongoose.Types.ObjectId().toString(),
        type: 'generate_podcast' as unknown as JobType,
        metadata: null,
      }),
    ).rejects.toThrow('Course not found');
  });
});

describe('executeJob — the compile-time brace, made visible', () => {
  test.each(JOB_TYPES)('JOB_TYPES member %s has a `case` label in jobRunner.ts', (jobType) => {
    expect(SOURCE).toContain(`case '${jobType}':`);
  });

  test('there are exactly as many case labels in the switch as there are JOB_TYPES', () => {
    const caseLabels = [...SOURCE.matchAll(/^\s{4}case '([a-z_]+)':/gm)].map((m) => m[1]);
    expect([...caseLabels].sort()).toEqual([...JOB_TYPES].sort());
    // No duplicates: a repeated label is dead code the compiler will not flag.
    expect(new Set(caseLabels).size).toBe(caseLabels.length);
  });

  test('the `type` parameter is JobType, not string — widening it back would silently disarm `yarn tsc`', () => {
    expect(SOURCE).toContain('type: JobType; metadata?: Record<string, unknown> | null');
    expect(SOURCE).not.toContain('courseId: string; type: string;');
  });

  test('the default branch still carries the `never` exhaustiveness assert AND the runtime throw', () => {
    expect(SOURCE).toContain('const unhandled: never = type;');
    expect(SOURCE).toContain('throw new Error(`Unknown job type:');
  });
});
