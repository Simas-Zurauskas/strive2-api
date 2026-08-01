/**
 * Tests for generateModuleQuizController's generation gate.
 *
 * The original gate required EVERY lesson in the module to be generated
 * before a quiz could exist — production data (2026-07) showed zero module
 * quizzes had ever been generated because real usage runs 1-2 lessons per
 * module. The gate is now ≥2 generated lessons (or all of them for modules
 * smaller than 2), with the quiz covering the generated subset.
 *
 * Run: yarn test generateModuleQuiz
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../../../test-helpers/db';
import { makeUser, makeCourse, makeLessonContent } from '../../../test-helpers/factories';
import { buildReqRes, invokeController } from '../../../test-helpers/express';

const { fakeSubmitJob } = vi.hoisted(() => ({
  fakeSubmitJob: vi.fn(() => Promise.resolve('job-123')),
}));

vi.mock('@services/jobRunner', () => ({
  submitJob: fakeSubmitJob,
}));

import { generateModuleQuizController } from './generateModuleQuiz';

setupTestDb();

beforeEach(() => {
  vi.clearAllMocks();
});

const structureReasoning = {
  learnerProfile: 'test',
  topicAnalysis: 'test',
  scopeDecisions: 'test',
  progressionStrategy: 'test',
};

const fiveLessonStructure = {
  reasoning: structureReasoning,
  modules: [
    {
      name: 'Module One',
      description: 'First module',
      lessons: Array.from({ length: 5 }, (_, i) => ({
        name: `Lesson ${i + 1}`,
        description: `Lesson ${i + 1} description`,
      })),
    },
  ],
};

const oneLessonStructure = {
  reasoning: structureReasoning,
  modules: [
    {
      name: 'Tiny Module',
      description: 'Single-lesson module',
      lessons: [{ name: 'Only Lesson', description: 'The one lesson' }],
    },
  ],
};

const invoke = async (courseId: string, userId: string, moduleIndex = '0') => {
  const { req, res, status, json } = buildReqRes({
    userId,
    params: { courseId, moduleIndex },
  });
  await invokeController(generateModuleQuizController, req, res);
  return { status, json };
};

describe('generateModuleQuizController gate', () => {
  test('0 generated lessons → 400 LESSONS_NOT_GENERATED', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, structure: fiveLessonStructure });

    const { status, json } = await invoke(course._id.toString(), user._id.toString());

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'LESSONS_NOT_GENERATED' }),
    );
    expect(fakeSubmitJob).not.toHaveBeenCalled();
  });

  test('1 of 5 generated → still 400', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, structure: fiveLessonStructure });
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });

    const { status, json } = await invoke(course._id.toString(), user._id.toString());

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'LESSONS_NOT_GENERATED' }),
    );
    expect(fakeSubmitJob).not.toHaveBeenCalled();
  });

  test('2 of 5 generated → 202, quiz job submitted', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, structure: fiveLessonStructure });
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 1 });

    const { status, json } = await invoke(course._id.toString(), user._id.toString());

    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ data: { jobId: 'job-123' } });
    expect(fakeSubmitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: course._id.toString(),
        type: 'generate_module_quiz',
        metadata: { moduleIndex: 0 },
      }),
    );
  });

  test('single-lesson module: 1 of 1 generated → 202 (required = min(2, lessonCount))', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, structure: oneLessonStructure });
    await makeLessonContent({ courseId: course._id, moduleIndex: 0, lessonIndex: 0 });

    const { status } = await invoke(course._id.toString(), user._id.toString());

    expect(status).toHaveBeenCalledWith(202);
    expect(fakeSubmitJob).toHaveBeenCalledTimes(1);
  });

  test('unknown module index → 404, no job', async () => {
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, structure: oneLessonStructure });

    const { status } = await invoke(course._id.toString(), user._id.toString(), '7');

    expect(status).toHaveBeenCalledWith(404);
    expect(fakeSubmitJob).not.toHaveBeenCalled();
  });
});
