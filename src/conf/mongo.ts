import mongoose from 'mongoose';
import * as Sentry from '@sentry/node';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import LessonContentModel from '@models/LessonContentModel';
import { deleteByPrefix } from '@services/s3Service';
import { bgError } from '@lib/bg';
import { lifecycleLog, jobLog } from '@lib/loggers';

import { MONGO_URI } from './env';

export const cleanupOrphanedJobs = async () => {
  try {
    // Step 1: fail every in-flight job in one sweep.
    //
    // This runs before the server accepts traffic (see connectDB awaiters in
    // index.ts), so nothing in this process could have created a legitimate
    // in-flight job yet — any `pending` or `processing` row is a carcass
    // from the previous run. Covers three carcass classes in one update:
    //   (a) jobs whose course still points at them  →  locked courses
    //   (b) jobs whose course had `activeJobId` cleared elsewhere  →  zombies
    //   (c) jobs created by `submitJob` where the process crashed between
    //       `JobModel.create` and the `activeJobId` claim step  →  orphans
    const now = new Date();
    const failed = await JobModel.updateMany(
      { status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'failed', error: 'Server restarted during processing', completedAt: now } },
    );
    if (failed.modifiedCount > 0) {
      jobLog.warn(`reaper:swept count=${failed.modifiedCount} reason=server_restart`);
    }

    // Step 2: clear every course.activeJobId + activeLesson. No in-flight
    // job exists anywhere after Step 1, so any remaining pointer is stale.
    // Single sweep is O(1) queries vs the previous per-course N+1 loop.
    const cleared = await CourseModel.updateMany(
      { $or: [{ activeJobId: { $ne: null } }, { activeLesson: { $ne: null } }] },
      { $set: { activeJobId: null, activeLesson: null } },
    );
    if (cleared.modifiedCount > 0) {
      jobLog.info(`reaper:cleared-activeJob count=${cleared.modifiedCount}`);
    }

    // Delete partial content left by interrupted generations. Enumerate first so
    // we can fire S3 cleanup per (courseId, moduleIndex, lessonIndex) — the course
    // itself may still have good completed lessons, so we can't drop the whole
    // `lessons/{courseId}/` prefix.
    const incomplete = await LessonContentModel
      .find({ completed: false })
      .select('courseId moduleIndex lessonIndex')
      .lean();

    for (const row of incomplete) {
      deleteByPrefix(`lessons/${row.courseId}/${row.moduleIndex}/${row.lessonIndex}/`)
        .catch(bgError('startupReaper.s3'));
    }

    const deleted = await LessonContentModel.deleteMany({ completed: false });
    if (deleted.deletedCount > 0) {
      jobLog.info(`reaper:deleted-incomplete-content count=${deleted.deletedCount}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    jobLog.error(`reaper:fail msg=${message}`);
    Sentry.captureException(error);
  }
};

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', true);
    mongoose.set('strictPopulate', false);
    const conn = await mongoose.connect(MONGO_URI, {
      maxPoolSize: 50,
      minPoolSize: 10,
    });
    lifecycleLog.info(`mongo:connect host=${conn.connection.host} pool=10-50`);

    // Reconcile indexes whose spec has changed since last boot (Mongoose's
    // autoIndex only *adds* missing indexes; it won't drop an existing index
    // whose options have diverged, e.g. `sparse: true` → `partialFilterExpression`).
    try {
      await CourseModel.syncIndexes();
      lifecycleLog.info('mongo:indexes-synced model=Course');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lifecycleLog.error(`mongo:indexes-sync-fail model=Course msg=${message}`);
      Sentry.captureException(error);
    }

    await cleanupOrphanedJobs();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    lifecycleLog.error(`mongo:connect-fail msg=${message} — refusing to boot`);
    Sentry.captureException(error);
    process.exit(1);
  }
};

export default connectDB;
