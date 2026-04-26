import { jobEvents } from '@services/jobEvents';
import type {
  JobStartedEvent,
  JobStatusEvent,
  JobProgressEvent,
} from '@src/types/socketEvents';
import { getIO } from './socket';

// Internal event-bus payloads carry `userId` (used to route to the per-user
// socket room) in addition to the public event shape sent over the wire.

type JobStartedInternal = JobStartedEvent & { userId: string };
type JobStatusInternal = JobStatusEvent & { userId: string };
type JobProgressInternal = JobProgressEvent & { userId: string };

// Re-export the public payload type under its historical name so callers
// that still import `JobProgressPayload` from this module keep working.
export type JobProgressPayload = JobProgressInternal;

export const initJobSocketBridge = () => {
  jobEvents.on('started', (payload: JobStartedInternal) => {
    const { userId, ...event } = payload;
    getIO().to(`user:${userId}`).emit('job:started', event satisfies JobStartedEvent);
  });

  jobEvents.on('update', (payload: JobStatusInternal) => {
    const { userId, ...event } = payload;
    getIO().to(`user:${userId}`).emit('job:status', event satisfies JobStatusEvent);
  });

  jobEvents.on('progress', (payload: JobProgressInternal) => {
    const { userId, ...event } = payload;
    getIO().to(`user:${userId}`).emit('job:progress', event satisfies JobProgressEvent);
  });
};
