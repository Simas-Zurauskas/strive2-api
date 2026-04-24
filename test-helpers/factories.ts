import { hash } from 'bcryptjs';
import mongoose from 'mongoose';
import UserModel, { IUser, UserDocument } from '@models/UserModel';
import CourseModel, { CourseDocument, ICourse } from '@models/CourseModel';
import JobModel, { IJob, JobDocument } from '@models/JobModel';
import LessonContentModel from '@models/LessonContentModel';
import InsightModel from '@models/InsightModel';
import UserInsightProgressModel from '@models/UserInsightProgressModel';
import UserGamificationModel from '@models/UserGamificationModel';
import { AuthProvider } from '@lib/constants';
import { PLANS } from '@lib/creditPricing';

/**
 * Test fixture factories. Each factory writes a row to the in-memory Mongo
 * (set up by `setupTestDb`) and returns the hydrated document so call sites
 * can read `_id` etc. immediately. Defaults are minimal-but-valid; pass
 * `overrides` to set whatever the test cares about.
 */

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

let userCounter = 0;

export const makeUser = async (
  overrides: Partial<IUser> & { plainPassword?: string } = {},
): Promise<UserDocument> => {
  userCounter += 1;
  const plain = overrides.plainPassword;
  const password =
    overrides.password ??
    (plain ? await hash(plain, 10) : await hash('test-password', 10));

  // The schema's default for `credits` builds a fresh free-period window
  // with PLANS.free.monthlyAllowance. Tests that need different credits
  // can pass `credits: { ... }` in overrides; we don't try to merge
  // partials because the credits subdoc must be complete.
  return UserModel.create({
    email: overrides.email ?? `test-${userCounter}-${Date.now()}@example.com`,
    name: overrides.name ?? `Test User ${userCounter}`,
    password,
    emailVerified: overrides.emailVerified ?? true,
    authProviders: overrides.authProviders ?? [{ provider: AuthProvider.CREDENTIALS }],
    tokenVersion: overrides.tokenVersion ?? 0,
    favoriteCourseIds: overrides.favoriteCourseIds ?? [],
    ...(overrides.subscription ? { subscription: overrides.subscription } : {}),
    ...(overrides.credits ? { credits: overrides.credits } : {}),
    ...(overrides.emailVerificationToken !== undefined
      ? { emailVerificationToken: overrides.emailVerificationToken }
      : {}),
    ...(overrides.emailVerificationExpiry !== undefined
      ? { emailVerificationExpiry: overrides.emailVerificationExpiry }
      : {}),
    ...(overrides.passwordResetToken !== undefined
      ? { passwordResetToken: overrides.passwordResetToken }
      : {}),
    ...(overrides.passwordResetExpiry !== undefined
      ? { passwordResetExpiry: overrides.passwordResetExpiry }
      : {}),
  });
};

let courseCounter = 0;

export const makeCourse = async (
  overrides: DeepPartial<ICourse> & { userId: mongoose.Types.ObjectId | string },
): Promise<CourseDocument> => {
  courseCounter += 1;
  return CourseModel.create({
    userId: overrides.userId,
    name: overrides.name ?? `Test Course ${courseCounter}`,
    slug: overrides.slug ?? `test-course-${courseCounter}-${Date.now()}`,
    status: overrides.status ?? 'ready',
    goal: overrides.goal ?? 'Learn something useful',
    domain: overrides.domain ?? null,
    structure: overrides.structure ?? null,
    answers: overrides.answers ?? null,
    depth: overrides.depth ?? null,
    activeJobId: overrides.activeJobId ?? null,
    activeLesson: overrides.activeLesson ?? null,
  });
};

export const makeJob = async (
  overrides: Partial<IJob> & {
    userId: mongoose.Types.ObjectId | string;
    courseId: mongoose.Types.ObjectId | string;
  },
): Promise<JobDocument> => {
  return JobModel.create({
    userId: overrides.userId,
    courseId: overrides.courseId,
    type: overrides.type ?? 'generate_lesson',
    status: overrides.status ?? 'pending',
    error: overrides.error ?? null,
    metadata: overrides.metadata ?? null,
    completedAt: overrides.completedAt ?? null,
  });
};

