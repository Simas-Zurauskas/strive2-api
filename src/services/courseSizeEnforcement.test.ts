/**
 * FEEDBACK-1 (course-from-documents): lesson-count enforcement + depth-tier
 * differentiation for documents courses.
 *
 * Covers:
 *   - getTierScope: band-derived tier spread (wide / narrow / degenerate
 *     bands), per-tier hours coherence, per-tier source notes;
 *   - preview ↔ generation parity: enrichDepthPreviewsWithScope and the
 *     structure-generation cap derive from the SAME shared function;
 *   - generateCourseStructure enforcement matrix (doc courses): within-range
 *     accept · over → corrective retry → comply · over → retry → tolerated
 *     overrun (≤1.25×max) · over → retry → still over → typed failure ·
 *     under-run lenient path · first-response salvage;
 *   - goal courses keep the advisory-only path (no retry, no throw);
 *   - the HARD lesson-count constraint sentence (doc courses only) with
 *     per-fidelity framing;
 *   - clarify fidelity instruction per fidelity, absent on goal courses.
 *
 * Run: yarn test courseSizeEnforcement
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { BaseMessage } from '@langchain/core/messages';

const { invokeMock, withStructuredOutputMock } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  return {
    invokeMock,
    withStructuredOutputMock: vi.fn(() => ({ invoke: invokeMock })),
  };
});

vi.mock('@lib/langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/langchain')>();
  return {
    ...actual,
    getStructureModel: vi.fn(() => ({ withStructuredOutput: withStructuredOutputMock })),
  };
});

import {
  clarifyCourse,
  generateCourseStructure,
  refineCourseStructure,
  enrichDepthPreviewsWithScope,
  getTierScope,
  extractSourceSizeBand,
  type CourseSourceContext,
  type SourceSizeBand,
} from '@services/courseService';
import { getLessonCountHint, getEstimatedHoursRange } from '@services/softness';
import { AppError } from '@middleware/errorMiddleware';
import * as metrics from '@lib/metrics';

const GOAL = 'Learn thermodynamics from my lecture notes';
const ANSWERS = [
  { questionId: 'What is your background?', answer: 'Second-year engineering student' },
];

const BAND_3_6: SourceSizeBand = { minLessons: 3, maxLessons: 6, mode: 'source_only' };

const sourceContextWithBand = (sizeBand: SourceSizeBand | null): CourseSourceContext => ({
  digestTopics: [
    { topic: 'Laws of Thermodynamics', summaryLine: 'The four laws', spanRefs: ['doc:c1:d1:0'], docIds: ['d1'] },
  ],
  sizeBand,
  fidelity: 'guided',
});

/** Build a valid structure output totalling exactly `n` lessons. */
const mkStructure = (n: number) => {
  const lessons = Array.from({ length: n }, (_, i) => ({ name: `L${i + 1}`, description: 'd' }));
  return {
    courseName: 'Thermo',
    domain: 'stem',
    reasoning: { learnerProfile: 'p', topicAnalysis: 't', scopeDecisions: 's', progressionStrategy: 'g' },
    modules: [{ name: 'M1', description: 'd', lessons }],
  };
};

const messageText = (msg: BaseMessage): string => {
  const content = msg.content as string | Array<{ type: string; text?: string }>;
  if (typeof content === 'string') return content;
  return content.map((b) => b.text ?? '').join('');
};

const humanOfCall = (i: number): string => messageText((invokeMock.mock.calls[i][0] as BaseMessage[])[1]);

beforeEach(() => {
  invokeMock.mockReset();
});

// ── Shared tier scope: spread matrix ────────────────────────

