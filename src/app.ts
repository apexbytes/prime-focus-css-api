import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { API_PREFIX, corsOrigins, env } from './config/index.js';
import {
  correlationId,
  errorHandler,
  globalRateLimit,
  notFound,
  requestLogger,
} from './common/middleware/index.js';
import { healthRouter } from './modules/health/index.js';
import { v1Router } from './routes/v1.js';

/**
 * Builds the Express app without binding a port, so tests can drive it with
 * Supertest and the server file stays responsible only for the process.
 *
 * Middleware order is load-bearing:
 *   1. security headers, before anything can respond
 *   2. correlation id, so every subsequent log line is traceable
 *   3. request logger, registered before handlers so it sees every outcome
 *   4. body parsing, then routes
 *   5. notFound, then errorHandler — always last
 */
export function createApp(): Express {
  const app = express();

  // Behind nginx/an ALB: needed for correct client IPs in logs and rate limits.
  // A hop count rather than `true` — blanket trust lets a client spoof its IP.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins === '*' ? true : corsOrigins,
      credentials: true,
      exposedHeaders: ['x-request-id', 'idempotent-replay'],
    }),
  );
  app.use(compression());

  app.use(correlationId);
  app.use(requestLogger);

  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  app.use(globalRateLimit);

  app.use(healthRouter);
  app.use(API_PREFIX, v1Router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
