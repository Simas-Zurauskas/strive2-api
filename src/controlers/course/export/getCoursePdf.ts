import asyncHandler from 'express-async-handler';
import { buildCourseDocument } from '@lib/pdf/documents';
import { renderPdf } from '@lib/pdf/engine';
import { contentDisposition, downloadFilename } from '@lib/pdf/filename';
import { pdfLog } from '@lib/loggers';
import {
  exportAttribution,
  loadCourseLessonsForPdf,
  modulesFromStructure,
} from './pdfData';
import { loadOwnedCourse } from './ownedCourse';

/**
 * @swagger
 * /api/course/{courseId}/pdf:
 *   get:
 *     summary: Download a whole course as a PDF
 *     description: >
 *       Renders every generated lesson into one branded PDF with a clickable
 *       table of contents. Lessons that have not finished generating are
 *       listed but not included. Quiz blocks and exercise starter code are
 *       excluded throughout.
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
 *     responses:
 *       200:
 *         description: The course as a PDF.
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Course not found.
 *       429:
 *         description: Too many course exports — this one is rate limited.
 */
export const getCoursePdfController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const course = await loadOwnedCourse({ userId, courseId: req.params.courseId as string, res });
  if (!course) return;

  const courseId = course._id.toString();
  const startedAt = Date.now();
  const modules = modulesFromStructure(course.structure);
  const { lessons, heroHits, heroMisses } = await loadCourseLessonsForPdf({
    courseId,
    modules,
    activeLesson: course.activeLesson,
  });

  const { generatedFor, generatedOn } = await exportAttribution(userId);
  const { doc, stats } = await buildCourseDocument({
    courseName: course.name,
    modules,
    lessons,
    generatedFor,
    generatedOn,
  });

  const pdf = await renderPdf(doc);

  const filename = downloadFilename({
    parts: [course.name],
    extension: 'pdf',
    fallback: 'strive-course',
  });

  pdfLog.info(
    `course:render course=${courseId} lessons=${stats.lessons} diagrams=${stats.diagrams} ` +
      `fallback=${stats.diagramFallbacks} heroHit=${heroHits} heroMiss=${heroMisses} ` +
      `bytes=${pdf.length} ms=${Date.now() - startedAt}`,
  );

  res
    .status(200)
    .set('Content-Type', 'application/pdf')
    .set('Content-Disposition', contentDisposition(filename))
    .set('Content-Length', String(pdf.length))
    .send(pdf);
});
