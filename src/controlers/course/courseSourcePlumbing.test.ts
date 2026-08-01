/**
 * Course-from-documents plumbing tests (Phase 1):
 *  - createCourseSchema: optional `source`; goal required unless
 *    source === 'documents'.
 *  - createCourseController: persists `source` and sets the server-side
 *    placeholder goal for document courses; goal-based path unchanged.
 *  - updateCourseSchema/-Controller: `sourceFidelity` accepted and
 *    persisted on document courses, rejected on goal courses.
 *  - A9 daily cap: ≤5 documents courses / user / trailing 24h
 *    (400 DOCUMENT_LIMIT_EXCEEDED); goal-based creation never capped.
 *
 * Run: yarn test courseSourcePlumbing
 */

import { describe, test, expect } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { createCourseSchema, updateCourseSchema } from './validation';
import { createCourseController } from './createCourse';
import { updateCourseController } from './updateCourse';
import CourseModel from '@models/CourseModel';
import { AppError } from '@middleware/errorMiddleware';
import { DOCUMENTS_PLACEHOLDER_GOAL, MAX_DOC_COURSES_PER_USER_PER_DAY } from '@lib/constants';

setupTestDb();

// ── Schema level ───────────────────────────────────────────

describe('createCourseSchema', () => {
  test('goal-only body parses exactly as before', () => {
    const parsed = createCourseSchema.parse({ goal: 'Learn woodworking' });
    expect(parsed.goal).toBe('Learn woodworking');
    expect(parsed.source).toBeUndefined();
  });

  test('empty body still rejects on goal', () => {
    const result = createCourseSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['goal']);
    }
  });

  test('empty-string goal still rejects with the original message', () => {
    const result = createCourseSchema.safeParse({ goal: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Goal is required');
    }
  });

  test('oversized goal still rejects', () => {
    const result = createCourseSchema.safeParse({ goal: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });

  test('source documents without goal parses', () => {
    const parsed = createCourseSchema.parse({ source: 'documents' });
    expect(parsed.source).toBe('documents');
    expect(parsed.goal).toBeUndefined();
  });

  test('source documents with a goal keeps the goal', () => {
    const parsed = createCourseSchema.parse({ source: 'documents', goal: 'From my notes' });
    expect(parsed.goal).toBe('From my notes');
  });

  test('unknown source value rejects', () => {
    expect(createCourseSchema.safeParse({ source: 'telepathy' }).success).toBe(false);
  });
});

describe('updateCourseSchema', () => {
  test('accepts a valid sourceFidelity', () => {
    const parsed = updateCourseSchema.parse({ sourceFidelity: 'strict' });
    expect(parsed.sourceFidelity).toBe('strict');
  });

  test('rejects an unknown sourceFidelity', () => {
    expect(updateCourseSchema.safeParse({ sourceFidelity: 'vibes' }).success).toBe(false);
  });

  test('existing update bodies parse unchanged', () => {
    const parsed = updateCourseSchema.parse({ goal: 'New goal', depth: 'overview' });
    expect(parsed).toMatchObject({ goal: 'New goal', depth: 'overview' });
    expect(parsed.sourceFidelity).toBeUndefined();
  });
});

// ── Controller level ───────────────────────────────────────

describe('createCourseController', () => {
  test('goal-based create is byte-identical: persists goal, source stays null', async () => {
    const user = await makeUser();
    const { req, res, status, json } = buildReqRes({
      body: { goal: 'Learn pottery' },
      userId: user._id.toString(),
    });
    await invokeController(createCourseController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0][0] as { data: { courseId: string } };
    expect(payload.data.courseId).toBeDefined();
    const course = await CourseModel.findById(payload.data.courseId).lean();
    expect(course?.goal).toBe('Learn pottery');
    expect(course?.source ?? null).toBeNull();
  });

  test('source documents create persists source and sets the placeholder goal', async () => {
    const user = await makeUser();
    const { req, res, json } = buildReqRes({
      body: { source: 'documents' },
      userId: user._id.toString(),
    });
    await invokeController(createCourseController, req, res);
    const payload = json.mock.calls[0][0] as { data: { courseId: string } };
    const course = await CourseModel.findById(payload.data.courseId).lean();
    expect(course?.source).toBe('documents');
    expect(course?.goal).toBe(DOCUMENTS_PLACEHOLDER_GOAL);
  });

  test('source documents create with an explicit goal keeps that goal', async () => {
    const user = await makeUser();
    const { req, res, json } = buildReqRes({
      body: { source: 'documents', goal: 'Master my lecture notes' },
      userId: user._id.toString(),
    });
    await invokeController(createCourseController, req, res);
    const payload = json.mock.calls[0][0] as { data: { courseId: string } };
    const course = await CourseModel.findById(payload.data.courseId).lean();
    expect(course?.source).toBe('documents');
    expect(course?.goal).toBe('Master my lecture notes');
  });

  // ── A9: ≤5 doc-courses / user / day ──────────────────────

  const createDocsCourse = async (userId: string) => {
    const { req, res } = buildReqRes({ body: { source: 'documents' }, userId });
    await invokeController(createCourseController, req, res);
  };

  test(`daily cap: the ${MAX_DOC_COURSES_PER_USER_PER_DAY + 1}th documents course in 24h is a 400 DOCUMENT_LIMIT_EXCEEDED with meta`, async () => {
    const user = await makeUser();
    for (let i = 0; i < MAX_DOC_COURSES_PER_USER_PER_DAY; i++) {
      await createDocsCourse(user._id.toString());
    }

    const { req, res } = buildReqRes({ body: { source: 'documents' }, userId: user._id.toString() });
    let thrown: unknown;
    try {
      await invokeController(createCourseController, req, res);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).errorCode).toBe('DOCUMENT_LIMIT_EXCEEDED');
    expect((thrown as AppError).statusCode).toBe(400);
    expect((thrown as AppError).meta).toMatchObject({ limit: MAX_DOC_COURSES_PER_USER_PER_DAY });
  });

  test('doc-courses older than 24h do not count toward the daily cap', async () => {
    const user = await makeUser();
    for (let i = 0; i < MAX_DOC_COURSES_PER_USER_PER_DAY; i++) {
      await createDocsCourse(user._id.toString());
    }
    // Backdate them beyond the window (timestamps:true stamps createdAt=now).
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await CourseModel.collection.updateMany(
      { userId: user._id, source: 'documents' },
      { $set: { createdAt: old } },
    );

    const { req, res, status } = buildReqRes({ body: { source: 'documents' }, userId: user._id.toString() });
    await invokeController(createCourseController, req, res);
    expect(status).toHaveBeenCalledWith(200);
  });

  test('goal-based creation is never capped by the doc-course daily limit', async () => {
    const user = await makeUser();
    for (let i = 0; i < MAX_DOC_COURSES_PER_USER_PER_DAY; i++) {
      await createDocsCourse(user._id.toString());
    }

    const { req, res, status } = buildReqRes({ body: { goal: 'Learn pottery' }, userId: user._id.toString() });
    await invokeController(createCourseController, req, res);
    expect(status).toHaveBeenCalledWith(200);
  });

  test("another user's doc courses do not count toward the cap", async () => {
    const heavyUser = await makeUser();
    for (let i = 0; i < MAX_DOC_COURSES_PER_USER_PER_DAY; i++) {
      await createDocsCourse(heavyUser._id.toString());
    }

    const freshUser = await makeUser();
    const { req, res, status } = buildReqRes({ body: { source: 'documents' }, userId: freshUser._id.toString() });
    await invokeController(createCourseController, req, res);
    expect(status).toHaveBeenCalledWith(200);
  });
});

