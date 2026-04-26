import mongoose from 'mongoose';
import * as Sentry from '@sentry/node';
import type { CreditsUpdatedEvent } from '@src/types/socketEvents';
import { getIO } from './socket';

export type CreditsUpdatedPayload = CreditsUpdatedEvent;

/**
 * Push a credits:updated event to a specific user's socket room so the
 * client can invalidate React Query cache + animate the pill without
 * waiting for the next `/me` or `/billing/summary` poll.
 *
 * Fire-and-forget by design. If Socket.io throws (room empty, shutting
 * down), the error is captured to Sentry but doesn't bubble up — credit
 * accounting is the source of truth, socket is just a live-sync nicety.
 *
 * Single-instance only: `getIO()` returns a process-local server with the
 * in-memory adapter, so this event does not reach users connected to
 * other pods. See MONETIZATION.md §10 and CLAUDE.md "API is single-instance
 * only" for the follow-up (Redis adapter) needed before horizontal scaling.
 */
export const emitCreditsUpdated = ({
  userId,
  payload,
}: {
  userId: mongoose.Types.ObjectId | string;
  payload: CreditsUpdatedPayload;
}): void => {
  try {
    getIO()
      .to(`user:${userId.toString()}`)
      .emit('credits:updated', payload);
  } catch (err) {
    Sentry.captureException(err, { tags: { area: 'creditSocket.emit' } });
  }
};
