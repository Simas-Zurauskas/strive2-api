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
} from '@controlers/course';
import { protect } from '@middleware/authMiddleware';
import { validateObjectId } from '@middleware/validateObjectId';

const router = Router();

// Static paths (must be before /:id to avoid route conflict)
router.get('/job/:jobId', protect, validateObjectId('jobId'), getJobStatusController);
router.post('/execute-code', protect, executeCodeController);
router.get('/continue', protect, getContinueLearningController);
router.get('/progress-summary', protect, getProgressSummaryController);
router.get('/reviews-due', protect, getReviewsDueController);

// Course CRUD
router.post('/', protect, createCourseController);
router.get('/', protect, listCoursesController);
router.get('/:id', protect, validateObjectId('id'), getCourseController);
router.patch('/:id', protect, validateObjectId('id'), updateCourseController);
router.delete('/:id', protect, validateObjectId('id'), deleteCourseController);

// Chat (course design agent)
router.post('/:courseId/chat', protect, validateObjectId('courseId'), chatStreamController);
router.get('/:courseId/chat/history', protect, validateObjectId('courseId'), getChatHistoryController);

// AI generation (scoped to a course)
router.post('/:courseId/clarify', protect, validateObjectId('courseId'), clarifyCourseController);
router.post('/:courseId/generate-structure', protect, validateObjectId('courseId'), generateStructureController);
router.post('/:courseId/depth-previews', protect, validateObjectId('courseId'), generateDepthPreviewsController);
router.post('/:courseId/refine-structure', protect, validateObjectId('courseId'), refineStructureController);
router.post('/:courseId/generate-lesson', protect, validateObjectId('courseId'), generateLessonController);
router.post('/:courseId/stream-lesson', protect, validateObjectId('courseId'), streamLessonContentController);
router.get('/:courseId/lesson-content/:moduleIndex/:lessonIndex', protect, validateObjectId('courseId'), getLessonContentController);

// Progress tracking
router.get('/:courseId/progress', protect, validateObjectId('courseId'), getCourseProgressController);
router.post('/:courseId/progress/:moduleIndex/:lessonIndex', protect, validateObjectId('courseId'), upsertLessonProgressController);
router.get('/:courseId/generated-lessons', protect, validateObjectId('courseId'), getGeneratedLessonsController);

// Module quizzes
router.post('/:courseId/module-quiz/:moduleIndex/generate', protect, validateObjectId('courseId'), generateModuleQuizController);
router.get('/:courseId/module-quiz/:moduleIndex', protect, validateObjectId('courseId'), getModuleQuizContentController);
router.post('/:courseId/module-quiz/:moduleIndex/submit', protect, validateObjectId('courseId'), submitQuizAttemptController);
router.get('/:courseId/module-quiz/:moduleIndex/progress', protect, validateObjectId('courseId'), getModuleQuizProgressController);

export { router as courseRoutes };
