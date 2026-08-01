/**
 * `courseRoutes` wiring, over REAL HTTP against the REAL router.
 *
 * Four production bugs this file exists to prevent, none of which any
 * controller-level test can see because they all live in the router:
 *
 *   1. **The router-wide gate dropped.** `router.use(protect, requireVerified,
 *      usageContextMiddleware)` guards 51 routes at once. Remove it and every
 *      course, lesson body, chat transcript and quiz result in the system is
 *      readable by an anonymous caller with a guessed ObjectId.
 *   2. **A static path registered after the parameterised one it collides
 *      with.** `GET /continue`, `/favorites`, `/reviews-due` … all sit above
 *      `GET /:id`. Move any of them below and Express matches `/:id` first:
 *      the endpoint stops 404ing (so no alarm fires) and instead answers with
 *      *the course-fetch handler*, which returns "course not found" for a URL
 *      that has nothing to do with a course id.
 *   3. **`validateObjectId('jobId')` dropped.** `GET /course/job/garbage`
 *      then reaches Mongoose with an uncastable id and 500s — a client bug
 *      reported as a server outage, and a Sentry 5xx that is not a bug.
 *   4. **`requireCredits()` dropped from a paid endpoint.** The gate is a
 *      single "balance ≥ 1" pre-flight; without it a user at zero balance
 *      starts an LLM/image/TTS job whose real vendor cost is debited *after*
 *      completion — i.e. unbounded free spend, one job at a time, forever.
 *
 * Method: `@controlers/course` is replaced with 204 sentinels that record
 * WHICH controller was reached — that recording is what makes the
 * static-before-parameterised assertions possible at all, since every route
 * would otherwise answer an indistinguishable 204. Nothing here calls an LLM,
 * Judge0, S3 or Pinecone. The middleware chain (`protect`, `requireVerified`,
 * `usageContextMiddleware`, `validateObjectId`, `requireCredits`,
 * `limitChatStreamConcurrency`, the rate limiter) is entirely REAL — it is
 * the subject under test.
 *
 * Run: yarn test courseRoutes.wiring
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
// Imported statically (not via `await import()` inside the factory): a
// dynamic relative import needs an explicit extension under NodeNext and
// `yarn tsc` rejects it. This module is evaluated before the router import
// below, so the lazy `vi.mock` factory sees it initialised.
import { sentinelControllers } from '../../test-helpers/routeSentinels';
import mongoose from 'mongoose';

const log = vi.hoisted(() => ({ hits: [] as string[] }));

vi.mock('@controlers/course', () => sentinelControllers(log, [
  'createCourseController',
  'listCoursesController',
  'getCourseController',
  'updateCourseController',
  'clarifyCourseController',
  'generateStructureController',
  'refineStructureController',
  'deleteCourseController',
  'generateDepthPreviewsController',
  'getJobStatusController',
  'generateLessonController',
  'regenerateHeroController',
  'regenerateLinksController',
  'regenerateRecallController',
  'executeCodeController',
  'getLessonContentController',
  'getLessonContentStatsController',
  'chatStreamController',
  'getChatHistoryController',
  'upsertLessonProgressController',
  'getCourseProgressController',
  'getContinueLearningController',
  'getGeneratedLessonsController',
  'getProgressSummaryController',
  'generateModuleQuizController',
  'getModuleQuizContentController',
  'submitQuizAttemptController',
  'getModuleQuizProgressController',
  'getReviewsDueController',
  'getUnattemptedQuizCountController',
  'getEditImpactController',
  'resetModuleQuizController',
  'toggleFavoriteCourseController',
  'getFavoriteCourseIdsController',
  'getBookmarkedLessonsController',
  'getRecentActivityController',
  'generateLessonNarrationController',
  'deleteLessonNarrationController',
  'getNarrationVoicesController',
  'lessonChatController',
  'getLessonChatHistoryController',
  'clearLessonChatController',
  'lessonAttachController',
  'uploadDocumentController',
  'addUrlDocumentController',
  'listDocumentsController',
  'deleteDocumentController',
  'ingestDocumentsController',
  'prepareCorpusController',
  'courseMentorChatController',
  'getCourseMentorHistoryController',
  'clearCourseMentorController',
  ]));

import { courseRoutes } from '@routes/courseRoutes';
import { protect, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { makeTestApp } from '../../test-helpers/app';
import { startTestServer, authHeaderFor, req as httpFor, type TestServer } from '../../test-helpers/http';

setupTestDb();

const OID = () => new mongoose.Types.ObjectId().toString();

let app: Express;
let server: TestServer;
let http: ReturnType<typeof httpFor>;

/** Verified user with a real, non-expired free period holding ZERO credits. */
const zeroBalanceUser = async () => {
  const now = new Date();
  return makeUser({
    emailVerified: true,
    credits: {
      allowanceBalance: 0,
      allowanceGranted: 0,
      bonusBalance: 0,
      periodStart: now,
      // Deliberately in the FUTURE: an expired free period would trigger
      // `applyFreePeriodReset` inside `getBalance` and silently hand the
      // user a fresh allowance, turning every 402 assertion below into a
      // 204 for a reason that has nothing to do with the gate.
      periodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    },
  });
};

