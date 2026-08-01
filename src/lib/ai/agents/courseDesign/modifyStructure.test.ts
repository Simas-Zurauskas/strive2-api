/**
 * FEEDBACK-1: modify_structure (the design-chat structure-writing path)
 * on documents courses:
 *   - passes a real sourceContext to refineCourseStructure (previously the
 *     chat path silently dropped the source grounding);
 *   - on a STRUCTURE_SIZE_VIOLATION from the enforcement layer, returns a
 *     polite refusal carrying the allowed range and does NOT persist;
 *   - filters model-emitted sourceRefs against the course's real chunk
 *     vectorIds before persisting (parity with the jobRunner path);
 *   - goal-course behavior unchanged (no sourceContext, refs untouched).
 *
 * Run: yarn test modifyStructure
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { setupTestDb } from '../../../../../test-helpers/db';
import { makeUser, makeCourse } from '../../../../../test-helpers/factories';

vi.mock('@services/courseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/courseService')>();
  return {
    ...actual,
    refineCourseStructure: vi.fn(),
  };
});

vi.mock('./promptsGenerator', () => ({
  regenerateAndPersistDesignPrompts: vi.fn(async () => undefined),
}));

import { modifyStructure } from './tools';
import { refineCourseStructure } from '@services/courseService';
import { AppError } from '@middleware/errorMiddleware';
import CourseModel from '@models/CourseModel';
import SourceDocumentChunkModel from '@models/SourceDocumentChunkModel';

setupTestDb();

const mockedRefine = vi.mocked(refineCourseStructure);

const CURRENT_STRUCTURE = {
  reasoning: { learnerProfile: 'p', topicAnalysis: 't', scopeDecisions: 's', progressionStrategy: 'g' },
  modules: [
    {
      name: 'M1',
      description: 'd',
      lessons: [
        { name: 'L1', description: 'd' },
        { name: 'L2', description: 'd' },
      ],
    },
  ],
};

const REFINE_OUTPUT = {
  courseName: 'Refined Thermo',
  domain: 'stem' as const,
  reasoning: CURRENT_STRUCTURE.reasoning,
  modules: [
    {
      name: 'M1',
      description: 'd',
      lessons: [
        { name: 'L1', description: 'd', sourceRefs: ['doc:real:0', 'doc:INVENTED:9'] },
        { name: 'L2', description: 'd' },
      ],
    },
  ],
};

const makeDocCourse = async () => {
  const user = await makeUser();
  const course = await makeCourse({ userId: user._id, structure: CURRENT_STRUCTURE, depth: 'comprehensive' });
  await CourseModel.findByIdAndUpdate(course._id, {
    source: 'documents',
    sourceFidelity: 'guided',
    sourceAssessment: { sizeBand: { minLessons: 3, maxLessons: 6, mode: 'source_only' } },
    sourceDigest: { topics: [{ topic: 'Laws', spanRefs: ['doc:real:0'], docIds: ['d1'] }] },
  });
  await SourceDocumentChunkModel.create({
    userId: user._id,
    courseId: course._id,
    documentId: new Types.ObjectId(),
    chunkIndex: 0,
    vectorId: 'doc:real:0',
    text: 'chunk text',
    chunkType: 'text',
  });
  return { user, course };
};

const invokeTool = (courseId: string) =>
  modifyStructure.invoke(
    { instruction: 'Add five more lessons about everything' },
    {
      configurable: {
        courseId,
        goal: 'Learn thermodynamics from my lecture notes',
        answers: [],
        depth: 'comprehensive',
        currentStructure: CURRENT_STRUCTURE,
      },
    },
  );

beforeEach(() => {
  mockedRefine.mockReset();
});

describe('modify_structure — documents course', () => {
  test('passes a populated sourceContext to refineCourseStructure', async () => {
    mockedRefine.mockResolvedValue(REFINE_OUTPUT);
    const { course } = await makeDocCourse();
    const raw = await invokeTool(course._id.toString());
    const result = JSON.parse(raw as string);
    expect(result.success).toBe(true);
    expect(mockedRefine).toHaveBeenCalledTimes(1);
    const args = mockedRefine.mock.calls[0][0];
    expect(args.sourceContext).toBeTruthy();
    expect(args.sourceContext?.sizeBand).toEqual({ minLessons: 3, maxLessons: 6, mode: 'source_only' });
    expect(args.sourceContext?.fidelity).toBe('guided');
  });

  test('persists only validated sourceRefs (invented ids dropped)', async () => {
    mockedRefine.mockResolvedValue(REFINE_OUTPUT);
    const { course } = await makeDocCourse();
    await invokeTool(course._id.toString());
    const persisted = await CourseModel.findById(course._id).lean();
    const lessons = (persisted?.structure as typeof CURRENT_STRUCTURE).modules[0]
      .lessons as { name: string; sourceRefs?: string[] }[];
    expect(lessons[0].sourceRefs).toEqual(['doc:real:0']);
    expect(lessons[1].sourceRefs).toBeUndefined();
  });

  test('STRUCTURE_SIZE_VIOLATION → polite refusal with the allowed range, nothing persisted', async () => {
    mockedRefine.mockRejectedValue(
      new AppError('Generated structure has 14 lessons but the documents support 3-6.', {
        errorCode: 'STRUCTURE_SIZE_VIOLATION',
        meta: { producedLessons: 14, minLessons: 3, maxLessons: 6 },
      }),
    );
    const { course } = await makeDocCourse();
    const before = await CourseModel.findById(course._id).lean();
    const raw = await invokeTool(course._id.toString());
    const result = JSON.parse(raw as string);
    expect(result.success).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.error).toContain('3-6');
    const after = await CourseModel.findById(course._id).lean();
    expect(after?.structure).toEqual(before?.structure);
    expect(after?.name).toBe(before?.name);
    expect(after?.feedbackHistory).toEqual(before?.feedbackHistory);
  });
});

describe('modify_structure — goal course unchanged', () => {
  test('sourceContext is null and the structure persists as before', async () => {
    mockedRefine.mockResolvedValue({
      ...REFINE_OUTPUT,
      modules: [{ name: 'M1', description: 'd', lessons: [{ name: 'L1', description: 'd' }] }],
    });
    const user = await makeUser();
    const course = await makeCourse({ userId: user._id, structure: CURRENT_STRUCTURE, depth: 'comprehensive' });
    const raw = await invokeTool(course._id.toString());
    const result = JSON.parse(raw as string);
    expect(result.success).toBe(true);
    expect(mockedRefine.mock.calls[0][0].sourceContext ?? null).toBeNull();
    const persisted = await CourseModel.findById(course._id).lean();
    expect(persisted?.name).toBe('Refined Thermo');
  });
});
