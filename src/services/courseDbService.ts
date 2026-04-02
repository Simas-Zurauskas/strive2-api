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

export const getUserCourse = async (params: {
  userId: string;
  courseId: string;
}): Promise<CourseDocument> => {
  const course = await CourseModel.findById(params.courseId);

  if (!course) {
    throw new Error('Course not found');
  }

  if (course.userId.toString() !== params.userId) {
    throw new Error('Forbidden');
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
