import asyncHandler from 'express-async-handler';
import { updateCourseSchema } from './validation';
import { updateCourse, getUserCourseLean, omitServerOnlyCourseFields } from '@services/courseDbService';
import {
  detectSoftnessHint,
  detectFinishPressure,
  getLessonCountHint,
  getEstimatedHoursRange,
} from '@services/softness';
import { OVERCOMMIT_RISK_LEVELS, UNDERCOMMIT_RISK_LEVELS } from '@services/courseService';
import { COURSE_DEPTHS, CourseDepth } from '@lib/constants';
import {
  bumpDepthOverrideGateFired,
  bumpDepthOverrideAcknowledged,
  bumpDepthUndercommitGateFired,
  bumpDepthUndercommitAcknowledged,
} from '@lib/metrics';
import { genLog } from '@lib/loggers';

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
 *               goalType:
 *                 $ref: '#/components/schemas/GoalType'
 *                 description: >
 *                   User-selected goalType from the Purpose step.
 *                   Marks the choice as user-confirmed and causes the
 *                   next clarify job to skip the auto-classifier.
 *               goalTypeConfirmedAt:
 *                 type: string
 *                 enum: ['now']
 *                 nullable: true
 *                 description: >
 *                   Stamp written by the Purpose step on Next. Pass the
 *                   string literal `'now'` to set the timestamp server-side,
 *                   or `null` to clear it (forces resume back to Purpose).
 *                   Used by the client's resume logic to distinguish
 *                   "purpose unconfirmed" from "purpose confirmed, on
 *                   questions step".
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
 *           Depth selection requires explicit confirmation. The `code`
 *           field discriminates which side of the bidirectional gate fired:
 *
 *           - `DEPTH_OVERRIDE_REQUIRES_ACK` — selected depth is likely
 *             too big for what the learner's answers suggest they'll
 *             finish (overcommit). Payload includes selected-depth ranges
 *             and softness/finishPressure cues.
 *
 *           - `DEPTH_UNDERCOMMIT_REQUIRES_ACK` — selected depth is below
 *             the recommended tier and the LLM judged the coverage gap
 *             meaningful (undercommit). Payload includes both selected
 *             and recommended ranges so the dialog can show the gap.
 *
 *           Client should render the appropriate confirmation dialog and
 *           retry the PATCH with `depthOverrideAcknowledged: true` on user
 *           confirm. The same ack flag works for both 409 codes (a single
 *           PATCH evaluates each side at most once based on rank delta).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DepthOverridePayload'
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

  // Diagnostic: log every PATCH that touches `depth`, BEFORE the gate's
  // outer `if`, so we can see whether the request even reaches the gate
  // logic. If you see `entry` but no follow-up `outcome=...` line, the
  // outer if short-circuited (depth unchanged or unset). If you see neither,
  // the request never hit this controller.
  if (updates.depth !== undefined) {
    genLog.info(
      `course:depth-gate entry course=${courseId} userId=${userId} ` +
        `incoming.depth=${updates.depth} resolved.depth=${resolved.depth ?? 'none'} ` +
        `ack=${updates.depthOverrideAcknowledged === true} ` +
        `willEnterGate=${Boolean(updates.depth && updates.depth !== resolved.depth)}`,
    );
  }

  // Bidirectional depth gate: surfaces a confirmation dialog before the
  // learner commits to a depth that's likely a mistake in EITHER direction.
  //
  // ── OVERCOMMIT side ──
  // Fires when the learner picks a depth that's likely too big for what
  // their answers suggest they'll finish.
  //
  // Cost signal (any of):
  //   - LLM-emitted `overcommitRisk === 'high'` from depth-previews — the
  //     primary signal on modern courses; reads answers semantically and
  //     catches paraphrase the phrase regex misses.
  //   - LLM-emitted `overcommitRisk === 'moderate'` — secondary signal,
  //     only fires when paired with the `largeCourse` expansion signal
  //     (>15 lessons). Catches the "user picks deep_dive against a
  //     comprehensive recommendation, LLM saw enough red flags to call
  //     moderate but not high" case that previously slipped silently.
  //   - Phrase regex `isSoft` / `isFinishPressure` — fallback for legacy
  //     courses (persisted before `overcommitRisk` existed) and defence-
  //     in-depth: whichever signal fires first wins.
  //
  // Expansion signal (any of):
  //   - upgradeBeyondRec — picking deeper than current AND deeper than rec
  //   - firstTimeAboveRec — first depth pick is above the recommendation
  //   - largeCourse — selected depth's lesson-count hint max > 15 lessons
  //
  // Overcommit fires iff:
  //   (hasExpansionSignal AND hasHighCostSignal)
  //   OR (isLargeCourse AND overcommitRisk === 'moderate')
  //
  // ── UNDERCOMMIT side ──
  // Fires when the learner picks BELOW the recommended tier and the LLM
  // judges the coverage gap is meaningful. Symmetric companion to
  // overcommit — same plumbing, separate 409 code, separate metric.
  //
  // Contraction signal (any of):
  //   - downgradeBeyondRec — picking shallower than current AND shallower
  //     than rec
  //   - firstTimeBelowRec — first depth pick is below the recommendation
  //
  // Undercommit cost signal: `undercommitRisk in ['moderate', 'high']`.
  // No regex fallback — deadline / professional-goal phrasing is too
  // varied to allowlist; absence of LLM signal means silent pass (the
  // safer default for a new gate).
  //
  // Undercommit fires iff `hasContractionSignal AND hasUndercommitSignal`.
  //
  // ── Mutual exclusion ──
  // The rank delta is either positive (only overcommit can fire) or
  // negative (only undercommit can fire) or zero (no-op, both skip).
  // The two gates are never both armed on the same PATCH, so a single
  // ack flag (`depthOverrideAcknowledged`) serves both.
  if (updates.depth && updates.depth !== resolved.depth) {
    const recommended = resolved.depthPreviews?.recommended as CourseDepth | undefined;
    const newRank = depthRank(updates.depth);
    const prevRank = resolved.depth ? depthRank(resolved.depth as CourseDepth) : -1;
    const recommendedRank = recommended ? depthRank(recommended) : -1;

    // ── Direction predicates ────────────────────────────────
    const isUpgradeBeyondRecommendation = newRank > prevRank && (recommendedRank === -1 || newRank > recommendedRank);
    const isFirstTimeAboveRecommendation = prevRank === -1 && recommendedRank !== -1 && newRank > recommendedRank;
    const isDowngradeBeyondRecommendation = newRank < prevRank && recommendedRank !== -1 && newRank < recommendedRank;
    const isFirstTimeBelowRecommendation = prevRank === -1 && recommendedRank !== -1 && newRank < recommendedRank;

    // ── Cost signals (overcommit side) ─────────────────────
    const formattedAnswers = formatAnswersForSoftness(resolved.answers);
    const softness = detectSoftnessHint({ answers: formattedAnswers });
    const finishPressure = detectFinishPressure({ answers: formattedAnswers });

    const overcommitRisk = (resolved.depthPreviews as { overcommitRisk?: unknown } | null)?.overcommitRisk;
    const isHighOvercommitRisk = overcommitRisk === 'high';
    const isModerateOvercommitRisk = overcommitRisk === 'moderate';

    const hasHighCostSignal = isHighOvercommitRisk || softness.isSoft || finishPressure.isFinishPressure;

    // useSoftBand stays anchored to the high-confidence signals only —
    // it controls the lesson/hours range we'll show in the dialog AND
    // affects the threshold for `largeCourse`. Bumping `moderate` into
    // useSoftBand would shrink the displayed ranges below what the
    // learner will actually receive at structure-generation time, which
    // would be misleading.
    const useSoftBand = softness.isSoft || isHighOvercommitRisk;

    // Compute the lesson + hours range under the SELECTED depth + soft-band
    // — what the dialog would show. Computed unconditionally so the audit
    // log includes "what the user would have seen" even on silent passes.
    const [minLessons, maxLessons] = getLessonCountHint({ depth: updates.depth, isSoft: useSoftBand });
    const [minHours, maxHours] = getEstimatedHoursRange({ depth: updates.depth, isSoft: useSoftBand });
    const isLargeCourse = maxLessons > 15;

    // `isLargeCourse` (selected depth produces >15 lessons) only counts
    // as expansion when there is NO recommendation to compare against —
    // it's a "you picked something big, no context to judge against"
    // fallback. With a recommendation, direction (above vs at/below) is
    // the source of truth: picking AT the recommended tier must never
    // fire overcommit, even if that tier itself is large. Without this
    // guard, a learner who follows the system's recommended Comprehensive
    // would still get the gate dialog because Comprehensive happens to
    // produce >15 lessons.
    const hasExpansionSignal =
      isUpgradeBeyondRecommendation ||
      isFirstTimeAboveRecommendation ||
      (recommendedRank === -1 && isLargeCourse);

    // ── Cost signals (undercommit side) ────────────────────
    const undercommitRisk = (resolved.depthPreviews as { undercommitRisk?: unknown } | null)?.undercommitRisk;
    const hasUndercommitSignal = undercommitRisk === 'high' || undercommitRisk === 'moderate';

    const hasContractionSignal = isDowngradeBeyondRecommendation || isFirstTimeBelowRecommendation;

    // Recommended-depth ranges — used by the undercommit dialog to show
    // "what you would have gotten with the recommended tier". Computed
    // only when we have a recommendation to compare against; nullish
    // otherwise. Same useSoftBand applied for consistency.
    const recommendedRanges =
      recommended !== undefined
        ? {
            lessons: getLessonCountHint({ depth: recommended, isSoft: useSoftBand }),
            hours: getEstimatedHoursRange({ depth: recommended, isSoft: useSoftBand }),
          }
        : null;

    // ── Rationale extraction (truncated for log; full for dialog) ──
    const rawOvercommitRationale = (resolved.depthPreviews as { overcommitRationale?: unknown } | null)
      ?.overcommitRationale;
    const overcommitRationaleDisplay =
      typeof rawOvercommitRationale === 'string' && rawOvercommitRationale.length > 0
        ? rawOvercommitRationale.length > 120
          ? `${rawOvercommitRationale.slice(0, 117)}...`
          : rawOvercommitRationale
        : 'none';

    const rawUndercommitRationale = (resolved.depthPreviews as { undercommitRationale?: unknown } | null)
      ?.undercommitRationale;
    const undercommitRationaleDisplay =
      typeof rawUndercommitRationale === 'string' && rawUndercommitRationale.length > 0
        ? rawUndercommitRationale.length > 120
          ? `${rawUndercommitRationale.slice(0, 117)}...`
          : rawUndercommitRationale
        : 'none';

    // ── Fire decisions ─────────────────────────────────────
    // Overcommit:
    //   (a) original strict path: any expansion + any high-confidence cost
    //   (b) lenient path: largeCourse + moderate LLM risk
    //       — catches the "deep_dive override against comprehensive
    //          recommendation, LLM emitted moderate not high" case.
    //
    // Both paths additionally require the pick to be ABOVE the
    // recommendation (or there to be no recommendation). The lenient
    // path's `isLargeCourse` is independent of direction by design, so
    // we explicitly guard it here — otherwise a learner picking the
    // recommended Comprehensive (which produces >15 lessons) would
    // trip the gate even though they followed the recommendation.
    const pickedAboveRecommendation = recommendedRank === -1 || newRank > recommendedRank;
    const fireOvercommit =
      pickedAboveRecommendation &&
      ((hasExpansionSignal && hasHighCostSignal) || (isLargeCourse && isModerateOvercommitRisk));

    // Undercommit: contraction + LLM risk above 'low'.
    const fireUndercommit = hasContractionSignal && hasUndercommitSignal;

    // Mutual-exclusion sanity. Rank delta has one direction, so both
    // contraction and expansion can't fire on the same PATCH. If they
    // somehow do (rank-delta logic bug), prefer overcommit (the older,
    // better-tested gate) — the log line will show both flags so we can
    // notice and fix.
    const willAck = updates.depthOverrideAcknowledged === true;
    const gateOutcome:
      | 'fired-overcommit'
      | 'fired-overcommit-acked'
      | 'fired-undercommit'
      | 'fired-undercommit-acked'
      | 'near-miss-expansion-only'
      | 'near-miss-cost-only'
      | 'near-miss-contraction-only'
      | 'silent-pass' = fireOvercommit
      ? willAck
        ? 'fired-overcommit-acked'
        : 'fired-overcommit'
      : fireUndercommit
        ? willAck
          ? 'fired-undercommit-acked'
          : 'fired-undercommit'
        : hasExpansionSignal && !hasHighCostSignal
          ? 'near-miss-expansion-only'
          : !hasExpansionSignal && hasHighCostSignal
            ? 'near-miss-cost-only'
            : hasContractionSignal && !hasUndercommitSignal
              ? 'near-miss-contraction-only'
              : 'silent-pass';

    // ── Uniform structured audit log ───────────────────────
    // Single line per gate evaluation. `fired-*` uses warn (user-visible
    // intervention); everything else uses info. Includes BOTH overcommit
    // and undercommit fields regardless of which side fired — operators
    // can grep `course:depth-gate` and reconstruct the full decision
    // from one line.
    const logFn =
      gateOutcome.startsWith('fired-') && !gateOutcome.endsWith('-acked')
        ? genLog.warn.bind(genLog)
        : genLog.info.bind(genLog);
    logFn(
      `course:depth-gate outcome=${gateOutcome} course=${courseId} userId=${userId} ` +
        `picked=${updates.depth} prev=${resolved.depth ?? 'none'} recommended=${recommended ?? 'none'} ` +
        `expansion=[upgrade=${isUpgradeBeyondRecommendation},firstAboveRec=${isFirstTimeAboveRecommendation},largeCourse=${isLargeCourse}] ` +
        `contraction=[downgrade=${isDowngradeBeyondRecommendation},firstBelowRec=${isFirstTimeBelowRecommendation}] ` +
        `overcommit=[risk=${overcommitRisk ?? 'none'},soft=${softness.isSoft},finishPressure=${finishPressure.isFinishPressure}] ` +
        `undercommit=[risk=${undercommitRisk ?? 'none'}] ` +
        `cues=${JSON.stringify([...softness.cues, ...finishPressure.cues])} ` +
        `wouldShow=[lessons=${minLessons}-${maxLessons},hours=${minHours}-${maxHours},softBand=${useSoftBand}] ` +
        `overcommitRationale="${overcommitRationaleDisplay}" undercommitRationale="${undercommitRationaleDisplay}"`,
    );

    // ── Action ─────────────────────────────────────────────
    if (gateOutcome === 'fired-overcommit') {
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
        // Surface the LLM signal alongside the regex cues so the dialog
        // can show the actual reason rather than only quoting matched
        // allowlist phrases. Both optional — older courses without
        // `overcommitRisk` simply omit them.
        ...(typeof overcommitRisk === 'string' && (OVERCOMMIT_RISK_LEVELS as readonly string[]).includes(overcommitRisk)
          ? { overcommitRisk }
          : {}),
        ...(typeof rawOvercommitRationale === 'string' && rawOvercommitRationale.length > 0
          ? { overcommitRationale: rawOvercommitRationale }
          : {}),
      });
      return;
    }

    if (gateOutcome === 'fired-undercommit') {
      bumpDepthUndercommitGateFired();
      // Frame the warning around what the learner WON'T get at this
      // depth. The recommended-tier ranges anchor the comparison so the
      // dialog can say "you picked X (8-12 lessons), recommendation was
      // Y (18-28 lessons)" rather than just "you picked too low".
      const recName = recommended ?? 'a deeper tier';
      const fallbackMessage =
        recommendedRanges !== null
          ? `Your answers point at ${recName} (about ${recommendedRanges.lessons[0]}–${recommendedRanges.lessons[1]} lessons, ` +
            `~${recommendedRanges.hours[0]}–${recommendedRanges.hours[1]} hours). The depth you picked produces ` +
            `${minLessons}–${maxLessons} lessons and may skip practical applications you asked about — confirm to proceed or pick a fuller tier.`
          : `Your answers point at ${recName}. The depth you picked may skip practical applications you asked about — confirm to proceed or pick a fuller tier.`;
      res.status(409).json({
        code: 'DEPTH_UNDERCOMMIT_REQUIRES_ACK',
        message: fallbackMessage,
        recommended: recommended ?? null,
        selectedDepth: updates.depth,
        // Selected-depth ranges (what they'll get) — same field names as
        // overcommit so the client dialog can use one render path.
        lessonCountRange: [minLessons, maxLessons],
        estimatedHoursRange: [minHours, maxHours],
        // Recommended-depth ranges (what they'd have gotten) — new fields
        // specific to the undercommit case. Optional — present only when
        // we have a recommendation to compare against.
        ...(recommendedRanges !== null
          ? {
              recommendedLessonCountRange: recommendedRanges.lessons,
              recommendedEstimatedHoursRange: recommendedRanges.hours,
            }
          : {}),
        ...(typeof undercommitRisk === 'string' &&
        (UNDERCOMMIT_RISK_LEVELS as readonly string[]).includes(undercommitRisk)
          ? { undercommitRisk }
          : {}),
        ...(typeof rawUndercommitRationale === 'string' && rawUndercommitRationale.length > 0
          ? { undercommitRationale: rawUndercommitRationale }
          : {}),
      });
      return;
    }

    if (gateOutcome === 'fired-overcommit-acked') {
      bumpDepthOverrideAcknowledged();
    }
    if (gateOutcome === 'fired-undercommit-acked') {
      bumpDepthUndercommitAcknowledged();
    }
    // near-miss-* and silent-pass: no action needed. The four near-miss
    // labels preserve diagnostic distinctions visible in the audit log:
    //   - near-miss-expansion-only: over-picked depth + neutral language.
    //   - near-miss-cost-only: soft/finish-pressure cues but at-or-below
    //     recommended (recommender already self-corrected).
    //   - near-miss-contraction-only: under-picked depth but LLM judged
    //     the gap acceptable (e.g. curiosity-driven learner picking
    //     overview when comprehensive was the soft default).
  }

  // The ack flag is a transport-only signal (a "yes I'm sure" confirmation
  // from the client). We never persist it on the course — strip before
  // passing to updateCourse. The metrics bump above is the permanent record.
  const { depthOverrideAcknowledged: _ack, ...persistedUpdates } = updates;

  // goalType cascade rules:
  //  - If the goal text changes, the previously-classified goalType no
  //    longer reflects the goal. Clear `goalType`, `goalTypeConfidence`,
  //    AND `goalTypeConfirmedAt` so the next clarify job re-classifies
  //    (the skip-classifier branch in jobRunner reads
  //    `goalTypeConfidence === 'high'`) and the resume logic lands back
  //    on the Purpose step.
  //  - If the user picked a goalType via the Purpose step, set
  //    `goalTypeConfidence = 'high'` so the next clarify job uses the
  //    chosen value verbatim instead of re-classifying, AND clear
  //    `goalTypeConfirmedAt` — the client's PurposeStep stamps it back
  //    via a separate PATCH once the regen settles, so resume during
  //    the regen window correctly lands back on Purpose.
  // The actual clarify regen is triggered by the client (POST /clarify)
  // immediately after this PATCH, mirroring the goal-text overwrite flow.
  const goalChanged =
    typeof persistedUpdates.goal === 'string' && persistedUpdates.goal !== resolved.goal;
  const goalTypeChanged =
    typeof persistedUpdates.goalType === 'string' && persistedUpdates.goalType !== resolved.goalType;

  const cascadeUpdates: Record<string, unknown> = { ...persistedUpdates };

  // Translate the `'now'` sentinel from the client to a real Date.
  // Validator already restricts the field to `'now' | null | undefined`,
  // so anything else here is a validator bug.
  if (persistedUpdates.goalTypeConfirmedAt === 'now') {
    cascadeUpdates.goalTypeConfirmedAt = new Date();
  }

  if (goalChanged) {
    cascadeUpdates.goalType = null;
    cascadeUpdates.goalTypeConfidence = null;
    cascadeUpdates.goalTypeConfirmedAt = null;
  } else if (goalTypeChanged) {
    cascadeUpdates.goalTypeConfidence = 'high';
    cascadeUpdates.goalTypeConfirmedAt = null;
  }

  const course = await updateCourse({ userId, courseId, updates: cascadeUpdates });

  res.status(200).json({ data: omitServerOnlyCourseFields(course.toJSON()) });
});