describe('getTierScope — band-derived tier spread', () => {
  test('founder case: source_only band [3,6] spreads overview [3,4] / comprehensive [4,6] / deep_dive [5,6]', () => {
    expect(getTierScope({ depth: 'overview', isSoft: false, sizeBand: BAND_3_6 }).lessonCountRange).toEqual([3, 4]);
    expect(getTierScope({ depth: 'comprehensive', isSoft: false, sizeBand: BAND_3_6 }).lessonCountRange).toEqual([4, 6]);
    expect(getTierScope({ depth: 'deep_dive', isSoft: false, sizeBand: BAND_3_6 }).lessonCountRange).toEqual([5, 6]);
  });

  test('wide band [12,20]: step ceil(8/3)=3 → [12,15] / [15,20] / [17,20]', () => {
    const band: SourceSizeBand = { minLessons: 12, maxLessons: 20, mode: 'source_only' };
    expect(getTierScope({ depth: 'overview', isSoft: false, sizeBand: band }).lessonCountRange).toEqual([12, 15]);
    expect(getTierScope({ depth: 'comprehensive', isSoft: false, sizeBand: band }).lessonCountRange).toEqual([15, 20]);
    expect(getTierScope({ depth: 'deep_dive', isSoft: false, sizeBand: band }).lessonCountRange).toEqual([17, 20]);
  });

  test('narrow band [3,4] (span 1): all tiers share the band, differentiated by hours only', () => {
    const band: SourceSizeBand = { minLessons: 3, maxLessons: 4, mode: 'source_only' };
    const ov = getTierScope({ depth: 'overview', isSoft: false, sizeBand: band });
    const comp = getTierScope({ depth: 'comprehensive', isSoft: false, sizeBand: band });
    const deep = getTierScope({ depth: 'deep_dive', isSoft: false, sizeBand: band });
    expect(ov.lessonCountRange).toEqual([3, 4]);
    expect(comp.lessonCountRange).toEqual([3, 4]);
    expect(deep.lessonCountRange).toEqual([3, 4]);
    // Hours must still be strictly increasing across tiers.
    expect(comp.estimatedHoursRange[1]).toBeGreaterThan(ov.estimatedHoursRange[1]);
    expect(deep.estimatedHoursRange[1]).toBeGreaterThan(comp.estimatedHoursRange[1]);
  });

  test('degenerate band [6,6]: all tiers [6,6]', () => {
    const band: SourceSizeBand = { minLessons: 6, maxLessons: 6, mode: 'source_only' };
    for (const depth of ['overview', 'comprehensive', 'deep_dive'] as const) {
      expect(getTierScope({ depth, isSoft: false, sizeBand: band }).lessonCountRange).toEqual([6, 6]);
    }
  });

  test('needs_supplement [4,10]: spreads within [4, ceil(10×1.5)=15] → [4,8] / [8,15] / [11,15]', () => {
    const band: SourceSizeBand = { minLessons: 4, maxLessons: 10, mode: 'needs_supplement' };
    expect(getTierScope({ depth: 'overview', isSoft: false, sizeBand: band }).lessonCountRange).toEqual([4, 8]);
    expect(getTierScope({ depth: 'comprehensive', isSoft: false, sizeBand: band }).lessonCountRange).toEqual([8, 15]);
    expect(getTierScope({ depth: 'deep_dive', isSoft: false, sizeBand: band }).lessonCountRange).toEqual([11, 15]);
  });

  test('multi_course band: base (goal-course) ranges and hours, no tier note', () => {
    const band: SourceSizeBand = { minLessons: 40, maxLessons: 90, mode: 'multi_course' };
    const scope = getTierScope({ depth: 'comprehensive', isSoft: false, sizeBand: band });
    expect(scope.lessonCountRange).toEqual(getLessonCountHint({ depth: 'comprehensive', isSoft: false }));
    expect(scope.estimatedHoursRange).toEqual(getEstimatedHoursRange({ depth: 'comprehensive', isSoft: false }));
    expect(scope.sourceTierNote).toBeUndefined();
  });

  test('null band: identical to the pre-feature goal-course scope', () => {
    const scope = getTierScope({ depth: 'deep_dive', isSoft: true, sizeBand: null });
    expect(scope.lessonCountRange).toEqual(getLessonCountHint({ depth: 'deep_dive', isSoft: true }));
    expect(scope.estimatedHoursRange).toEqual(getEstimatedHoursRange({ depth: 'deep_dive', isSoft: true }));
    expect(scope.sourceTierNote).toBeUndefined();
  });
});

// ── Hours coherence + tier notes ────────────────────────────

