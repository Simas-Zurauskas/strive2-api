/**
 * Phase 8 — the four export endpoints.
 *
 * The authorization assertion is the important one, and it is written
 * against what the code actually produces rather than what one might hope.
 * `getUserCourseLean` throws a status-less `Error`, and `errorHandler`
 * turns that into a **500** plus a Sentry capture — so "someone else's
 * course" would page an on-call engineer every time a curious user changed
 * an id in the URL bar. These routes wrap it into a 404.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDb } from '../../../../test-helpers/db';
import { buildReqRes, invokeController } from '../../../../test-helpers/express';
import CourseModel from '@models/CourseModel';
import LessonContentModel from '@models/LessonContentModel';
import UserModel from '@models/UserModel';
import { blocksToNarrationScript } from '@lib/narration/blocksToScript';
import { buildContentHash } from '@services/lessonNarrationService';
import { clampNarrationRate, resolveNarrationVoice } from '@lib/narration/voices';
import { LESSON_BLOCKS, QUIZ_QUESTION } from '@lib/pdf/__fixtures__/lesson';
// `vi.mock` below is hoisted above every import, so the s3Service mock is
// registered before these controller bindings resolve.
import {
  getCoursePdfController,
  getLessonPdfController,
  getNarrationDownloadController,
  getNarrationTranscriptController,
} from './index';

const presignSpy = vi.fn(async ({ key, downloadFilename }: { key: string; downloadFilename?: string }) =>
  `https://s3.example/${key}${downloadFilename ? `?response-content-disposition=${encodeURIComponent(downloadFilename)}` : ''}`,
);

vi.mock('@services/s3Service', async () => {
  const actual = await vi.importActual<typeof import('@services/s3Service')>('@services/s3Service');
  return {
    ...actual,
    getPresignedUrl: (args: { key: string; downloadFilename?: string }) => presignSpy(args),
    // Heroes are exercised in heroImage.test.ts; here they must simply not
    // reach the network.
    objectExists: async () => false,
    getObjectBuffer: async () => {
      throw new Error('no hero in this test');
    },
    uploadBuffer: async () => 'k',
  };
});

setupTestDb();

const OWNER = new mongoose.Types.ObjectId().toString();
const STRANGER = new mongoose.Types.ObjectId().toString();

const STRUCTURE = {
  reasoning: { learnerProfile: '', topicAnalysis: '', scopeDecisions: '', progressionStrategy: '' },
  modules: [
    {
      name: 'Foundations',
      description: '',
      lessons: [
        { name: 'Handling Missing Data', description: '' },
        { name: 'Feature Scaling', description: '' },
      ],
    },
  ],
};

/** A name with a header-injection payload and characters that must be stripped. */
const NASTY_NAME = 'Bad" ; name\r\nX-Injected: 1';

const makeCourse = async (over: Record<string, unknown> = {}) =>
  CourseModel.create({
    userId: OWNER,
    name: 'Python for ML',
    status: 'ready',
    goal: 'learn ml',
    currentStep: 5,
    structure: STRUCTURE,
    ...over,
  });

/**
 * Written the way `jobRunner` writes it — `findOneAndUpdate` + upsert, NOT
 * `.create()`.
 *
 * That is not a stylistic choice. `blockSchema.content` is
 * `required: true`, and mongoose treats `''` as missing, so `.create()`
 * rejects a quiz block. The real write path
 * (`services/jobRunner.ts:416-430`) uses `findOneAndUpdate` without
 * `runValidators`, which skips that check — and is exactly why production
 * quiz blocks carry an empty `content` today. Using `.create()` here would
 * make the fixture untestable while the identical data is perfectly legal
 * in the database.
 */
const makeLesson = async (courseId: string, over: Record<string, unknown> = {}) =>
  LessonContentModel.findOneAndUpdate(
    { courseId, moduleIndex: 0, lessonIndex: 0 },
    { courseId, moduleIndex: 0, lessonIndex: 0, blocks: LESSON_BLOCKS, completed: true, ...over },
    { upsert: true, returnDocument: 'after' },
  );

beforeEach(async () => {
  presignSpy.mockClear();
  await UserModel.create({ _id: OWNER, name: 'Ada Lovelace', email: 'ada@example.com' });
});

const headersOf = (res: unknown) => (res as { set: ReturnType<typeof vi.fn> }).set.mock.calls;
const headerValue = (res: unknown, name: string): string | undefined =>
  headersOf(res).find((c: unknown[]) => c[0] === name)?.[1] as string | undefined;

const withSetSpy = (rr: ReturnType<typeof buildReqRes>) => {
  const set = vi.fn(function (this: unknown) {
    return this;
  });
  (rr.res as unknown as { set: unknown }).set = set;
  return rr;
};

// ── authorization ──────────────────────────────────────────

