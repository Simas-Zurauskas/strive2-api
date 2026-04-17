import CourseModel from '@models/CourseModel';
import { CourseDocument, ICourse } from '@models/CourseModel';

// ── Create ─────────────────────────────────────────────────

export const createCourse = async (params: { userId: string; goal: string }): Promise<CourseDocument> => {
  const course = await CourseModel.create({
    userId: params.userId,
    goal: params.goal,
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
