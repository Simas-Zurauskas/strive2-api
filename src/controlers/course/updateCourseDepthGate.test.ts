/**
 * FEEDBACK-1: depth-override gate coherence on documents courses.
 *
 * The overcommit/undercommit 409 gates previously computed dialog ranges and
 * the `largeCourse` predicate from the UNCLAMPED (depth, isSoft) hints — on a
 * doc course whose preview tiers are band-clamped (e.g. band [3,6] → every
 * tier ≤ 6 lessons) the gate could fire quoting "18–28 lessons" the learner
 * was never promised. The gate must use the same shared tier scope the
 * previews use.
 *
 * Run: yarn test updateCourseDepthGate
 */

import { describe, test, expect } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, makeCourse } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';
import { updateCourseController } from './updateCourse';
import CourseModel from '@models/CourseModel';

setupTestDb();

const DOC_BAND = { minLessons: 3, maxLessons: 6, mode: 'source_only' };

const baseDepthPreviews = {
  overview: { summary: 's', bullets: ['a'] },
  comprehensive: { summary: 's', bullets: ['a'] },
  deep_dive: { summary: 's', bullets: ['a'] },
  recommended: 'overview',
  recommendationReason: 'r',
};

const makeGateCourse = async (opts: {
  doc: boolean;
  depthPreviews?: Record<string, unknown>;
  answers?: Record<string, unknown>;
}) => {
  const user = await makeUser();
  const course = await makeCourse({
    userId: user._id,
    status: 'creating',
    depth: null,
    answers: opts.answers ?? { q1: 'I want a solid grounding' },
  });
  await CourseModel.findByIdAndUpdate(course._id, {
    depthPreviews: opts.depthPreviews ?? baseDepthPreviews,
    ...(opts.doc
      ? { source: 'documents', sourceAssessment: { sizeBand: DOC_BAND } }
      : {}),
  });
  return { user, course };
};

const patchDepth = async (params: { userId: string; courseId: string; depth: string }) => {
  const { req, res, status, json } = buildReqRes({
    body: { depth: params.depth },
    userId: params.userId,
    params: { id: params.courseId },
  });
  await invokeController(updateCourseController, req, res);
  return { status, json };
};

describe('doc course — gate math uses band-clamped tiers', () => {
  test('moderate overcommit + largeCourse path no longer misfires (clamped max 6 ≤ 15)', async () => {
    // Goal-course behavior: comprehensive (normal band [18,28], max > 15) +
    // overcommitRisk moderate + picked above rec → fires. On the doc course
    // the clamped comprehensive tier is [4,6] — not a large course, no fire.
    const { user, course } = await makeGateCourse({
      doc: true,
      depthPreviews: { ...baseDepthPreviews, overcommitRisk: 'moderate' },
    });
    const { status, json } = await patchDepth({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      depth: 'comprehensive',
    });
    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0][0] as { code?: string };
    expect(payload.code).toBeUndefined();
  });

  test('when the gate DOES fire, the 409 payload quotes the clamped ranges', async () => {
    // deep_dive above the overview recommendation with a high overcommit
    // risk → fires. Payload must show the clamped deep_dive tier [5,6]
    // lessons (not the goal-course [36,56]) and its coherent hours.
    const { user, course } = await makeGateCourse({
      doc: true,
      depthPreviews: { ...baseDepthPreviews, overcommitRisk: 'high' },
    });
    const { status, json } = await patchDepth({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      depth: 'deep_dive',
    });
    expect(status).toHaveBeenCalledWith(409);
    const payload = json.mock.calls[0][0] as {
      code: string;
      lessonCountRange: [number, number];
      estimatedHoursRange: [number, number];
    };
    expect(payload.code).toBe('DEPTH_OVERRIDE_REQUIRES_ACK');
    expect(payload.lessonCountRange).toEqual([5, 6]);
    expect(payload.estimatedHoursRange).toEqual([4, 5]);
  });

  test('undercommit 409 quotes clamped recommended ranges on a doc course', async () => {
    const { user, course } = await makeGateCourse({
      doc: true,
      depthPreviews: {
        ...baseDepthPreviews,
        recommended: 'comprehensive',
        undercommitRisk: 'high',
      },
    });
    const { status, json } = await patchDepth({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      depth: 'overview',
    });
    expect(status).toHaveBeenCalledWith(409);
    const payload = json.mock.calls[0][0] as {
      code: string;
      lessonCountRange: [number, number];
      recommendedLessonCountRange: [number, number];
    };
    expect(payload.code).toBe('DEPTH_UNDERCOMMIT_REQUIRES_ACK');
    // Selected overview → clamped [3,4]; recommended comprehensive → [4,6].
    expect(payload.lessonCountRange).toEqual([3, 4]);
    expect(payload.recommendedLessonCountRange).toEqual([4, 6]);
  });
});

describe('goal course — gate behavior unchanged', () => {
  test('moderate overcommit + largeCourse still fires with unclamped ranges', async () => {
    const { user, course } = await makeGateCourse({
      doc: false,
      depthPreviews: { ...baseDepthPreviews, overcommitRisk: 'moderate' },
    });
    const { status, json } = await patchDepth({
      userId: user._id.toString(),
      courseId: course._id.toString(),
      depth: 'comprehensive',
    });
    expect(status).toHaveBeenCalledWith(409);
    const payload = json.mock.calls[0][0] as { code: string; lessonCountRange: [number, number] };
    expect(payload.code).toBe('DEPTH_OVERRIDE_REQUIRES_ACK');
    expect(payload.lessonCountRange).toEqual([18, 28]);
  });
});
