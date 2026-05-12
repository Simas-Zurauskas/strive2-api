import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  createCourseController,
  listCoursesController,
  getCourseController,
  updateCourseController,
  clarifyCourseController,
  generateStructureController,
  refineStructureController,
  generateDepthPreviewsController,
  deleteCourseController,
  getJobStatusController,
  generateLessonController,
  regenerateHeroController,
  regenerateLinksController,
  regenerateRecallController,
  getLessonContentController,
  getLessonContentStatsController,
  executeCodeController,
  chatStreamController,
  getChatHistoryController,
  upsertLessonProgressController,
  getCourseProgressController,
  getContinueLearningController,
  getGeneratedLessonsController,
  getProgressSummaryController,
  generateModuleQuizController,
  getModuleQuizContentController,
  submitQuizAttemptController,
  getModuleQuizProgressController,
  getReviewsDueController,
  getUnattemptedQuizCountController,
  getEditImpactController,
  resetModuleQuizController,
  toggleFavoriteCourseController,
  getFavoriteCourseIdsController,
  getBookmarkedLessonsController,
  getRecentActivityController,
  generateLessonNarrationController,
  deleteLessonNarrationController,
  getNarrationVoicesController,
  lessonChatController,
  getLessonChatHistoryController,
  clearLessonChatController,
  lessonAttachController,
  courseMentorChatController,
  getCourseMentorHistoryController,
  clearCourseMentorController,
} from '@controlers/course';
import { ENVIRONMENT } from '@conf/env';
import { protect, requireAdmin, requireVerified } from '@middleware/authMiddleware';
import { usageContextMiddleware } from '@middleware/usageContext';
import { requireCredits } from '@middleware/requireCredits';
import { limitChatStreamConcurrency } from '@middleware/streamConcurrency';
import { validateObjectId } from '@middleware/validateObjectId';
import {
  attachmentUpload,
  handleAttachmentUploadErrors,
} from '@middleware/attachmentUpload';

const router = Router();

// Every course route requires auth + a verified email. Applied router-wide
// so new routes inherit the gate automatically; no per-route protect chain.
// `usageContextMiddleware` runs last so `req.userId` is already populated
// and the AsyncLocalStorage scope tags every paid action that this
// request's controller triggers (chat stream, clarify, code exec, …).
router.use(protect, requireVerified, usageContextMiddleware);

// Per-user limit on Judge0 invocations. Each call is `wait=true` with a
// 5s CPU limit and a non-trivial RapidAPI cost (~$0.0002/call), so without
// a bound a user with 1 credit could burn ~100 calls/min indefinitely.
// 30/min ≈ one execution every 2s — generous for hand-typed iteration on
// an exercise. In-memory limiter; per-process — single-instance backend
// per CLAUDE.md, so this is sufficient until the deployment splits.
const executeCodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many code-execution requests — slow down.' },
  keyGenerator: (req) => req.userId ?? req.ip ?? 'anon',
  validate: { keyGeneratorIpFallback: false },
});

// Static paths (must be before /:id to avoid route conflict)
router.get('/job/:jobId', validateObjectId('jobId'), getJobStatusController);
router.post('/execute-code', executeCodeLimiter, requireCredits(), executeCodeController);
router.get('/continue', getContinueLearningController);
router.get('/progress-summary', getProgressSummaryController);
router.get('/reviews-due', getReviewsDueController);
router.get('/unattempted-quiz-count', getUnattemptedQuizCountController);
router.get('/favorites', getFavoriteCourseIdsController);
router.post('/favorite/:courseId', toggleFavoriteCourseController);
router.get('/bookmarked-lessons', getBookmarkedLessonsController);
router.get('/recent-activity', getRecentActivityController);
router.get('/narration-voices', getNarrationVoicesController);

// Course CRUD
router.post('/', createCourseController);
router.get('/', listCoursesController);
router.get('/:id', getCourseController);
router.patch('/:id', updateCourseController);
router.delete('/:id', deleteCourseController);

// Edit impact assessment
router.get('/:courseId/edit-impact', getEditImpactController);