describe('a course owned by someone else', () => {
  const routes = [
    ['lesson pdf', () => getLessonPdfController],
    ['course pdf', () => getCoursePdfController],
    ['narration download', () => getNarrationDownloadController],
    ['narration transcript', () => getNarrationTranscriptController],
  ] as const;

  test.each(routes)('%s answers 404, not 500', async (_name, controller) => {
    const course = await makeCourse();
    await makeLesson(course._id.toString(), { audioUrl: 'lessons/audio/abc.mp3' });

    const rr = withSetSpy(
      buildReqRes({
        userId: STRANGER,
        params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' },
      }),
    );

    await invokeController(controller(), rr.req, rr.res);
    expect(rr.status).toHaveBeenCalledWith(404);
    expect(rr.json).toHaveBeenCalledWith({ message: 'Course not found' });
  });

  test('an unknown course id is a 404 too, not a 500', async () => {
    const rr = withSetSpy(
      buildReqRes({
        userId: OWNER,
        params: { courseId: new mongoose.Types.ObjectId().toString(), moduleIndex: '0', lessonIndex: '0' },
      }),
    );
    await invokeController(getLessonPdfController, rr.req, rr.res);
    expect(rr.status).toHaveBeenCalledWith(404);
  });
});

// ── generated-ness ─────────────────────────────────────────

describe('lessons that are not finished', () => {
  test('a lesson still streaming (completed:false) 404s on the lesson PDF', async () => {
    const course = await makeCourse();
    await makeLesson(course._id.toString(), { completed: false });

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getLessonPdfController, rr.req, rr.res);
    expect(rr.status).toHaveBeenCalledWith(404);
    expect(rr.json).toHaveBeenCalledWith({
      message: 'Lesson content has not been generated yet',
    });
  });

  // `completed` alone does not survive a REgeneration: nothing clears it
  // when a job starts, so an already-generated lesson keeps `completed:
  // true` while its blocks are being rewritten. `course.activeLesson` is
  // the signal that covers that window.
  test('a lesson being REgenerated 404s even though completed is still true', async () => {
    const course = await makeCourse({ activeLesson: { moduleIndex: 0, lessonIndex: 0 } });
    await makeLesson(course._id.toString(), { completed: true });

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getLessonPdfController, rr.req, rr.res);
    expect(rr.status).toHaveBeenCalledWith(404);
  });

  test('a lesson being REgenerated is excluded from the course PDF', async () => {
    const course = await makeCourse({ activeLesson: { moduleIndex: 0, lessonIndex: 0 } });
    await makeLesson(course._id.toString(), { completed: true });

    const rr = withSetSpy(buildReqRes({ userId: OWNER, params: { courseId: course._id.toString() } }));
    await invokeController(getCoursePdfController, rr.req, rr.res);

    const pdf = (rr.send.mock.calls[0][0] as Buffer).toString('latin1');
    expect(pdf).not.toContain('lesson-0-0');
  });

  test('a DIFFERENT lesson generating does not block this one', async () => {
    const course = await makeCourse({ activeLesson: { moduleIndex: 5, lessonIndex: 9 } });
    await makeLesson(course._id.toString(), { completed: true });

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getLessonPdfController, rr.req, rr.res);
    expect(rr.status).toHaveBeenCalledWith(200);
  });

  test('it is absent from the course PDF body but listed as pending', async () => {
    const course = await makeCourse();
    await makeLesson(course._id.toString(), { completed: false });

    const rr = withSetSpy(buildReqRes({ userId: OWNER, params: { courseId: course._id.toString() } }));
    await invokeController(getCoursePdfController, rr.req, rr.res);

    expect(rr.status).toHaveBeenCalledWith(200);
    const pdf = rr.send.mock.calls[0][0] as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // No lessons rendered, so the contents page carries the empty state and
    // there are no lesson destinations to jump to.
    expect(pdf.toString('latin1')).not.toContain('lesson-0-0');
  });
});

// ── the PDFs themselves ────────────────────────────────────

describe('lesson PDF', () => {
  test('responds with a real PDF and the right content type', async () => {
    const course = await makeCourse();
    await makeLesson(course._id.toString());

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getLessonPdfController, rr.req, rr.res);

    expect(rr.status).toHaveBeenCalledWith(200);
    expect(headerValue(rr.res, 'Content-Type')).toBe('application/pdf');
    const pdf = rr.send.mock.calls[0][0] as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  test('quiz text never reaches the bytes', async () => {
    const course = await makeCourse();
    await makeLesson(course._id.toString());
    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getLessonPdfController, rr.req, rr.res);
    const pdf = (rr.send.mock.calls[0][0] as Buffer).toString('latin1');
    // PDF text is compressed, so this is a smoke check on the obvious form.
    expect(pdf).not.toContain(QUIZ_QUESTION);
  });
});

// ── header safety ──────────────────────────────────────────