describe('getTierScope — hours coherence (band-clamped modes)', () => {
  test('hours derive from the CLAMPED counts × per-tier depth factor (15/30/45 min per lesson)', () => {
    // Band [3,6]: overview [3,4] × 15min → [1,1]h; comprehensive [4,6] × 30min
    // → [2,3]h; deep_dive [5,6] × 45min → [4,5]h.
    expect(getTierScope({ depth: 'overview', isSoft: false, sizeBand: BAND_3_6 }).estimatedHoursRange).toEqual([1, 1]);
    expect(getTierScope({ depth: 'comprehensive', isSoft: false, sizeBand: BAND_3_6 }).estimatedHoursRange).toEqual([2, 3]);
    expect(getTierScope({ depth: 'deep_dive', isSoft: false, sizeBand: BAND_3_6 }).estimatedHoursRange).toEqual([4, 5]);
  });

  test('per-tier source note present on clamped modes, explains depth-of-treatment', () => {
    const ov = getTierScope({ depth: 'overview', isSoft: false, sizeBand: BAND_3_6 });
    const comp = getTierScope({ depth: 'comprehensive', isSoft: false, sizeBand: BAND_3_6 });
    const deep = getTierScope({ depth: 'deep_dive', isSoft: false, sizeBand: BAND_3_6 });
    expect(ov.sourceTierNote).toBeTruthy();
    expect(comp.sourceTierNote).toContain('Same source scope');
    expect(deep.sourceTierNote).toContain('Same source scope');
    // Notes are tier-distinct (the client renders them side by side).
    expect(new Set([ov.sourceTierNote, comp.sourceTierNote, deep.sourceTierNote]).size).toBe(3);
  });
});

// ── Preview ↔ generation parity ─────────────────────────────

describe('preview ↔ generation parity (single shared function)', () => {
  const llmOutput = {
    overview: { summary: 's', bullets: ['a'] },
    comprehensive: { summary: 's', bullets: ['a'] },
    deep_dive: { summary: 's', bullets: ['a'] },
    recommended: 'comprehensive' as const,
    recommendationReason: 'r',
  };

  test('enrichDepthPreviewsWithScope tiers equal getTierScope for every mode', () => {
    const bands: (SourceSizeBand | null)[] = [
      BAND_3_6,
      { minLessons: 4, maxLessons: 10, mode: 'needs_supplement' },
      { minLessons: 40, maxLessons: 90, mode: 'multi_course' },
      null,
    ];
    for (const sizeBand of bands) {
      const out = enrichDepthPreviewsWithScope(llmOutput, { isSoft: false, sizeBand });
      for (const depth of ['overview', 'comprehensive', 'deep_dive'] as const) {
        const scope = getTierScope({ depth, isSoft: false, sizeBand });
        expect(out[depth].lessonCountRange).toEqual(scope.lessonCountRange);
        expect(out[depth].estimatedHoursRange).toEqual(scope.estimatedHoursRange);
        expect((out[depth] as { sourceTierNote?: string }).sourceTierNote).toEqual(scope.sourceTierNote);
      }
    }
  });

  test('the structure prompt carries exactly the tier range the preview showed (band [3,6], comprehensive → 4-6)', async () => {
    invokeMock.mockResolvedValue(mkStructure(5));
    await generateCourseStructure({
      goal: GOAL,
      answers: ANSWERS,
      depth: 'comprehensive',
      goalType: 'master',
      sourceContext: sourceContextWithBand(BAND_3_6),
    });
    const human = humanOfCall(0);
    expect(human).toContain('between 4 and 6 total lessons');
    // The advisory goal-course phrasing must NOT appear on doc courses.
    expect(human).not.toContain('unless the topic genuinely cannot be taught at this scale');
  });
});

// ── extractSourceSizeBand ───────────────────────────────────

describe('extractSourceSizeBand', () => {
  test('reads the band from a documents course row', () => {
    expect(
      extractSourceSizeBand({
        source: 'documents',
        sourceAssessment: { sizeBand: { minLessons: 3, maxLessons: 6, mode: 'source_only' } },
      }),
    ).toEqual(BAND_3_6);
  });

  test('null for goal courses and malformed bands', () => {
    expect(extractSourceSizeBand({ source: null, sourceAssessment: { sizeBand: BAND_3_6 } })).toBeNull();
    expect(extractSourceSizeBand({ source: 'documents', sourceAssessment: { sizeBand: { minLessons: 'x' } } })).toBeNull();
    expect(extractSourceSizeBand({ source: 'documents', sourceAssessment: null })).toBeNull();
  });
});

// ── Enforcement matrix ──────────────────────────────────────