// Chat (course design agent)
router.post('/:courseId/chat', limitChatStreamConcurrency, requireCredits(), chatStreamController);
router.get('/:courseId/chat/history', getChatHistoryController);

// Mentor chat (lesson-scoped AI tutor)
router.post(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/mentor/chat',
  limitChatStreamConcurrency,
  requireCredits(),
  lessonChatController,
);
router.get(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/mentor/chat/history',
  getLessonChatHistoryController,
);
router.delete(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/mentor/chat',
  clearLessonChatController,
);

// Mentor-chat attachment upload. Multer runs first to parse multipart;
// the 4-arg error handler translates LIMIT_FILE_SIZE / file-filter
// rejections into clean JSON. Express skips the error handler on the
// success path because it has 4 args.
router.post(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/mentor/attachment',
  attachmentUpload,
  handleAttachmentUploadErrors,
  lessonAttachController,
);

// Course-scoped mentor (compass) — sits on the course-overview surface
// and helps with between-lessons decisions, cross-module synthesis, and
// orientation. Distinct from the lesson-scoped mentor above; one chat
// session per (userId, courseId).
router.post('/:courseId/mentor/chat', limitChatStreamConcurrency, requireCredits(), courseMentorChatController);
router.get('/:courseId/mentor/chat/history', getCourseMentorHistoryController);
router.delete('/:courseId/mentor/chat', clearCourseMentorController);

// AI generation (scoped to a course).
//
// Credit gating: requireCredits() is a single "balance ≥ 1 credit" gate.
// Every paid action the user starts is then charged its real provider cost
// on success via `debitActualSpend` inside jobRunner. Every job type flows
// through it — clarify / depth-previews are no longer free.
router.post('/:courseId/clarify', requireCredits(), clarifyCourseController);
router.post('/:courseId/generate-structure', requireCredits(), generateStructureController);
router.post('/:courseId/depth-previews', requireCredits(), generateDepthPreviewsController);
router.post('/:courseId/refine-structure', requireCredits(), refineStructureController);
router.post('/:courseId/generate-lesson', requireCredits(), generateLessonController);
router.post(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/regenerate-hero',
  requireCredits(),
  regenerateHeroController,
);
router.post(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/regenerate-links',
  requireCredits(),
  regenerateLinksController,
);
router.post(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/regenerate-recall',
  requireCredits(),
  regenerateRecallController,
);
router.post(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/narration',
  requireCredits(),
  generateLessonNarrationController,
);
router.delete(
  '/:courseId/lesson/:moduleIndex/:lessonIndex/narration',
  deleteLessonNarrationController,
);
router.get('/:courseId/lesson-content/:moduleIndex/:lessonIndex', getLessonContentController);

// Progress tracking
router.get('/:courseId/progress', getCourseProgressController);
router.post('/:courseId/progress/:moduleIndex/:lessonIndex', upsertLessonProgressController);
router.get('/:courseId/generated-lessons', getGeneratedLessonsController);

// Module quizzes
router.post(
  '/:courseId/module-quiz/:moduleIndex/generate',
  requireCredits(),
  generateModuleQuizController,
);
router.get('/:courseId/module-quiz/:moduleIndex', getModuleQuizContentController);
router.post('/:courseId/module-quiz/:moduleIndex/submit', submitQuizAttemptController);
router.get('/:courseId/module-quiz/:moduleIndex/progress', getModuleQuizProgressController);

// Admin-only: reset quiz (hidden from Swagger). Was previously env-gated
// to development only; moved to a per-route admin gate so ops can use it
// against staging/prod when iterating. The rest of the router already
// runs under `protect + requireVerified`, so this just adds the role
// check on top.
router.delete(
  '/:courseId/module-quiz/:moduleIndex/reset',
  requireAdmin,
  resetModuleQuizController,
);

// Dev-only stats endpoint consumed by the debug orchestrator to surface
// recall count + curated link count per lesson in its markdown reports.
// Stays env-gated — it's not a UI-facing surface, just a debug harness.
if (ENVIRONMENT === 'development') {
  router.get(
    '/:courseId/lesson-content/:moduleIndex/:lessonIndex/stats',
    getLessonContentStatsController,
  );
}

export { router as courseRoutes };