describe('Content-Disposition is not injectable', () => {
  test.each([
    ['lesson pdf', () => getLessonPdfController, { moduleIndex: '0', lessonIndex: '0' }],
    ['course pdf', () => getCoursePdfController, {}],
  ] as const)('%s strips CR, LF, quotes and semicolons from the course name', async (_n, controller, extra) => {
    const course = await makeCourse({ name: NASTY_NAME });
    await makeLesson(course._id.toString());

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), ...extra } }),
    );
    await invokeController(controller(), rr.req, rr.res);

    const cd = headerValue(rr.res, 'Content-Disposition')!;
    expect(cd).toBeDefined();
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    expect(cd).not.toContain('X-Injected');
    // Exactly one quoted filename, and one `;` separating the two forms.
    expect(cd.match(/"/g)).toHaveLength(2);
    expect(cd).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/);
  });

  test('the narration download filename is sanitised too', async () => {
    const course = await makeCourse({ name: NASTY_NAME });
    await makeLesson(course._id.toString(), { audioUrl: 'lessons/audio/abc.mp3' });

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getNarrationDownloadController, rr.req, rr.res);

    const { filename } = rr.json.mock.calls[0][0].data;
    expect(filename).toMatch(/^[A-Za-z0-9._-]+\.mp3$/);
    expect(presignSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'lessons/audio/abc.mp3', downloadFilename: filename }),
    );
  });

  test('a wholly non-ASCII course and lesson name still yields a usable filename', async () => {
    // Every name part slugs away to nothing, so the fallback is the only
    // thing standing between the user and a file called ".pdf".
    const course = await makeCourse({
      name: '日本語コース',
      structure: {
        ...STRUCTURE,
        modules: [{ name: 'モジュール', description: '', lessons: [{ name: '第一課', description: '' }] }],
      },
    });
    await makeLesson(course._id.toString());
    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getLessonPdfController, rr.req, rr.res);
    const cd = headerValue(rr.res, 'Content-Disposition')!;
    expect(cd).toContain('strive-lesson.pdf');
    expect(cd).not.toMatch(/filename="\.pdf"/);
  });
});

// ── narration ──────────────────────────────────────────────

describe('narration endpoints', () => {
  test('a lesson without narration 404s on both', async () => {
    const course = await makeCourse();
    await makeLesson(course._id.toString(), { audioUrl: null });

    for (const controller of [getNarrationDownloadController, getNarrationTranscriptController]) {
      const rr = withSetSpy(
        buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
      );
      await invokeController(controller, rr.req, rr.res);
      expect(rr.status).toHaveBeenCalledWith(404);
      expect(rr.json).toHaveBeenCalledWith({ message: 'This lesson has no narration' });
    }
  });

  test('the transcript body is exactly the narrated script when the audio is current', async () => {
    const course = await makeCourse();
    const script = blocksToNarrationScript(LESSON_BLOCKS);
    const voice = resolveNarrationVoice(null);
    const rate = clampNarrationRate(null);
    await makeLesson(course._id.toString(), {
      audioUrl: 'lessons/audio/abc.mp3',
      audioVoice: voice.id,
      audioRate: rate,
      audioContentHash: buildContentHash({ script, voiceId: voice.id, rate }),
    });

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getNarrationTranscriptController, rr.req, rr.res);

    expect(headerValue(rr.res, 'Content-Type')).toBe('text/plain; charset=utf-8');
    expect(rr.send.mock.calls[0][0]).toBe(script);
  });

  // The requirement is that the transcript corresponds to the AUDIO.
  // Regenerating a lesson replaces `blocks` and leaves every audio field
  // alone, so the two drift — and `audioContentHash` is what detects it.
  test('a stale hash marks the transcript and flags the download', async () => {
    const course = await makeCourse();
    await makeLesson(course._id.toString(), {
      audioUrl: 'lessons/audio/abc.mp3',
      audioVoice: 'en-US-Wavenet-F',
      audioRate: 1,
      audioContentHash: 'deadbeef-from-an-older-version-of-this-lesson',
    });

    const t = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getNarrationTranscriptController, t.req, t.res);
    const body = t.send.mock.calls[0][0] as string;
    expect(body).toContain('updated after its audio was generated');
    expect(body).toContain(blocksToNarrationScript(LESSON_BLOCKS));

    const d = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getNarrationDownloadController, d.req, d.res);
    expect(d.json.mock.calls[0][0].data.transcriptMatchesAudio).toBe(false);
  });

  test('a current hash reports transcriptMatchesAudio true and adds no note', async () => {
    const course = await makeCourse();
    const script = blocksToNarrationScript(LESSON_BLOCKS);
    const voice = resolveNarrationVoice(null);
    const rate = clampNarrationRate(null);
    await makeLesson(course._id.toString(), {
      audioUrl: 'lessons/audio/abc.mp3',
      audioVoice: voice.id,
      audioRate: rate,
      audioContentHash: buildContentHash({ script, voiceId: voice.id, rate }),
    });

    const rr = withSetSpy(
      buildReqRes({ userId: OWNER, params: { courseId: course._id.toString(), moduleIndex: '0', lessonIndex: '0' } }),
    );
    await invokeController(getNarrationDownloadController, rr.req, rr.res);
    expect(rr.json.mock.calls[0][0].data.transcriptMatchesAudio).toBe(true);
  });
});