/** Verified user carrying the default free-plan allowance (> 0). */
const fundedUser = async () => {
  const user = await makeUser({ emailVerified: true });
  const row = await UserModel.findById(user._id).select('credits').lean();
  // Precondition, asserted rather than assumed: the "not credit-gated"
  // cases below prove nothing if the arrange step produced a zero balance.
  expect((row?.credits.allowanceBalance ?? 0) + (row?.credits.bonusBalance ?? 0)).toBeGreaterThan(0);
  return user;
};

beforeAll(async () => {
  app = makeTestApp({ mount: { '/api/course': courseRoutes } });
  server = await startTestServer(app);
  http = httpFor(server.base);
});

beforeEach(() => {
  log.hits.length = 0;
});

afterAll(async () => {
  await server.close();
});

// ── The router-wide gate ────────────────────────────────

describe('courseRoutes — the router-wide protect → requireVerified gate', () => {
  const SAMPLE = [
    { method: 'get', path: '/' },
    { method: 'post', path: '/' },
    { method: 'get', path: '/continue' },
    { method: 'get', path: `/${OID()}` },
    { method: 'post', path: `/${OID()}/generate-lesson` },
    { method: 'delete', path: `/${OID()}` },
  ] as const;

  test.each(SAMPLE)('$method $path 401s with no Authorization header', async ({ method, path }) => {
    const url = `/api/course${path}`;
    const res =
      method === 'get' ? await http.get(url) : method === 'delete' ? await http.del(url) : await http.post(url, { body: {} });
    expect(res.status).toBe(401);
    expect(log.hits).toEqual([]);
  });

  test('an UNVERIFIED credentials user gets 403 EMAIL_NOT_VERIFIED, not 401 (a 401 would sign them out)', async () => {
    const user = await makeUser({ emailVerified: false });
    const res = await http.get('/api/course/', { headers: authHeaderFor(user) });
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.json?.errorCode).toBe('EMAIL_NOT_VERIFIED');
    expect(log.hits).toEqual([]);
  });

  test('harness sanity: a verified user reaches the controller on the same route', async () => {
    const user = await fundedUser();
    const res = await http.get('/api/course/', { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['listCoursesController']);
  });

  test('the gate layers are registered before every route, in order protect → requireVerified → usageContext', () => {
    const stack = (courseRoutes as unknown as { stack: { route?: unknown; handle: unknown }[] }).stack;
    const firstRouteIdx = stack.findIndex((l) => l.route);
    const idx = (fn: unknown) => stack.findIndex((l) => !l.route && l.handle === fn);
    expect(idx(protect)).toBeGreaterThanOrEqual(0);
    expect(idx(protect)).toBeLessThan(idx(requireVerified));
    expect(idx(requireVerified)).toBeLessThan(idx(usageContextMiddleware));
    expect(idx(usageContextMiddleware)).toBeLessThan(firstRouteIdx);
  });
});

// ── Static before parameterised ─────────────────────────

