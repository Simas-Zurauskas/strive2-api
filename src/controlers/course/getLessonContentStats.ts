import asyncHandler from 'express-async-handler';
import { getUserCourseLean } from '@services/courseDbService';
import LessonContentModel from '@models/LessonContentModel';
import RecallCardModel from '@models/RecallCardModel';
import { parseIndexParam } from './validation';

/**
 * Debug-only: returns per-lesson generation metadata that the regular
 * lesson-content endpoint does not expose (recall count, link count). Used by
 * the debug orchestrator to evaluate generation quality without scraping
 * server logs. Gated to `development` in courseRoutes.
 */
export const getLessonContentStatsController = asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const moduleIndex = parseIndexParam({ value: req.params.moduleIndex, name: 'moduleIndex' });
  const lessonIndex = parseIndexParam({ value: req.params.lessonIndex, name: 'lessonIndex' });
  const course = await getUserCourseLean({ userId, courseId: req.params.courseId as string });
  const courseId = course._id.toString();

  const content = await LessonContentModel
    .findOne({ courseId, moduleIndex, lessonIndex })
    .select('blocks')
    .lean();

  if (!content) {
    res.status(404).json({ message: 'Lesson content not yet generated' });
    return;
  }

  const linksBlock = content.blocks.find((b) => b.type === 'links');
  // Count the "- [title](url)" bullet lines in the curated links block.
  const linkCount = linksBlock
    ? (linksBlock.content.match(/^- \[/gm) ?? []).length
    : 0;

  const recallCardCount = await RecallCardModel.countDocuments({
    courseId,
    moduleIndex,
    lessonIndex,
  });

  const blockCountsByType: Record<string, number> = {};
  for (const b of content.blocks) {
    blockCountsByType[b.type] = (blockCountsByType[b.type] ?? 0) + 1;
  }

  res.status(200).json({
    data: {
      blockCount: content.blocks.length,
      blockCountsByType,
      recallCardCount,
      linkCount,
    },
  });
});
