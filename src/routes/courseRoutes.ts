import { Router } from 'express';
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
  getLessonContentController,
  getLessonContentStatsController,
  executeCodeController,
  streamLessonContentController,
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
} from '@controlers/course';
import { ENVIRONMENT } from '@conf/env';
import { protect, requireVerified } from '@middleware/authMiddleware';
import { validateObjectId } from '@middleware/validateObjectId';

const router = Router();

// Every course route requires auth + a verified email. Applied router-wide
// so new routes inherit the gate automatically; no per-route protect chain.
router.use(protect, requireVerified);

// Static paths (must be before /:id to avoid route conflict)
router.get('/job/:jobId', validateObjectId('jobId'), getJobStatusController);
router.post('/execute-code', executeCodeController);
router.get('/continue', getContinueLearningController);
router.get('/progress-summary', getProgressSummaryController);
router.get('/reviews-due', getReviewsDueController);
router.get('/unattempted-quiz-count', getUnattemptedQuizCountController);
router.get('/favorites', getFavoriteCourseIdsController);
router.post('/favorite/:courseId', toggleFavoriteCourseController);
router.get('/bookmarked-lessons', getBookmarkedLessonsController);
router.get('/recent-activity', getRecentActivityController);

// Course CRUD
router.post('/', createCourseController);
router.get('/', listCoursesController);
router.get('/:id', getCourseController);
router.patch('/:id', updateCourseController);
router.delete('/:id', deleteCourseController);

// Edit impact assessment
router.get('/:courseId/edit-impact', getEditImpactController);

// Chat (course design agent)
router.post('/:courseId/chat', chatStreamController);
router.get('/:courseId/chat/history', getChatHistoryController);

// AI generation (scoped to a course)
router.post('/:courseId/clarify', clarifyCourseController);
router.post('/:courseId/generate-structure', generateStructureController);
router.post('/:courseId/depth-previews', generateDepthPreviewsController);
router.post('/:courseId/refine-structure', refineStructureController);
router.post('/:courseId/generate-lesson', generateLessonController);
router.post('/:courseId/stream-lesson', streamLessonContentController);
router.get('/:courseId/lesson-content/:moduleIndex/:lessonIndex', getLessonContentController);

// Progress tracking
router.get('/:courseId/progress', getCourseProgressController);
router.post('/:courseId/progress/:moduleIndex/:lessonIndex', upsertLessonProgressController);
router.get('/:courseId/generated-lessons', getGeneratedLessonsController);

// Module quizzes
router.post('/:courseId/module-quiz/:moduleIndex/generate', generateModuleQuizController);
router.get('/:courseId/module-quiz/:moduleIndex', getModuleQuizContentController);
router.post('/:courseId/module-quiz/:moduleIndex/submit', submitQuizAttemptController);
router.get('/:courseId/module-quiz/:moduleIndex/progress', getModuleQuizProgressController);

// Dev-only: reset quiz (hidden from Swagger)
if (ENVIRONMENT === 'development') {
  router.delete('/:courseId/module-quiz/:moduleIndex/reset', resetModuleQuizController);
  // Dev-only stats endpoint consumed by the debug orchestrator to surface
  // insight count + curated link count per lesson in its markdown reports.
  router.get(
    '/:courseId/lesson-content/:moduleIndex/:lessonIndex/stats',
    getLessonContentStatsController,
  );
}

export { router as courseRoutes };
