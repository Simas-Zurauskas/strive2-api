import colors from 'colors';
import mongoose from 'mongoose';
import * as Sentry from '@sentry/node';
import CourseModel from '@models/CourseModel';
import JobModel from '@models/JobModel';
import LessonContentModel from '@models/LessonContentModel';

import { MONGO_URI } from './env';

const cleanupOrphanedJobs = async () => {
  try {
    const orphanedCourses = await CourseModel.find({ activeJobId: { $ne: null } }).lean();

    for (const course of orphanedCourses) {
      const job = await JobModel.findById(course.activeJobId).lean();

      if (!job || job.status === 'completed' || job.status === 'failed') {
        await CourseModel.findByIdAndUpdate(course._id, { activeJobId: null });
      } else {
        await JobModel.findByIdAndUpdate(course.activeJobId, {
          status: 'failed',
          error: 'Server restarted during processing',
        });
        await CourseModel.findByIdAndUpdate(course._id, { activeJobId: null });
      }
    }

    if (orphanedCourses.length > 0) {
      console.log(`[Startup] Cleaned up ${orphanedCourses.length} orphaned job reference(s)`.cyan);
    }

    // Delete partial content left by interrupted generations
    const deleted = await LessonContentModel.deleteMany({ completed: false });
    if (deleted.deletedCount > 0) {
      console.log(`[Startup] Deleted ${deleted.deletedCount} incomplete lesson content document(s)`.cyan);
    }
  } catch (error: unknown) {
    console.error('[Startup] Failed to clean up orphaned jobs:'.red, error);
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
    console.log(colors.cyan(`MongoDB Connected - ${conn.connection.host}`.bgCyan));

    await cleanupOrphanedJobs();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(colors.red(`MongoDB Connection failed - ${message}`));
    Sentry.captureException(error);
    process.exit(1);
  }
};

export default connectDB;
