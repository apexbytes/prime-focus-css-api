import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/index.js';
import { beginShutdown } from './common/utils/lifecycle.js';
import { closeDatabase } from './db/client.js';
import { createModuleLogger, logger } from './lib/logger/index.js';

const log = createModuleLogger('server');

export function startServer(): Server {
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    log.info('server listening', {
      port: env.PORT,
      environment: env.NODE_ENV,
      version: env.APP_VERSION,
      commit: env.GIT_COMMIT_SHA,
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Keep-alive sockets with no active request would otherwise keep the
        // server open until their timeout elapses.
        server.closeIdleConnections();
      });
      log.info('http server closed');

      await closeDatabase();
      // Phase 4: await stopQueue() before the pool closes.

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
