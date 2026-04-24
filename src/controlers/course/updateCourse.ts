import asyncHandler from 'express-async-handler';
import { updateCourseSchema } from './validation';
import { updateCourse, getUserCourseLean } from '@services/courseDbService';
import {
  detectSoftnessHint,
  detectFinishPressure,
  getLessonCountHint,
  getEstimatedHoursRange,
} from '@services/softness';
import { COURSE_DEPTHS, CourseDepth } from '@lib/constants';
import { bumpDepthOverrideGateFired, bumpDepthOverrideAcknowledged } from '@lib/metrics';

/**
 * COURSE_DEPTHS is declared overview → comprehensive → deep_dive, so the
 * array index itself is the depth-rank: overview=0, comprehensive=1,
 * deep_dive=2. "Higher" = larger index. Used by the soft-override gate to
 * distinguish upgrades (e.g. comprehensive → deep_dive, blocked if soft)
 * from downgrades (deep_dive → overview, always allowed).
 */
const depthRank = (d: CourseDepth): number => COURSE_DEPTHS.indexOf(d);

/**
 * Formats the learner's stored answers into the `{ questionId, answer }[]`
 * shape that detectSoftnessHint expects. Mirrors `formatCourseAnswers` in
 * jobRunner.ts but avoids that module's dependency chain — we only need
 * the softness signal here, not the thin-answer marker.
 */
const formatAnswersForSoftness = (
  answers: Record<string, unknown> | null,
): { questionId: string; answer: string }[] => {
  if (!answers) return [];
  return Object.entries(answers).map(([id, a]) => ({
    questionId: id,
    answer: Array.isArray(a) ? a.join(', ') : String(a),
  }));
};

/**
 * @swagger
 * /api/course/{id}:
 *   patch:
 *     summary: Update a course by ID
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               goal:
 *                 type: string
 *               answers:
 *                 type: object
 *               depth:
 *                 $ref: '#/components/schemas/CourseDepth'
 *               status:
 *                 $ref: '#/components/schemas/CourseStatus'
 *               depthOverrideAcknowledged:
 *                 type: boolean
 *                 description: >
 *                   Transport-only flag. Set to true on retry after a 409
 *                   DEPTH_OVERRIDE_REQUIRES_ACK response to confirm the
 *                   learner has seen the course-magnitude modal and chooses
 *                   to proceed with the selected depth. Never persisted.
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/Course'
 *       403:
 *         description: Cannot transition accepted course back to creating
 *       409:
 *         description: >
 *           Depth selection produces a larger course than the learner's
 *           answers suggest they will finish. Client should render the
 *           magnitude (lessonCountRange, estimatedHoursRange, softnessCues,
 *           finishPressureCues) in a confirmation dialog and retry the PATCH
 *           with depthOverrideAcknowledged: true on user confirm.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [code, message]
 *               properties:
 *                 code:
 *                   type: string
 *                   enum: [DEPTH_OVERRIDE_REQUIRES_ACK]
 *                 message:
 *                   type: string
 *                 recommended:
 *                   oneOf:
 *                     - $ref: '#/components/schemas/CourseDepth'
 *                     - type: 'null'
 *                 selectedDepth:
 *                   $ref: '#/components/schemas/CourseDepth'
 *                 lessonCountRange:
 *                   type: array
 *                   items:
 *                     type: number
 *                   minItems: 2
 *                   maxItems: 2
 *                   description: >
 *                     [min, max] estimated total lesson count for the
 *                     selected depth, derived from the lesson-count hints
 *                     (soft or normal band per the learner's softness signal).
 *                 estimatedHoursRange:
 *                   type: array
 *                   items:
 *                     type: number
 *                   minItems: 2
 *                   maxItems: 2
 *                   description: >
 *                     [min, max] estimated total learner-facing hours for
 *                     the selected depth. Derived from lessonCountRange ×
 *                     ~25 minutes per lesson, rounded up.
 *                 softnessCues:
 *                   type: array
 *                   items:
 *                     type: string
 *                 finishPressureCues:
 *                   type: array
 *                   items:
 *                     type: string
 */
