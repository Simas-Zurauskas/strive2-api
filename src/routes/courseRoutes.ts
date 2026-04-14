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
import { protect } from '@middleware/authMiddleware';
import { validateObjectId } from '@middleware/validateObjectId';

const router = Router();

// Static paths (must be before /:id to avoid route conflict)
router.get('/job/:jobId', protect, validateObjectId('jobId'), getJobStatusController);
router.post('/execute-code', protect, executeCodeController);
router.get('/continue', protect, getContinueLearningController);
router.get('/progress-summary', protect, getProgressSummaryController);
router.get('/reviews-due', protect, getReviewsDueController);
router.get('/unattempted-quiz-count', protect, getUnattemptedQuizCountController);
router.get('/favorites', protect, getFavoriteCourseIdsController);
router.post('/favorite/:courseId', protect, toggleFavoriteCourseController);
router.get('/bookmarked-lessons', protect, getBookmarkedLessonsController);
router.get('/recent-activity', protect, getRecentActivityController);

// Course CRUD
router.post('/', protect, createCourseController);
router.get('/', protect, listCoursesController);
router.get('/:id', protect, getCourseController);
router.patch('/:id', protect, updateCourseController);
router.delete('/:id', protect, deleteCourseController);

// Edit impact assessment
router.get('/:courseId/edit-impact', protect, getEditImpactController);

// Chat (course design agent)
router.post('/:courseId/chat', protect, chatStreamController);
router.get('/:courseId/chat/history', protect, getChatHistoryController);

// AI generation (scoped to a course)
router.post('/:courseId/clarify', protect, clarifyCourseController);
router.post('/:courseId/generate-structure', protect, generateStructureController);
router.post('/:courseId/depth-previews', protect, generateDepthPreviewsController);
router.post('/:courseId/refine-structure', protect, refineStructureController);
router.post('/:courseId/generate-lesson', protect, generateLessonController);
router.post('/:courseId/stream-lesson', protect, streamLessonContentController);
router.get('/:courseId/lesson-content/:moduleIndex/:lessonIndex', protect, getLessonContentController);

// Progress tracking
router.get('/:courseId/progress', protect, getCourseProgressController);
router.post('/:courseId/progress/:moduleIndex/:lessonIndex', protect, upsertLessonProgressController);
router.get('/:courseId/generated-lessons', protect, getGeneratedLessonsController);

// Module quizzes
router.post('/:courseId/module-quiz/:moduleIndex/generate', protect, generateModuleQuizController);
router.get('/:courseId/module-quiz/:moduleIndex', protect, getModuleQuizContentController);
router.post('/:courseId/module-quiz/:moduleIndex/submit', protect, submitQuizAttemptController);
router.get('/:courseId/module-quiz/:moduleIndex/progress', protect, getModuleQuizProgressController);

// Dev-only: reset quiz (hidden from Swagger)
if (ENVIRONMENT === 'development') {
  router.delete('/:courseId/module-quiz/:moduleIndex/reset', protect, resetModuleQuizController);
}

export { router as courseRoutes };
