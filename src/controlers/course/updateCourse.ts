import asyncHandler from 'express-async-handler';
import { updateCourseSchema } from './validation';
import { updateCourse, getUserCourseLean } from '@services/courseDbService';
import { detectSoftnessHint } from '@services/softness';
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

  // Gate: SOFT=YES learners upgrading beyond the recommended depth must
  // acknowledge the warning. See the 2026-04-20 assessment's depth-
  // recommender failures — learners whose own answers contain softness
  // cues ("easily overwhelmed", "just exploring") were silently accepting
  // deeper tiers than they would finish. The gate fires only when ALL of
  // these hold:
  //   1. the update includes a `depth` change,
  //   2. the new depth is strictly higher than the previous depth AND the
  //      recommended depth (i.e. a genuine upgrade beyond what we advised),
  //   3. the stored answers trigger detectSoftnessHint,
  //   4. the client did NOT set `depthOverrideAcknowledged: true`.
  // Backwards-compat: clients that downgrade, pick recommended, or upgrade
  // on a non-soft course are never blocked.
  if (updates.depth && updates.depth !== resolved.depth) {
    const recommended = resolved.depthPreviews?.recommended as CourseDepth | undefined;
    const newRank = depthRank(updates.depth);
    const prevRank = resolved.depth ? depthRank(resolved.depth as CourseDepth) : -1;
    const recommendedRank = recommended ? depthRank(recommended) : -1;
    const isUpgradeBeyondRecommendation =
      newRank > prevRank && (recommendedRank === -1 || newRank > recommendedRank);

    if (isUpgradeBeyondRecommendation) {
      const formattedAnswers = formatAnswersForSoftness(resolved.answers);
      const softness = detectSoftnessHint({ answers: formattedAnswers });
      if (softness.isSoft) {
        if (updates.depthOverrideAcknowledged !== true) {
          bumpDepthOverrideGateFired();
          res.status(409).json({
            code: 'DEPTH_OVERRIDE_REQUIRES_ACK',
            message:
              "Your answers suggest a lighter-effort course. Picking a deeper tier requires acknowledgement — resend with depthOverrideAcknowledged: true to confirm.",
            recommended: recommended ?? null,
            softnessCues: softness.cues,
          });
          return;
        }
        bumpDepthOverrideAcknowledged();
      }
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