describe('generateCourseStructure — doc-course lesson-count enforcement', () => {
  // Band [3,6], comprehensive → clamped [4,6]; tolerance ceil(6×1.25)=8;
  // lenient under-run floor max(1, 4−1)=3.
  const docParams = {
    goal: GOAL,
    answers: ANSWERS,
    depth: 'comprehensive' as const,
    goalType: 'master' as const,
    sourceContext: sourceContextWithBand(BAND_3_6),
  };

  test('within range → single call, no retry', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(5));
    const result = await generateCourseStructure(docParams);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.modules[0].lessons).toHaveLength(5);
  });

  test('over → corrective retry carries the violation message → complies', async () => {
    const before = metrics.structureSourceBandRetried;
    invokeMock.mockResolvedValueOnce(mkStructure(26)).mockResolvedValueOnce(mkStructure(6));
    const result = await generateCourseStructure(docParams);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.modules[0].lessons).toHaveLength(6);
    const correction = humanOfCall(1);
    expect(correction).toContain('26 total lessons');
    expect(correction).toContain('4-6');
    expect(metrics.structureSourceBandRetried).toBe(before + 1);
  });

  test('over → retry → tolerated overrun (7 ≤ ceil(1.25×6)=8) → accepted with metric', async () => {
    const before = metrics.structureSourceBandAcceptedOutOfRange;
    invokeMock.mockResolvedValueOnce(mkStructure(26)).mockResolvedValueOnce(mkStructure(7));
    const result = await generateCourseStructure(docParams);
    expect(result.modules[0].lessons).toHaveLength(7);
    expect(metrics.structureSourceBandAcceptedOutOfRange).toBe(before + 1);
  });

  test('over → retry → still far over (>8) → typed STRUCTURE_SIZE_VIOLATION failure', async () => {
    const before = metrics.structureSourceBandFailed;
    invokeMock.mockResolvedValueOnce(mkStructure(26)).mockResolvedValueOnce(mkStructure(12));
    await expect(generateCourseStructure(docParams)).rejects.toMatchObject({
      errorCode: 'STRUCTURE_SIZE_VIOLATION',
      meta: { producedLessons: 12, minLessons: 4, maxLessons: 6 },
    });
    await expect(
      (async () => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValueOnce(mkStructure(26)).mockResolvedValueOnce(mkStructure(12));
        return generateCourseStructure(docParams);
      })(),
    ).rejects.toBeInstanceOf(AppError);
    expect(metrics.structureSourceBandFailed).toBe(before + 2);
  });

  test('retry regressed but the FIRST response was inside the tolerance → salvage the first', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(7)).mockResolvedValueOnce(mkStructure(12));
    const result = await generateCourseStructure(docParams);
    expect(result.modules[0].lessons).toHaveLength(7);
  });

  test('under-run (2 < min−1) → retry; lenient acceptance at min−1 (3)', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(2)).mockResolvedValueOnce(mkStructure(3));
    const result = await generateCourseStructure(docParams);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.modules[0].lessons).toHaveLength(3);
  });

  test('under-run persists (retry produces 1 < 3) → typed failure', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(2)).mockResolvedValueOnce(mkStructure(1));
    await expect(generateCourseStructure(docParams)).rejects.toMatchObject({
      errorCode: 'STRUCTURE_SIZE_VIOLATION',
    });
  });

  test('count == min−1 does NOT trigger a retry (lenient window)', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(3));
    const result = await generateCourseStructure(docParams);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.modules[0].lessons).toHaveLength(3);
  });

  test('goal course: grossly over cap stays ADVISORY — no retry, no throw, legacy metric only', async () => {
    const beforeAdvisory = metrics.structureCapExceeded;
    const beforeRetry = metrics.structureSourceBandRetried;
    invokeMock.mockResolvedValueOnce(mkStructure(60));
    const result = await generateCourseStructure({
      goal: GOAL,
      answers: ANSWERS,
      depth: 'comprehensive',
      goalType: 'master',
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.modules[0].lessons).toHaveLength(60);
    expect(metrics.structureCapExceeded).toBe(beforeAdvisory + 1);
    expect(metrics.structureSourceBandRetried).toBe(beforeRetry);
  });
});

