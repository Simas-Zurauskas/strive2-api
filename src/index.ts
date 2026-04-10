import dotenv from 'dotenv';
dotenv.config();
import 'tsconfig-paths/register';
import 'colors';
import { createServer } from 'http';
import connectDB from '@conf/mongo';
import { API_URL, ENVIRONMENT, FRONTEND_URL, PORT } from '@conf/env';
import { errorHandler } from '@middleware/errorMiddleware';
import cors from 'cors';
import express from 'express';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mt from 'moment-timezone';
import swaggerSpec from '@middleware/swagger';
import swaggerUi from 'swagger-ui-express';
import { authRoutes } from '@routes/authRoutes';
import { courseRoutes } from '@routes/courseRoutes';
import { gamificationRoutes } from '@routes/gamificationRoutes';
import mongoose from 'mongoose';
import { getIO, initSocketIO } from '@lib/socket';
import { initJobSocketBridge } from '@lib/jobSocketBridge';
import { jobLimit } from '@services/jobRunner';
import { printGraphImages } from '@lib/ai/agents/printGraphImages';

mt.tz.setDefault('UTC');

connectDB();

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: ENVIRONMENT === 'production' ? FRONTEND_URL : '*',
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

if (ENVIRONMENT !== 'development') {
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 100,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { message: 'Too many requests, please try again later' },
      validate: { keyGeneratorIpFallback: false },
    }),
  );
}

app.get('/', (req, res) => {
  res.json({ service: 'Strive API', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/course', courseRoutes);
app.use('/api/gamification', gamificationRoutes);

app.get('/swagger.json', (req, res) => {
  res.status(200).json(swaggerSpec);
});

app.use(
  '/swagger',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customSiteTitle: 'Strive API',
    swaggerOptions: { filter: true },
  }),
);

app.use((req, res, next) => {
  res.status(404);
  const error = new Error('Not found');
  next(error);
});

Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

const server = createServer(app);
initSocketIO(server);
initJobSocketBridge();

server.listen(PORT, () => {
  console.log(`Server running on: ${API_URL}`.bgCyan);
  printGraphImages();
});

// ── Graceful shutdown ───────────────────────────────────

const gracefulShutdown = async (signal: string) => {
  console.log(`\n[Shutdown] ${signal} received, shutting down gracefully...`.yellow);

  server.close();
  getIO().close();

  const drainTimeout = 120_000; // Lesson generation takes 60-120s
  const start = Date.now();
  while (jobLimit.activeCount > 0 && Date.now() - start < drainTimeout) {
    console.log(`[Shutdown] Waiting for ${jobLimit.activeCount} active job(s) to finish...`.yellow);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (jobLimit.activeCount > 0) {
    console.log(`[Shutdown] ${jobLimit.activeCount} job(s) still running after timeout, forcing exit`.red);
  }

  await mongoose.connection.close();
  console.log('[Shutdown] MongoDB connection closed'.cyan);

  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
