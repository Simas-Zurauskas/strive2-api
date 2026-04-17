import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { decodeAuthToken } from '@lib/auth';
import UserModel from '@models/UserModel';
import { ENVIRONMENT, FRONTEND_URL } from '@conf/env';

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

export const initSocketIO = (httpServer: HttpServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: ENVIRONMENT === 'production' ? FRONTEND_URL : '*',
      credentials: true,
    },
    path: '/socket.io',
  });

  // JWT authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;

    if (!token) {
      return next(new Error('Unauthorized'));
    }

    const decoded = decodeAuthToken(token);

    if (!decoded?.id) {
      return next(new Error('Unauthorized'));
    }

    const user = await UserModel.findById(decoded.id).select('tokenVersion').lean();

    if (!user || decoded.tokenVersion !== user.tokenVersion) {
      return next(new Error('Unauthorized'));
    }

    socket.data.userId = decoded.id;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);
    console.log(`[Socket.io] User ${userId} connected`.gray);

    socket.on('disconnect', () => {
      console.log(`[Socket.io] User ${userId} disconnected`.gray);
    });
  });

  return io;
};

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};