describe('courseRoutes — static paths are not swallowed by GET /:id', () => {
  const STATIC_GETS = [
    { path: '/continue', controller: 'getContinueLearningController' },
    { path: '/progress-summary', controller: 'getProgressSummaryController' },
    { path: '/reviews-due', controller: 'getReviewsDueController' },
    { path: '/unattempted-quiz-count', controller: 'getUnattemptedQuizCountController' },
    { path: '/favorites', controller: 'getFavoriteCourseIdsController' },
    { path: '/bookmarked-lessons', controller: 'getBookmarkedLessonsController' },
    { path: '/recent-activity', controller: 'getRecentActivityController' },
    { path: '/narration-voices', controller: 'getNarrationVoicesController' },
  ] as const;

  test.each(STATIC_GETS)('GET $path resolves to $controller, NOT getCourseController', async ({ path, controller }) => {
    const user = await fundedUser();
    const res = await http.get(`/api/course${path}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual([controller]);
    expect(log.hits).not.toContain('getCourseController');
  });

  test('GET /job/:jobId resolves to getJobStatusController, not getCourseController', async () => {
    const user = await fundedUser();
    const res = await http.get(`/api/course/job/${OID()}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['getJobStatusController']);
  });

  test('harness sanity: GET /:id DOES reach getCourseController, so the assertions above are discriminating', async () => {
    const user = await fundedUser();
    const res = await http.get(`/api/course/${OID()}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['getCourseController']);
  });

  test('POST /:courseId/documents/ingest resolves to ingestDocuments, not a documentId capture', async () => {
    const user = await fundedUser();
    const res = await http.post(`/api/course/${OID()}/documents/ingest`, {
      headers: authHeaderFor(user),
      body: {},
    });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['ingestDocumentsController']);
  });

  test('POST /:courseId/documents/url resolves to addUrlDocument, not a documentId capture', async () => {
    const user = await fundedUser();
    const res = await http.post(`/api/course/${OID()}/documents/url`, {
      headers: authHeaderFor(user),
      body: {},
    });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['addUrlDocumentController']);
  });
});

// ── validateObjectId ────────────────────────────────────

describe('courseRoutes — validateObjectId on /job/:jobId', () => {
  test('GET /job/not-an-objectid → 400, NOT a 500 from Mongoose', async () => {
    const user = await fundedUser();
    const res = await http.get('/api/course/job/not-an-objectid', { headers: authHeaderFor(user) });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(res.json?.message).toMatch(/Invalid ID format: jobId/);
    expect(log.hits).toEqual([]);
  });

  test('GET /job/<valid ObjectId> passes the validator', async () => {
    const user = await fundedUser();
    const res = await http.get(`/api/course/job/${OID()}`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['getJobStatusController']);
  });

  test('DELETE /:courseId/documents/:documentId rejects a malformed documentId with 400', async () => {
    const user = await fundedUser();
    const res = await http.del(`/api/course/${OID()}/documents/nope`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(400);
    expect(log.hits).toEqual([]);
  });
});

// ── requireCredits ──────────────────────────────────────

describe('courseRoutes — requireCredits() on every paid entry point', () => {
  const PAID = [
    { method: 'post', path: () => '/execute-code', controller: 'executeCodeController' },
    { method: 'post', path: () => `/${OID()}/clarify`, controller: 'clarifyCourseController' },
    { method: 'post', path: () => `/${OID()}/generate-structure`, controller: 'generateStructureController' },
    { method: 'post', path: () => `/${OID()}/generate-lesson`, controller: 'generateLessonController' },
    { method: 'post', path: () => `/${OID()}/documents/ingest`, controller: 'ingestDocumentsController' },
    { method: 'post', path: () => `/${OID()}/prepare-corpus`, controller: 'prepareCorpusController' },
    { method: 'post', path: () => `/${OID()}/chat`, controller: 'chatStreamController' },
    { method: 'post', path: () => `/${OID()}/mentor/chat`, controller: 'courseMentorChatController' },
  ] as const;

  test.each(PAID)('POST $controller is credit-gated: zero balance → 402 INSUFFICIENT_CREDITS, controller never runs', async ({ path }) => {
    const user = await zeroBalanceUser();
    const res = await http.post(`/api/course${path()}`, { headers: authHeaderFor(user), body: {} });

    expect(res.status).toBe(402);
    expect(res.json?.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(res.json?.meta).toMatchObject({ need: 1, have: 0 });
    expect(log.hits).toEqual([]);
  });

  test.each(PAID)('POST $controller lets a FUNDED user through — the gate is a balance check, not a blanket refusal', async ({ path, controller }) => {
    const user = await fundedUser();
    const res = await http.post(`/api/course${path()}`, { headers: authHeaderFor(user), body: {} });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual([controller]);
  });

  test('a FREE route is not credit-gated: GET /continue answers 204 at zero balance', async () => {
    // The mirror regression: requireCredits() added where it does not belong
    // locks a paying-nothing user out of surfaces that cost nothing.
    const user = await zeroBalanceUser();
    const res = await http.get('/api/course/continue', { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(402);
    expect(log.hits).toEqual(['getContinueLearningController']);
  });

  test('GET /:courseId/documents (list) is not credit-gated at zero balance', async () => {
    const user = await zeroBalanceUser();
    const res = await http.get(`/api/course/${OID()}/documents`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['listDocumentsController']);
  });
});

// ── The per-route admin gate ────────────────────────────

describe('courseRoutes — the per-route requireAdmin on quiz reset', () => {
  test('a verified NON-ADMIN is refused the quiz reset with 403, and is not signed out (401)', async () => {
    const user = await fundedUser();
    const res = await http.del(`/api/course/${OID()}/module-quiz/0/reset`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(log.hits).toEqual([]);
  });

  test('a verified ADMIN reaches the quiz reset controller', async () => {
    const user = await makeUser({ emailVerified: true, isAdmin: true });
    const res = await http.del(`/api/course/${OID()}/module-quiz/0/reset`, { headers: authHeaderFor(user) });
    expect(res.status).toBe(204);
    expect(log.hits).toEqual(['resetModuleQuizController']);
  });
});
