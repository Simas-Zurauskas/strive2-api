import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { decodeAuthToken } from '@lib/auth';
import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import { ENVIRONMENT, FRONTEND_URL } from '@conf/env';
import { lifecycleLog } from '@lib/loggers';
import { captureError, captureWarning } from '@lib/errorReporter';

/**
 * ⚠️ SINGLE-INSTANCE DEPLOY ONLY.
 *
 * This module currently uses Socket.io's default in-memory adapter and the
 * in-process `jobEvents` EventEmitter (see services/jobEvents.ts). That
 * combination is fine for a single Node process but falls apart on a
 * multi-node deployment:
 *
 *   - A user connected to node A won't receive events emitted on node B —
 *     the `io.to('user:...')` call only reaches sockets in the emitting
 *     process. Job-complete notifications silently disappear.
 *   - The `jobRunner`'s pLimit queue is per-process, so two nodes won't
 *     coordinate on course-level `activeJobId` contention the way a single
 *     node does.
 *
 * To scale horizontally, add `@socket.io/redis-adapter` here (`io.adapter`)
 * and replace the `jobEvents` EventEmitter with Redis pub/sub. That plus a
 * distributed lock (or just moving `activeJobId` semantics onto a Redis
 * mutex) unblocks multi-instance. None of that lands here because it
 * requires a Redis URL in env.ts and infra coordination.
 */
let io: SocketIOServer;

// Per-user concurrent connection cap. 8 is generous enough to cover the
// real-world ceiling (one desktop + one mobile + a few duplicate tabs +
// devtools reload churn) while still bounding the RAM exhaustion vector
// where a signed-in user could otherwise open thousands of sockets to
// the in-memory adapter. The map is process-local — fresh on every
// restart, which is fine because socket lifetimes are too. Entries are
// dropped on the disconnect handler when count hits 0 so the map size
// tracks "currently connected users", not "ever connected".
const PER_USER_CONNECTION_CAP = 8;
const userSocketCounts = new Map<string, number>();

/**
 * Socket.io handshake middleware. Extracted as a named export so unit tests
 * can call it with a stub socket — the io.use callback shape matches what
 * Socket.io invokes internally on every connection.
 *
 * Mirrors HTTP `protect + requireVerified` gates: rejects missing/invalid
 * token, expired token, tokenVersion mismatch (post-logout), and unverified
 * credentials users. Google-only users skip the verified check (Google has
 * already verified the email).
 */
export const socketAuthMiddleware = async (
  socket: { handshake: { auth: { token?: string } }; data: { userId?: string } },
  next: (err?: Error) => void,
): Promise<void> => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Unauthorized'));
  }

  const decoded = decodeAuthToken(token);

  if (!decoded?.id) {
    return next(new Error('Unauthorized'));
  }

  // The DB lookup can throw (Mongo blip, network). Without a try/catch the
  // error escapes into Socket.io's middleware chain, the socket closes with
  // a generic "TransportError" the client can't act on, and we have no
  // breadcrumb of why. Treat genuine DB errors as 5xx-equivalent: capture +
  // reject the handshake.
  const user = await UserModel.findById(decoded.id)
    .select('tokenVersion emailVerified authProviders')
    .lean()
    .catch((err: unknown) => {
      captureError(err, {
        tags: { area: 'socket.io.auth', stage: 'user_lookup' },
        fingerprint: ['socket.io', 'auth', 'user_lookup'],
      });
      return null;
    });

  if (!user || decoded.tokenVersion !== user.tokenVersion) {
    return next(new Error('Unauthorized'));
  }

  // Mirror the HTTP `requireVerified` gate: unverified credential users
  // stay out of rooms until they confirm their email. Prevents them from
  // receiving job-complete events for work they shouldn't have triggered.
  const hasCredentials = user.authProviders.some((p) => p.provider === AuthProvider.CREDENTIALS);
  if (hasCredentials && !user.emailVerified) {
    return next(new Error('EMAIL_NOT_VERIFIED'));
  }

  socket.data.userId = decoded.id;
  next();
};

export const initSocketIO = (httpServer: HttpServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: ENVIRONMENT === 'production' ? FRONTEND_URL : '*',
      credentials: true,
    },
    path: '/socket.io',
  });

  io.use(socketAuthMiddleware);

  // Engine-level connection errors fire BEFORE `connection` — bad CORS,
  // bad transport, malformed handshake, a rejected `socketAuthMiddleware`.
  // Without an explicit listener these are dropped silently and the only
  // signal is a confused user reporting "the live updates don't work".
  // Tag with the engine error code so dashboards can split bad-token
  // (auth) from network/transport noise.
  io.engine.on('connection_error', (err: { code?: number; message?: string; context?: unknown }) => {
    lifecycleLog.warn(
      `socket:engine-error code=${err.code ?? '?'} msg=${err.message ?? '?'}`,
    );
    captureWarning('socket:engine-error', {
      tags: {
        area: 'socket.io',
        stage: 'engine.connection_error',
        code: err.code ?? -1,
      },
      extra: { message: err.message, context: err.context },
      // Same code repeated thousands of times during a CORS / token outage
      // collapses into one issue.
      fingerprint: ['socket.io', 'engine.connection_error', String(err.code ?? -1)],
    });
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;

    // Per-user connection cap — 8 covers desktop + mobile + a couple of
    // tab duplicates. Without this gate, a signed-in attacker can open
    // arbitrarily many sockets, each holding RAM in the in-memory adapter
    // and re-broadcasting room emits. The check + increment is in a
    // single synchronous block before `socket.join`, so a small race
    // (two connections passing the check in the same tick before either
    // increments) bounded by N parallel handshakes is acceptable. The
    // Map cleans up zero-count entries to bound memory growth.
    const current = userSocketCounts.get(userId) ?? 0;
    if (current >= PER_USER_CONNECTION_CAP) {
      lifecycleLog.warn(
        `socket:cap-hit user=${userId} count=${current} cap=${PER_USER_CONNECTION_CAP} — rejecting new connection`,
      );
      socket.emit('error', { message: 'Too many concurrent connections' });
      socket.disconnect(true);
      return;
    }
    userSocketCounts.set(userId, current + 1);

    socket.join(`user:${userId}`);
    lifecycleLog.info(`socket:connect user=${userId} clients=${io.engine?.clientsCount ?? '?'}`);

    // Per-socket runtime errors (handler throws, transport faults after
    // handshake). Keep the userId so we can correlate to a real account.
    socket.on('error', (err: Error) => {
      lifecycleLog.warn(
        `socket:runtime-error user=${userId} msg=${err?.message ?? String(err)}`,
      );
      captureError(err, {
        tags: { area: 'socket.io', stage: 'socket.error' },
        extra: { userId, socketId: socket.id },
        fingerprint: ['socket.io', 'socket.error'],
      });
    });

    socket.on('disconnect', (reason) => {
      // Decrement, clamping at 0 in case of double-disconnect or other
      // edge cases. Drop the entry entirely when it hits 0 so the Map
      // doesn't accumulate one row per ever-connected user.
      const next = (userSocketCounts.get(userId) ?? 1) - 1;
      if (next <= 0) {
        userSocketCounts.delete(userId);
      } else {
        userSocketCounts.set(userId, next);
      }
      lifecycleLog.info(`socket:disconnect user=${userId} reason=${reason}`);
    });
  });

  return io;
};

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};
