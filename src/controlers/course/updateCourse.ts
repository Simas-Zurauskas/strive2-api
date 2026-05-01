import asyncHandler from 'express-async-handler';
import { updateCourseSchema } from './validation';
import { updateCourse, getUserCourseLean } from '@services/courseDbService';
import {
  detectSoftnessHint,
  detectFinishPressure,
  getLessonCountHint,
  getEstimatedHoursRange,
} from '@services/softness';
import { OVERCOMMIT_RISK_LEVELS } from '@services/courseService';
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
 *                 overcommitRisk:
 *                   type: string
 *                   enum: [low, moderate, high]
 *                   description: >
 *                     Optional. The LLM-emitted overcommit-risk level
 *                     read from the course's depth-previews. Present when
 *                     the gate fires on a course generated after this
 *                     field was added; absent on legacy courses where the
 *                     gate triggered on phrase-regex cost signals alone.
 *                 overcommitRationale:
 *                   type: string
 *                   description: >
 *                     Optional. One-sentence rationale for `overcommitRisk`,
 *                     surfaced in the dialog so the learner can see the
 *                     model's reasoning rather than only allowlist-matched
 *                     phrases. Absent when `overcommitRisk` is absent.
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
  // when a cost signal is present.
  //
  // Cost signal (in priority order):
  //   - LLM-emitted `overcommitRisk === 'high'` from depth-previews. The
  //     LLM reads the answers semantically, so it catches paraphrase the
  //     phrase regex below misses ("MVP by Friday", "I'm slammed",
  //     "low-key learning this on the side"). This is the primary signal
  //     on courses generated after this field was added.
  //   - Phrase regex `isSoft` / `isFinishPressure` — kept as fallback for
  //     legacy courses (persisted before `overcommitRisk` existed) and as
  //     defence-in-depth: whichever signal fires first wins.
  //
  // Expansion signal (any of):
  //   - upgradeBeyondRec — picking deeper than current AND deeper than rec
  //   - firstTimeAboveRec — first depth pick is above the recommendation
  //   - largeCourse — selected depth's lesson-count hint max > 15 lessons
  //
  // Gate fires iff `hasExpansionSignal AND hasCostSignal AND !ack`.
  // Downgrades, first-time at-or-below rec, and small-course no-signal
  // cases all pass silently.
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

    // LLM signal — present on courses with depth-previews generated after
    // `overcommitRisk` was added. Read defensively: an unexpected value
    // (e.g. an older client model that didn't follow the schema closely)
    // simply doesn't trigger and the regex fallback below carries the gate.
    const overcommitRisk = (resolved.depthPreviews as { overcommitRisk?: unknown } | null)?.overcommitRisk;
    const isHighOvercommitRisk = overcommitRisk === 'high';

    const hasCostSignal =
      isHighOvercommitRisk || softness.isSoft || finishPressure.isFinishPressure;

    // Large-course check uses the soft band whenever ANY cost signal is
    // present (LLM risk OR phrase regex). Soft-band ceiling is what the
    // learner would actually be served, so the threshold check should
    // reflect that.
    const useSoftBand = softness.isSoft || isHighOvercommitRisk;
    const [, lessonsMax] = getLessonCountHint({
      depth: updates.depth,
      isSoft: useSoftBand,
    });
    const isLargeCourse = lessonsMax > 15;

    const hasExpansionSignal =
      isUpgradeBeyondRecommendation || isFirstTimeAboveRecommendation || isLargeCourse;

    if (hasExpansionSignal && hasCostSignal) {
      if (updates.depthOverrideAcknowledged !== true) {
        const [minLessons, maxLessons] = getLessonCountHint({
          depth: updates.depth,
          isSoft: useSoftBand,
        });
        const [minHours, maxHours] = getEstimatedHoursRange({
          depth: updates.depth,
          isSoft: useSoftBand,
        });
        const overcommitRationale = (resolved.depthPreviews as { overcommitRationale?: unknown } | null)
          ?.overcommitRationale;
        bumpDepthOverrideGateFired();
        // Structured fire log — the metric counter is in-process and
        // resets on restart, so this is the durable record of why the
        // gate triggered. Useful both for product analytics ("how often
        // does this happen?") and for reproducing edge cases reported
        // by users ("the gate fired on me — what did it match?").
        console.log(
          `[depth-gate] FIRED courseId=${courseId} userId=${userId} ` +
            `picked=${updates.depth} prev=${resolved.depth ?? 'none'} ` +
            `recommended=${recommended ?? 'none'} ` +
            `expansion=[upgrade=${isUpgradeBeyondRecommendation},firstAboveRec=${isFirstTimeAboveRecommendation},largeCourse=${isLargeCourse}] ` +
            `cost=[llmRisk=${overcommitRisk ?? 'none'},soft=${softness.isSoft},finishPressure=${finishPressure.isFinishPressure}] ` +
            `cues=${JSON.stringify([...softness.cues, ...finishPressure.cues])}`.yellow,
        );
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
          // Surface the LLM signal alongside the regex cues so the dialog
          // can show the actual reason ("we flagged a high overcommit
          // risk because: <rationale>") rather than only quoting matched
          // allowlist phrases. Both fields are optional — older courses
          // without `overcommitRisk` simply omit them.
          ...(typeof overcommitRisk === 'string' &&
          (OVERCOMMIT_RISK_LEVELS as readonly string[]).includes(overcommitRisk)
            ? { overcommitRisk }
            : {}),
          ...(typeof overcommitRationale === 'string' && overcommitRationale.length > 0
            ? { overcommitRationale }
            : {}),
        });
        return;
      }
      bumpDepthOverrideAcknowledged();
      console.log(
        `[depth-gate] ACKNOWLEDGED courseId=${courseId} userId=${userId} ` +
          `picked=${updates.depth} recommended=${recommended ?? 'none'} ` +
          `llmRisk=${overcommitRisk ?? 'none'}`.gray,
      );
    } else if (hasExpansionSignal !== hasCostSignal && (hasExpansionSignal || hasCostSignal)) {
      // Near-miss: one half of the predicate matched but not the other.
      // The two cases distinguish two qualitatively different failure
      // modes for the gate's calibration:
      //   - expansion-only: learner over-picked (deeper than recommended
      //     or large-course threshold) but used neutral language. Signals
      //     the cost-signal allowlist is too narrow — the regex didn't
      //     match phrasing that an LLM-emitted overcommit risk would
      //     plausibly catch. Watch for these to grow once Phase C lands.
      //   - cost-only: learner had soft / finish-pressure cues but stayed
      //     at-or-below the recommended tier. Already self-corrected — the
      //     gate didn't need to fire. Useful as a denominator: lots of
      //     these means the recommender is doing its job.
      const reason = hasExpansionSignal ? 'expansion-only' : 'cost-only';
      console.log(
        `[depth-gate] NEAR-MISS reason=${reason} courseId=${courseId} userId=${userId} ` +
          `picked=${updates.depth} recommended=${recommended ?? 'none'} ` +
          `expansion=[upgrade=${isUpgradeBeyondRecommendation},firstAboveRec=${isFirstTimeAboveRecommendation},largeCourse=${isLargeCourse}] ` +
          `cost=[llmRisk=${overcommitRisk ?? 'none'},soft=${softness.isSoft},finishPressure=${finishPressure.isFinishPressure}]`.gray,
      );
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