export const updateCourseController = asyncHandler(async (req, res) => {
  const updates = updateCourseSchema.parse(req.body);
  const userId = req.userId!;
  const resolved = await getUserCourseLean({ userId, courseId: req.params.id as string });
  const courseId = resolved._id.toString();

  // Guard: accepted courses cannot be moved back to creating status
  if (updates.status === 'creating') {
    if (resolved.status === 'ready') {
      res.status(403).json({ message: 'Cannot edit an accepted course. Course structure is locked once accepted.' });
      return;
    }
  }

  // Gate: surface course magnitude before the learner commits to a depth
  // that is either (a) larger than recommended OR (b) a 15+-lesson course
  // with finish-pressure / softness signals in their answers.
  //
  // 2026-04-21 assessment follow-up:
  //   - Mike (comprehensive over overview, "upcoming project at work")
  //     needed the gate but finish-pressure language wasn't in the softness
  //     dict, so it never fired. Fix: add detectFinishPressure as a parallel
  //     cost signal.
  //   - Alex (deep_dive = recommended, 55 lessons, "cover a lot of ground"
  //     + finish-pressure) needed the gate but Match=Yes, so the
  //     upgrade-beyond-rec trigger couldn't fire. Fix: add a large-course
  //     expansion trigger that fires on Match=Yes when the lesson-hint max
  //     exceeds 15.
  //
  // Rule:
  //   - expansionSignal = upgradeBeyondRec OR firstTimeAboveRec OR largeCourse
  //   - costSignal = isSoft OR isFinishPressure
  //   - gate fires iff expansionSignal AND costSignal AND !ack
  // Downgrades, first-time at-or-below rec, and small-course no-signal
  // cases all pass silently (matches prior behaviour for those paths).
  if (updates.depth && updates.depth !== resolved.depth) {
    const recommended = resolved.depthPreviews?.recommended as CourseDepth | undefined;
    const newRank = depthRank(updates.depth);
    const prevRank = resolved.depth ? depthRank(resolved.depth as CourseDepth) : -1;
    const recommendedRank = recommended ? depthRank(recommended) : -1;

    const isUpgradeBeyondRecommendation =
      newRank > prevRank && (recommendedRank === -1 || newRank > recommendedRank);
    const isFirstTimeAboveRecommendation =
      prevRank === -1 && recommendedRank !== -1 && newRank > recommendedRank;

    const formattedAnswers = formatAnswersForSoftness(resolved.answers);
    const softness = detectSoftnessHint({ answers: formattedAnswers });
    const finishPressure = detectFinishPressure({ answers: formattedAnswers });
    const hasCostSignal = softness.isSoft || finishPressure.isFinishPressure;

    // Large-course check uses the (depth, isSoft) lesson-count hint. If either
    // cost signal is present AND the hint's max exceeds the 15-lesson threshold
    // from the rubric C11 branch (b), this counts as an expansion signal on its
    // own — covers Alex's Match=Yes / 55-lesson deep_dive case.
    const [, lessonsMax] = getLessonCountHint({
      depth: updates.depth,
      isSoft: softness.isSoft,
    });
    const isLargeCourse = lessonsMax > 15;

    const hasExpansionSignal =
      isUpgradeBeyondRecommendation || isFirstTimeAboveRecommendation || isLargeCourse;

    if (hasExpansionSignal && hasCostSignal) {
      if (updates.depthOverrideAcknowledged !== true) {
        const [minLessons, maxLessons] = getLessonCountHint({
          depth: updates.depth,
          isSoft: softness.isSoft,
        });
        const [minHours, maxHours] = getEstimatedHoursRange({
          depth: updates.depth,
          isSoft: softness.isSoft,
        });
        bumpDepthOverrideGateFired();
        res.status(409).json({
          code: 'DEPTH_OVERRIDE_REQUIRES_ACK',
          message:
            `This depth produces roughly ${minLessons}–${maxLessons} lessons ` +
            `(~${minHours}–${maxHours} hours). Your answers suggest a ` +
            `time-constrained or lighter-effort learner — confirm to proceed ` +
            `or pick a smaller tier.`,
          recommended: recommended ?? null,
          selectedDepth: updates.depth,
          lessonCountRange: [minLessons, maxLessons],
          estimatedHoursRange: [minHours, maxHours],
          softnessCues: softness.cues,
          finishPressureCues: finishPressure.cues,
        });
        return;
      }
      bumpDepthOverrideAcknowledged();
    }
  }

  // The ack flag is a transport-only signal (a "yes I'm sure" confirmation
  // from the client). We never persist it on the course — strip before
  // passing to updateCourse. The metrics bump above is the permanent record.
  const { depthOverrideAcknowledged: _ack, ...persistedUpdates } = updates;

  console.log(`[API] Update course: ${courseId} fields: ${Object.keys(persistedUpdates).join(', ')}`.cyan);
  const course = await updateCourse({ userId, courseId, updates: persistedUpdates });
  console.log(`[API] Course updated: ${courseId}`.green);

  res.status(200).json({ data: course });
});
