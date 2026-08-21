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
import { emailWebhookRouter } from './modules/email/index.js';
import { healthRouter } from './modules/health/index.js';
import { v1Router } from './routes/v1.js';
import { registerJobHandlers } from './workers/index.js';

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
  // Pure bookkeeping (see workers/index.ts): maps job names to handlers so the
  // queue has something to dispatch to. Opening the queue itself is server.ts's
  // job, so tests that only build the app never connect to one.
  registerJobHandlers();

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

  app.use(
    express.json({
      limit: env.BODY_LIMIT,
      // Webhook signatures cover the bytes as sent, so the raw buffer has to
      // survive parsing.
      verify: (req, _res, buffer) => {
        (req as express.Request).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  /**
   * Provider webhooks mount ahead of the rate limiter: they are authenticated by
   * signature rather than by a token, and throttling them would mean dropping
   * customer email during exactly the spike support most needs to see.
   */
  app.use(`${API_PREFIX}/webhooks/resend`, emailWebhookRouter);

  app.use(globalRateLimit);

  app.use(healthRouter);
  app.use(API_PREFIX, v1Router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
