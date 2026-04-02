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
} from '@controlers/course';
import { protect } from '@middleware/authMiddleware';
import { validateObjectId } from '@middleware/validateObjectId';

const router = Router();

// Static paths (must be before /:id to avoid route conflict)
router.get('/job/:jobId', protect, validateObjectId('jobId'), getJobStatusController);
router.post('/execute-code', protect, executeCodeController);

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

export { router as courseRoutes };
