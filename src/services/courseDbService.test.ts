/**
 * Tests for the slug-vs-ObjectId resolution in `getUserCourse` /
 * `getUserCourseLean`. The source comment at courseDbService.ts:42-50
 * documents a previously-shipped bug: a slug shaped like a 24-hex
 * ObjectId would be misrouted to findById WITHOUT a userId filter,
 * silently loading another user's course on a collision (or leaking
 * existence-timing).
 *
 * The tests below exercise both the regression scenario (slug shaped
 * like an ObjectId) AND the cross-user ownership boundary, since the
 * latter is the security-critical behavior the comment names.
 *
 * Audit gap: the file had ZERO direct tests prior. Adding these.
 *
 * Run: yarn test courseDbService
 */

import mongoose from 'mongoose';
import { describe, test, expect } from 'vitest';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, makeCourse } from '../../test-helpers/factories';
import { getUserCourse, getUserCourseLean } from '@services/courseDbService';

setupTestDb();

const HEX_ID_SHAPED_SLUG = 'aabbccddeeff112233445566';

describe('getUserCourse — slug-vs-ObjectId resolution', () => {
  test('looks up by slug first, scoped by userId', async () => {
    const user = await makeUser({});
    const course = await makeCourse({ userId: user._id, slug: 'my-course' });

    const found = await getUserCourse({ userId: user._id.toString(), courseId: 'my-course' });
    expect(found._id.toString()).toBe(course._id.toString());
  });

  test('falls back to _id lookup when courseId is 24-hex AND no slug match exists', async () => {
    const user = await makeUser({});
    const course = await makeCourse({ userId: user._id, slug: 'real-slug' });

    const found = await getUserCourse({
      userId: user._id.toString(),
      courseId: course._id.toString(),
    });
    expect(found._id.toString()).toBe(course._id.toString());
  });

  test('regression: slug shaped like an ObjectId resolves to the slug owner — does NOT misroute', async () => {
    // The historical bug: a course owned by user A with a slug like
    // "aabbccddeeff112233445566" would, when requested by user B with the
    // same string, get routed to findById(slug) and load user A's course
    // (since findById didn't gate on userId at all). The post-load
    // ownership check caught the leak, but the existence-timing was
    // already exposed.
    const userA = await makeUser({});
    const userB = await makeUser({});
    await makeCourse({ userId: userA._id, slug: HEX_ID_SHAPED_SLUG });
    // user B has no course with this slug at all.

    await expect(
      getUserCourse({ userId: userB._id.toString(), courseId: HEX_ID_SHAPED_SLUG }),
    ).rejects.toThrow('Course not found');
  });

  test('userId boundary: requesting another user\'s course by _id → not found', async () => {
    const userA = await makeUser({});
    const userB = await makeUser({});
    const courseA = await makeCourse({ userId: userA._id });

    await expect(
      getUserCourse({ userId: userB._id.toString(), courseId: courseA._id.toString() }),
    ).rejects.toThrow('Course not found');
  });

  test('two users with the same slug → each only sees their own course', async () => {
    // Slugs are per-user-unique (per CourseModel index), but the same
    // string can exist for two different users. Verify the lookup
    // doesn't cross-contaminate.
    const userA = await makeUser({});
    const userB = await makeUser({});
    const courseA = await makeCourse({ userId: userA._id, slug: 'my-course' });
    const courseB = await makeCourse({ userId: userB._id, slug: 'my-course' });

    const foundA = await getUserCourse({ userId: userA._id.toString(), courseId: 'my-course' });
    const foundB = await getUserCourse({ userId: userB._id.toString(), courseId: 'my-course' });

    expect(foundA._id.toString()).toBe(courseA._id.toString());
    expect(foundB._id.toString()).toBe(courseB._id.toString());
  });

  test('non-hex non-slug lookup → not found (no fallback to findById)', async () => {
    const user = await makeUser({});
    await expect(
      getUserCourse({ userId: user._id.toString(), courseId: 'nonexistent' }),
    ).rejects.toThrow('Course not found');
  });

  test('bogus ObjectId (24-hex but not in DB) → not found, no leak', async () => {
    const user = await makeUser({});
    const stranger = new mongoose.Types.ObjectId().toString();
    await expect(
      getUserCourse({ userId: user._id.toString(), courseId: stranger }),
    ).rejects.toThrow('Course not found');
  });
});

describe('getUserCourseLean — same boundary, .lean() variant', () => {
  test('slug-first; userId-scoped', async () => {
    const user = await makeUser({});
    const course = await makeCourse({ userId: user._id, slug: 'lean-course' });
    const found = await getUserCourseLean({
      userId: user._id.toString(),
      courseId: 'lean-course',
    });
    expect(found._id.toString()).toBe(course._id.toString());
    // lean() returns a plain object, not a hydrated document; .save would
    // not exist on it.
    expect((found as unknown as Record<string, unknown>).save).toBeUndefined();
  });

  test('regression: slug shaped like an ObjectId for foreign user → not found', async () => {
    const userA = await makeUser({});
    const userB = await makeUser({});
    await makeCourse({ userId: userA._id, slug: HEX_ID_SHAPED_SLUG });
    await expect(
      getUserCourseLean({ userId: userB._id.toString(), courseId: HEX_ID_SHAPED_SLUG }),
    ).rejects.toThrow('Course not found');
  });
});