describe('refineCourseStructure — same enforcement on the refine path', () => {
  const refineParams = {
    goal: GOAL,
    answers: ANSWERS,
    depth: 'comprehensive' as const,
    goalType: 'master' as const,
    currentStructure: { modules: mkStructure(5).modules },
    currentDomain: 'stem' as const,
    feedback: 'Add ten more lessons about everything',
    feedbackHistory: [],
    sourceContext: sourceContextWithBand(BAND_3_6),
  };

  test('over → retry → comply', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(15)).mockResolvedValueOnce(mkStructure(6));
    const result = await refineCourseStructure(refineParams);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.modules[0].lessons).toHaveLength(6);
  });

  test('over → retry → still far over → typed failure', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(15)).mockResolvedValueOnce(mkStructure(15));
    await expect(refineCourseStructure(refineParams)).rejects.toMatchObject({
      errorCode: 'STRUCTURE_SIZE_VIOLATION',
    });
  });

  test('goal-course refine unchanged: no enforcement', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(60));
    const { sourceContext: _sc, ...goalParams } = refineParams;
    const result = await refineCourseStructure(goalParams);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.modules[0].lessons).toHaveLength(60);
  });
});

// ── Hard-constraint sentence + fidelity framing ─────────────

describe('doc-course structure prompt — hard lesson-count constraint', () => {
  test.each([
    ['strict', 'never pad'],
    ['guided', 'count against the same limit'],
    ['enrich', 'never adds lessons beyond the limit'],
  ] as const)('fidelity %s carries its framing sentence', async (fidelity, marker) => {
    invokeMock.mockResolvedValueOnce(mkStructure(5));
    await generateCourseStructure({
      goal: GOAL,
      answers: ANSWERS,
      depth: 'comprehensive',
      goalType: 'master',
      sourceContext: { ...sourceContextWithBand(BAND_3_6), fidelity },
    });
    const human = humanOfCall(0);
    expect(human).toContain('Lesson-count limit (HARD)');
    expect(human).toContain(marker);
  });

  test('refine prompt carries the hard limit and the stay-inside-even-when-asked-to-grow rule', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(5));
    await refineCourseStructure({
      goal: GOAL,
      answers: ANSWERS,
      depth: 'comprehensive',
      goalType: 'master',
      currentStructure: { modules: mkStructure(5).modules },
      currentDomain: 'stem',
      feedback: 'Add more',
      feedbackHistory: [],
      sourceContext: sourceContextWithBand(BAND_3_6),
    });
    const human = humanOfCall(0);
    expect(human).toContain('Lesson-count limit (HARD)');
    expect(human).toContain('even when the request asks to grow the course');
    expect(human).not.toContain('respect the cap unless the learner');
  });

  test('doc course with null band: hard limit uses the base tier range', async () => {
    invokeMock.mockResolvedValueOnce(mkStructure(20));
    await generateCourseStructure({
      goal: GOAL,
      answers: ANSWERS,
      depth: 'comprehensive',
      goalType: 'master',
      sourceContext: sourceContextWithBand(null),
    });
    const [lo, hi] = getLessonCountHint({ depth: 'comprehensive', isSoft: false });
    expect(humanOfCall(0)).toContain(`between ${lo} and ${hi} total lessons`);
  });
});

// ── Clarify fidelity instruction ────────────────────────────

describe('clarify — fidelity-aware instruction (doc courses only)', () => {
  type CreateArgs = {
    system: Array<{ text: string }>;
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ name: string }>;
    tool_choice?: { name?: string };
  };
  let createSpy: ReturnType<typeof vi.spyOn> | null = null;
  let captured: CreateArgs[] = [];

  beforeEach(() => {
    captured = [];
    createSpy = vi.spyOn(Anthropic.Messages.prototype, 'create').mockImplementation(async function (
      this: unknown,
      args: unknown,
    ) {
      captured.push(args as CreateArgs);
      return {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'clarify_output',
            input: {
              courseName: 'Thermo',
              questions: [{ id: 'q1', question: 'Why these notes?', type: 'text', options: null }],
            },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    } as never);
  });

  afterEach(() => {
    createSpy?.mockRestore();
    createSpy = null;
  });

  test.each([
    ['strict', 'never propose expanding the course beyond the documents'],
    ['guided', 'small gaps'],
    ['enrich', 'broader direction questions'],
  ] as const)('fidelity %s instruction present', async (fidelity, marker) => {
    await clarifyCourse({
      goal: GOAL,
      goalType: 'master',
      sourceContext: { ...sourceContextWithBand(BAND_3_6), fidelity },
    });
    expect(captured[0].messages[0].content).toContain(marker);
  });

  test('goal course carries no fidelity instruction', async () => {
    await clarifyCourse({ goal: GOAL, goalType: 'master' });
    const msg = captured[0].messages[0].content;
    expect(msg).not.toContain('Fidelity is');
    expect(msg).not.toContain('Source fidelity');
  });
});