describe('updateCourseController — sourceFidelity', () => {
  const makeDocumentsCourse = async (userId: string) =>
    CourseModel.create({
      userId,
      goal: DOCUMENTS_PLACEHOLDER_GOAL,
      source: 'documents',
      status: 'creating',
    });

  test('persists sourceFidelity on a documents course', async () => {
    const user = await makeUser();
    const course = await makeDocumentsCourse(user._id.toString());
    const { req, res, status } = buildReqRes({
      body: { sourceFidelity: 'strict' },
      userId: user._id.toString(),
      params: { id: course._id.toString() },
    });
    await invokeController(updateCourseController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    const updated = await CourseModel.findById(course._id).lean();
    expect(updated?.sourceFidelity).toBe('strict');
  });

  test('rejects sourceFidelity on a goal-based course with a 400', async () => {
    const user = await makeUser();
    const course = await CourseModel.create({
      userId: user._id.toString(),
      goal: 'Learn pottery',
      status: 'creating',
    });
    const { req, res } = buildReqRes({
      body: { sourceFidelity: 'guided' },
      userId: user._id.toString(),
      params: { id: course._id.toString() },
    });
    const err = await invokeController(updateCourseController, req, res).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeTruthy();
    expect((err as { statusCode?: number }).statusCode).toBe(400);
    const updated = await CourseModel.findById(course._id).lean();
    expect(updated?.sourceFidelity ?? null).toBeNull();
  });

  test('a plain goal PATCH on a goal course behaves as before', async () => {
    const user = await makeUser();
    const course = await CourseModel.create({
      userId: user._id.toString(),
      goal: 'Learn pottery',
      status: 'creating',
    });
    const { req, res, status } = buildReqRes({
      body: { goal: 'Learn advanced pottery' },
      userId: user._id.toString(),
      params: { id: course._id.toString() },
    });
    await invokeController(updateCourseController, req, res);
    expect(status).toHaveBeenCalledWith(200);
    const updated = await CourseModel.findById(course._id).lean();
    expect(updated?.goal).toBe('Learn advanced pottery');
  });
});
