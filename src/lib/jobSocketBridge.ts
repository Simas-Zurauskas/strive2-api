import { jobEvents } from '@services/jobEvents';
import { getIO } from './socket';

interface JobStartedPayload {
  jobId: string;
  courseId: string;
  type: string;
  userId: string;
}

interface JobUpdatePayload {
  jobId: string;
  status: 'completed' | 'failed';
  error?: string | null;
  courseId: string;
  type: string;
  userId: string;
}

export const initJobSocketBridge = () => {
  jobEvents.on('started', (payload: JobStartedPayload) => {
    getIO()
      .to(`user:${payload.userId}`)
      .emit('job:started', {
        jobId: payload.jobId,
        courseId: payload.courseId,
        type: payload.type,
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
      });
  });
};
