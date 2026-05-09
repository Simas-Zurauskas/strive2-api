import { Request, Response, NextFunction } from 'express';
import { monetizationLog } from '@lib/loggers';

/**
 * Per-user cap on concurrent SSE chat streams. Each stream holds an HTTP
 * connection open and burns provider tokens for the duration; without a
 * cap, an attacker can open N parallel streams to amplify cost N× before
 * any debit lands.
 *
 * In-memory counter, per API process. Single-instance deployment per
 * CLAUDE.md, so this is sufficient until the deployment splits — at
 * which point a Redis adapter would replace this Map.
 *
 * Cap mirrors `MaxConcurrentJobs = 3` so the UX is uniform across job
 * types and chat ("you can run up to 3 things at once"). A safety
 * sweep removes entries with no cleanup signal after 10min — guards
 * against a stuck stream that never fires `res.on('close')`.
 */

const MAX_CONCURRENT_STREAMS_PER_USER = 3;
const STALE_ENTRY_MS = 10 * 60 * 1000;

type Entry = { startedAt: number };
const userStreams = new Map<string, Map<string, Entry>>();

const sweepStaleEntries = (): void => {
  const now = Date.now();
  for (const [userId, streams] of userStreams.entries()) {
    for (const [streamId, entry] of streams.entries()) {
      if (now - entry.startedAt > STALE_ENTRY_MS) {
        streams.delete(streamId);
      }
    }
    if (streams.size === 0) userStreams.delete(userId);
  }
};

// Background sweep — fires every 5 minutes. unref so it doesn't keep
// the process alive in tests/scripts.
const sweepHandle = setInterval(sweepStaleEntries, 5 * 60 * 1000);
sweepHandle.unref();

const release = (userId: string, streamId: string): void => {
  const streams = userStreams.get(userId);
  if (!streams) return;
  streams.delete(streamId);
  if (streams.size === 0) userStreams.delete(userId);
};

/**
 * Mount BEFORE the SSE controller. Tracks the connection in
 * `userStreams[userId]`, releases on `res.on('close')` (the standard SSE
 * teardown signal — fires on client disconnect AND on normal
 * controller-side `res.end()`).
 */
export const limitChatStreamConcurrency = (req: Request, res: Response, next: NextFunction): void => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const streams = userStreams.get(userId) ?? new Map<string, Entry>();
  if (streams.size >= MAX_CONCURRENT_STREAMS_PER_USER) {
    monetizationLog.info(
      `Stream concurrency cap hit: user=${userId} active=${streams.size} path=${req.method} ${req.originalUrl}`,
    );
    res.status(429).json({
      message: `You have ${MAX_CONCURRENT_STREAMS_PER_USER} chat streams already running. Stop one before starting another.`,
    });
    return;
  }

  // Use the request-scoped id stamped by `requestId` middleware; falls
  // back to a high-entropy random if the middleware isn't mounted.
  const streamId = req.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  streams.set(streamId, { startedAt: Date.now() });
  userStreams.set(userId, streams);

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release(userId, streamId);
  };
  res.on('close', releaseOnce);
  res.on('finish', releaseOnce);

  next();
};

// Test/diagnostic exports (not part of the public API surface).
export const _internalsForTests = { userStreams, sweepStaleEntries };
