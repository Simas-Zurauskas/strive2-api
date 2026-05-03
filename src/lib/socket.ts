import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { decodeAuthToken } from '@lib/auth';
import UserModel from '@models/UserModel';
import { AuthProvider } from '@lib/constants';
import { ENVIRONMENT, FRONTEND_URL } from '@conf/env';
import { lifecycleLog } from '@lib/loggers';

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

  const user = await UserModel.findById(decoded.id)
    .select('tokenVersion emailVerified authProviders')
    .lean();

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

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);
    lifecycleLog.info(`socket:connect user=${userId} clients=${io.engine?.clientsCount ?? '?'}`);

    socket.on('disconnect', (reason) => {
      lifecycleLog.info(`socket:disconnect user=${userId} reason=${reason}`);
    });
  });

  return io;
};

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};
