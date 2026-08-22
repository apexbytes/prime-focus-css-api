import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/index.js';
import { beginShutdown } from './common/utils/lifecycle.js';
import { closeDatabase } from './db/client.js';
import { createModuleLogger, logger } from './lib/logger/index.js';
import { startSignals, stopSignals } from './lib/cache/index.js';
import { startQueue, stopQueue } from './lib/queue/index.js';
import { closeRedis } from './lib/redis/index.js';
import { stopSocketServer } from './lib/socket/index.js';
import { startChat } from './modules/chat/index.js';
import { startRealtime } from './modules/realtime/index.js';

const log = createModuleLogger('server');

export function startServer(): Server {
  const app = createApp();

  // After the listener, not before: a queue that cannot be reached must not stop
  // the API from serving traffic. Jobs are recoverable — `sla.scan` re-finds
  // whatever was missed — but a process that refuses to boot is not.
  void startQueue().catch((error: unknown) => {
    log.error('queue failed to start; jobs and schedules are not running', { err: error });
  });

  // Same argument: Redis carries cache invalidation between instances, and an
  // instance that cannot reach it still serves correctly — just with each cache
  // waiting out its own TTL.
  void startSignals().catch((error: unknown) => {
    log.error('cache signals not subscribed; invalidation is TTL-bound', { err: error });
  });

  const server = app.listen(env.PORT, () => {
    log.info('server listening', {
      port: env.PORT,
      environment: env.NODE_ENV,
      version: env.APP_VERSION,
      commit: env.GIT_COMMIT_SHA,
    });
  });

  // After the listener, because Socket.IO attaches to a bound server. A realtime
  // layer that fails to start leaves a console that polls, which is the same
  // bargain the queue makes.
  void startRealtime(server).catch((error: unknown) => {
    log.error('realtime server failed to start; the console will fall back to polling', {
      err: error,
    });
  });

  // Its own namespace on the same server, started after it for the same reason.
  // A chat gateway that fails to attach leaves the widget polling the REST
  // endpoints, which is why those exist.
  void startChat(server).catch((error: unknown) => {
    log.error('chat gateway failed to start; the widget will fall back to polling', {
      err: error,
    });
  });

  registerShutdownHandlers(server);
  return server;
}

/**
 * Graceful shutdown. On SIGTERM the process must stop being routed traffic
 * before it stops serving it, so readiness flips first, then in-flight requests
 * drain, and only then are connections to Postgres released.
 */
function registerShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.warn('second shutdown signal ignored', { signal });
      return;
    }
    shuttingDown = true;

    log.info('shutdown initiated', { signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
    beginShutdown();

    // Hard deadline: a stuck request must not hold the deploy open forever.
    const forceExit = setTimeout(() => {
      log.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Before the HTTP server closes: an open websocket keeps it alive, so a
      // graceful shutdown with sockets attached is just a slow timeout.
      stopSocketServer();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Keep-alive sockets with no active request would otherwise keep the
        // server open until their timeout elapses.
        server.closeIdleConnections();
      });
      log.info('http server closed');

      // Before the pool closes: a job still finishing needs a database.
      await stopQueue();
      await stopSignals();
      await closeDatabase();
      await closeRedis();

      clearTimeout(forceExit);
      log.info('shutdown complete');
      await flushLogs();
      process.exit(0);
    } catch (error) {
      log.error('error during shutdown', { err: error });
      await flushLogs();
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A process in an unknown state must not keep serving payment-adjacent
  // traffic: log, then let the orchestrator replace it.
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { err: error });
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { err: reason });
    void shutdown('unhandledRejection').finally(() => process.exit(1));
  });
}

/** Give Winston's transports a moment to flush before the process dies. */
function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    logger.once('finish', () => resolve());
    logger.end();
    setTimeout(resolve, 500).unref();
  });
}
