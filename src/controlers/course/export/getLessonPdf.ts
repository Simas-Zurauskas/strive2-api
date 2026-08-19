import asyncHandler from 'express-async-handler';
import { buildLessonDocument } from '@lib/pdf/documents';
import { renderPdf } from '@lib/pdf/engine';
import { contentDisposition, downloadFilename } from '@lib/pdf/filename';
import { pdfLog } from '@lib/loggers';
import { parseIndexParam } from '../validation';
import { exportAttribution, loadLessonForPdf, modulesFromStructure } from './pdfData';
import { loadOwnedCourse } from './ownedCourse';

/**
 * @swagger
 * /api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}/pdf:
 *   get:
 *     summary: Download a single lesson as a PDF
 *     description: >
 *       Renders the lesson's generated content to a branded PDF. Quiz blocks
 *       and any exercise starter code are excluded; diagrams, maths and the
 *       hero image are included. Returns 404 when the lesson has not finished
 *       generating.
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: courseId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: moduleIndex
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: path
 *         name: lessonIndex
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 0
 *     responses:
 *       200:
 *         description: The lesson as a PDF.
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Course not found, or the lesson has not been generated.
 */
export const getLessonPdfController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });

  const course = await loadOwnedCourse({ userId, courseId: req.params.courseId as string, res });
  if (!course) return;

  const courseId = course._id.toString();
  const modules = modulesFromStructure(course.structure);
  const lesson = await loadLessonForPdf({
    courseId,
    moduleIndex,
    lessonIndex,
    modules,
    activeLesson: course.activeLesson,
  });
  if (!lesson) {
    res.status(404).json({ message: 'Lesson content has not been generated yet' });
    return;
  }

  const startedAt = Date.now();
  const { generatedFor, generatedOn } = await exportAttribution(userId);
  const { doc, stats } = await buildLessonDocument({
    lesson,
    courseName: course.name,
    generatedFor,
    generatedOn,
  });

  // Fully buffered before a single byte goes out: a failure part-way
  // through must surface as a clean JSON 500, never as a truncated file the
  // browser has already begun saving.
  const pdf = await renderPdf(doc);

  const filename = downloadFilename({
    parts: [course.name, lesson.lessonName],
    extension: 'pdf',
    fallback: 'strive-lesson',
  });

  pdfLog.info(
    `lesson:render course=${courseId} m=${moduleIndex} l=${lessonIndex} ` +
      `blocks=${lesson.blocks.length} diagrams=${stats.diagrams} fallback=${stats.diagramFallbacks} ` +
      `hero=${lesson.heroDataUri ? 'yes' : 'no'} bytes=${pdf.length} ms=${Date.now() - startedAt}`,
  );

  res
    .status(200)
    .set('Content-Type', 'application/pdf')
    .set('Content-Disposition', contentDisposition(filename))
    .set('Content-Length', String(pdf.length))
    .send(pdf);
});
