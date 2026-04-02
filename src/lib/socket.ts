import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { decodeAuthToken } from '@lib/auth';
import UserModel from '@models/UserModel';
import { ENVIRONMENT, FRONTEND_URL } from '@conf/env';

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
