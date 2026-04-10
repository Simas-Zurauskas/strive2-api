import { jobEvents } from '@services/jobEvents';
import { getIO } from './socket';

interface JobStartedPayload {
  jobId: string;
  courseId: string;
  type: string;
  userId: string;
  moduleIndex?: number;
  lessonIndex?: number;
}

interface JobUpdatePayload {
  jobId: string;
  status: 'completed' | 'failed';
  error?: string | null;
  courseId: string;
  type: string;
  userId: string;
  moduleIndex?: number;
  lessonIndex?: number;
}

export const initJobSocketBridge = () => {
  jobEvents.on('started', (payload: JobStartedPayload) => {
    getIO()
      .to(`user:${payload.userId}`)
      .emit('job:started', {
        jobId: payload.jobId,
        courseId: payload.courseId,
        type: payload.type,
        moduleIndex: payload.moduleIndex,
        lessonIndex: payload.lessonIndex,
      });
  });

  jobEvents.on('update', (payload: JobUpdatePayload) => {
    getIO()
      .to(`user:${payload.userId}`)
      .emit('job:status', {
        jobId: payload.jobId,
        status: payload.status,
        error: payload.error,
        courseId: payload.courseId,
        type: payload.type,
        moduleIndex: payload.moduleIndex,
        lessonIndex: payload.lessonIndex,
      });
  });
};
