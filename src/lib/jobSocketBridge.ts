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

// Live per-job progress payload. Used by generate_lesson to stream individual
// agent events (block, hero_image, content_ready, insights_saved) to the
// client. `event` mirrors the writer shape the LangGraph nodes produce —
// preserved verbatim so adding a new event type on the server doesn't require
// a client-side schema change.
export interface JobProgressPayload {
  jobId: string;
  userId: string;
  courseId: string;
  type: string;
  moduleIndex?: number;
  lessonIndex?: number;
  event: Record<string, unknown>;
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

  jobEvents.on('progress', (payload: JobProgressPayload) => {
    getIO()
      .to(`user:${payload.userId}`)
      .emit('job:progress', {
        jobId: payload.jobId,
        courseId: payload.courseId,
        type: payload.type,
        moduleIndex: payload.moduleIndex,
        lessonIndex: payload.lessonIndex,
        event: payload.event,
      });
  });
};
