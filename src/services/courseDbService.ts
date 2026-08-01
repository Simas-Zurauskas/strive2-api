import CourseModel from '@models/CourseModel';
import { CourseDocument, ICourse } from '@models/CourseModel';
import { CourseSource } from '@lib/constants';
import { Types } from 'mongoose';

/**
 * Lean course shape — plain object with `_id`, no Mongoose methods. Returned
 * from `getUserCourseLean` and safe to pass straight into `res.json()`.
 */
export type LeanCourse = ICourse & { _id: Types.ObjectId };

/**
 * Server-only fields persisted on Course but never part of the public API
 * contract. The hydrated path runs `Course.toJSON()` which strips these,
 * but `.lean()` bypasses that transform — so any controller responding with
 * a lean Course (or array of them) must call this before `res.json()`.
 */
const SERVER_ONLY_COURSE_FIELDS = ['suggestedDesignPrompts', 'sourceDigest'] as const;

export const omitServerOnlyCourseFields = <T extends Partial<ICourse>>(course: T): T => {
  const out = { ...course };
  for (const key of SERVER_ONLY_COURSE_FIELDS) {
    delete (out as Record<string, unknown>)[key];
  }
  return out;
};

// ── Create ─────────────────────────────────────────────────

export const createCourse = async (params: {
  userId: string;
  goal: string;
  /** Course origin — `'documents'` for course-from-documents; omitted for the classic goal flow (persists null). */
  source?: CourseSource;
}): Promise<CourseDocument> => {
  const course = await CourseModel.create({
    userId: params.userId,
    goal: params.goal,
    ...(params.source ? { source: params.source } : {}),
  });

  return course;
};

// ── List ───────────────────────────────────────────────────

export const listUserCourses = async (params: { userId: string }): Promise<ICourse[]> => {
  const courses = await CourseModel.find({ userId: params.userId })
    .sort({ updatedAt: -1 })
    .lean();

  return courses;
};

// ── Get single ─────────────────────────────────────────────

const isObjectId = (value: string): boolean => /^[a-f0-9]{24}$/.test(value);

export const getUserCourse = async (params: {
  userId: string;
  courseId: string;
}): Promise<CourseDocument> => {
  // Resolution order is slug-first, then _id.
  //
  // Previously, anything matching /^[a-f0-9]{24}$/ went straight to
  // findById WITHOUT a userId filter. The post-load ownership check caught
  // the common case, but: (a) a course slug that happens to look like an
  // ObjectId would be misrouted to findById and silently load the wrong
  // course, and (b) the ownership error leaked timing info about the
  // existence of a course the caller shouldn't know about.
  //
  // Always scoping by userId, and trying slug first, avoids both issues.
  // Empty/null slugs are excluded by `{ slug: params.courseId }` which
  // can't match `slug: null`, so newly-created nameless courses still
  // resolve correctly via the _id fallback.
  let course = await CourseModel.findOne({ slug: params.courseId, userId: params.userId });

  if (!course && isObjectId(params.courseId)) {
    course = await CourseModel.findOne({ _id: params.courseId, userId: params.userId });
  }

  if (!course) {
    throw new Error('Course not found');
  }

  return course;
};

/**
 * Read-only variant of `getUserCourse`. Returns a plain object (no Mongoose
 * hydration / instance methods) — cheaper on the request path for controllers
 * that only need to read fields. Use `getUserCourse` when the caller intends
 * to mutate and `.save()`.
 *
 * Ownership, slug-first resolution, and error shape are identical to the
 * hydrated variant.
 */
export const getUserCourseLean = async (params: {
  userId: string;
  courseId: string;
}): Promise<LeanCourse> => {
  let course = await CourseModel.findOne({ slug: params.courseId, userId: params.userId })
    .select('-__v')
    .lean<LeanCourse>();

  if (!course && isObjectId(params.courseId)) {
    course = await CourseModel.findOne({ _id: params.courseId, userId: params.userId })
      .select('-__v')
      .lean<LeanCourse>();
  }

  if (!course) {
    throw new Error('Course not found');
  }

  return course;
};

// ── Update ─────────────────────────────────────────────────

export const updateCourse = async (params: {
  userId: string;
  courseId: string;
  updates: Partial<ICourse>;
}): Promise<CourseDocument> => {
  const course = await getUserCourse({ userId: params.userId, courseId: params.courseId });

  Object.assign(course, params.updates);
  await course.save();

  return course;
};