export const makeLessonContent = async (params: {
  courseId: mongoose.Types.ObjectId | string;
  moduleIndex?: number;
  lessonIndex?: number;
  completed?: boolean;
  blocks?: { id: string; type: string; content: string; order: number }[];
}) => {
  return LessonContentModel.create({
    courseId: params.courseId,
    moduleIndex: params.moduleIndex ?? 0,
    lessonIndex: params.lessonIndex ?? 0,
    blocks: params.blocks ?? [{ id: 'b1', type: 'intro', content: 'hello', order: 0 }],
    heroImageUrl: null,
    audioUrl: null,
    summary: null,
    completed: params.completed ?? true,
    version: 1,
  });
};

export const makeInsight = async (params: {
  courseId: mongoose.Types.ObjectId | string;
  lessonId: mongoose.Types.ObjectId | string;
  moduleIndex?: number;
  lessonIndex?: number;
  kind?: 'qa' | 'cloze';
  prompt?: string;
  answer?: string;
  conceptTags?: string[];
}) => {
  return InsightModel.create({
    courseId: params.courseId,
    lessonId: params.lessonId,
    moduleIndex: params.moduleIndex ?? 0,
    lessonIndex: params.lessonIndex ?? 0,
    kind: params.kind ?? 'qa',
    prompt: params.prompt ?? 'What is the capital of France?',
    answer: params.answer ?? 'Paris',
    conceptTags: params.conceptTags ?? ['geography'],
    sourceBlockId: 'b1',
  });
};

export const makeInsightProgress = async (params: {
  userId: mongoose.Types.ObjectId | string;
  insightId: mongoose.Types.ObjectId | string;
  box?: number;
  nextDue?: Date;
  mode?: 'tap-reveal' | 'typed-recall';
  masteredAt?: Date | null;
  reps?: number;
  lapses?: number;
  state?: 'new' | 'learning' | 'review' | 'relearning';
}) => {
  return UserInsightProgressModel.create({
    userId: params.userId,
    insightId: params.insightId,
    box: params.box ?? 0,
    reps: params.reps ?? 0,
    lapses: params.lapses ?? 0,
    state: params.state ?? 'new',
    nextDue: params.nextDue ?? new Date(),
    mode: params.mode ?? 'tap-reveal',
    masteredAt: params.masteredAt ?? null,
    history: [],
  });
};

/**
 * Build a paid-subscription subdoc on top of a user. Useful for billing
 * tests that need a Stripe-backed customer rather than the default Free.
 */
export const subscribeUser = async (params: {
  userId: mongoose.Types.ObjectId | string;
  plan: 'starter' | 'pro' | 'studio';
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  bonusBalance?: number;
}) => {
  const plan = params.plan;
  const allowance = PLANS[plan].monthlyAllowance;
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return UserModel.findByIdAndUpdate(
    params.userId,
    {
      $set: {
        'subscription.plan': plan,
        'subscription.status': 'active',
        'subscription.stripeCustomerId': params.stripeCustomerId ?? `cus_test_${Date.now()}`,
        'subscription.stripeSubscriptionId': params.stripeSubscriptionId ?? `sub_test_${Date.now()}`,
        'subscription.currentPeriodStart': now,
        'subscription.currentPeriodEnd': periodEnd,
        'subscription.cancelAtPeriodEnd': false,
        'credits.allowanceBalance': allowance,
        'credits.allowanceGranted': allowance,
        'credits.periodStart': now,
        'credits.periodEnd': periodEnd,
        'credits.bonusBalance': params.bonusBalance ?? 0,
      },
    },
    { new: true },
  );
};

/**
 * Re-export the model handles so test files don't have to chase the path
 * alias themselves. Common case: a test that needs to assert directly on
 * a stored row.
 */
export { UserModel, CourseModel, JobModel, LessonContentModel, InsightModel, UserInsightProgressModel, UserGamificationModel };
