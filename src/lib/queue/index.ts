import { PgBoss } from 'pg-boss';
import { env, queueDriver } from '../../config/index.js';
import { createModuleLogger } from '../logger/index.js';

const log = createModuleLogger('queue');

/**
 * Every job name in the system, in one place, because a typo in a queue name is
 * silent: the producer enqueues onto a queue nothing is listening to.
 */
export const JOB = {
  ticketTriage: 'ticket.triage',
  ticketAutoassign: 'ticket.autoassign',
  slaScan: 'sla.scan',
  slaEscalate: 'sla.escalate',
  surveyDispatch: 'survey.dispatch',
  attachmentScan: 'attachment.scan',
  reportRefresh: 'report.refresh',
  notificationDigest: 'notification.digest',
  retentionSweep: 'retention.sweep',
  webhookDeliver: 'webhook.deliver',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * A handler takes the payload and nothing else. Jobs run with no request
 * context, so anything they need has to be in the payload or re-read from the
 * database — never carried over from the request that enqueued them.
 */
export type JobHandler<T> = (payload: T) => Promise<void>;

interface Registration {
  handler: JobHandler<never>;
  /** Cron expression, for jobs that run on a schedule rather than on an event. */
  cron?: string;
  /** Overrides the global worker count for a queue that must stay serial. */
  concurrency?: number;
}

const registry = new Map<JobName, Registration>();

/**
 * Declares who handles a job. Called during app assembly, before the queue is
 * started, and idempotent so repeated `createApp()` calls in tests do not stack
 * up duplicate handlers.
 */
export function registerHandler<T>(
  name: JobName,
  handler: JobHandler<T>,
  options: { cron?: string; concurrency?: number } = {},
): void {
  registry.set(name, {
    // Contravariance makes any concrete handler assignable to JobHandler<never>;
    // the payload type is re-asserted at dispatch, where the name is known.
    handler,
    ...(options.cron ? { cron: options.cron } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
  });
}

let boss: PgBoss | null = null;
let starting: Promise<void> | null = null;

export interface EnqueueOptions {
  /** Delay before the job becomes eligible to run. */
  startAfterSeconds?: number;
  /**
   * Collapses jobs that would do the same work. A second job with the same key,
   * while one is still queued, is discarded rather than duplicated.
   */
  singletonKey?: string;
  /**
   * Overrides the global retry limit for one job. Outbound webhook delivery
   * uses it: a receiver having a bad afternoon deserves more attempts than an
   * internal job whose failure means a bug.
   */
  retryLimit?: number;
}

/**
 * Hands a job to the queue.
 *
 * Never throws: a caller enqueues from an `afterCommit` hook, where the state
 * change is already durable and the only sane response to a queue failure is to
 * log it. Jobs that must not be lost are reconstructible from the database —
 * `sla.scan` re-finds anything `ticket.triage` dropped.
 */
export async function enqueue<T extends object>(
  name: JobName,
  payload: T,
  options: EnqueueOptions = {},
): Promise<void> {
  try {
    if (queueDriver === 'inline') {
      await runInline(name, payload);
      return;
    }

    if (!boss) {
      log.warn('job dropped: queue not started', { job: name });
      return;
    }

    await boss.send(name, payload, {
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      retryLimit: options.retryLimit ?? env.QUEUE_RETRY_LIMIT,
      retryBackoff: true,
      expireInSeconds: env.QUEUE_JOB_EXPIRY_SECONDS,
    });
  } catch (error) {
    log.error('failed to enqueue job', { job: name, err: error });
  }
}

async function runInline<T extends object>(name: JobName, payload: T): Promise<void> {
  const registration = registry.get(name);
  if (!registration) {
    log.warn('job dropped: no handler registered', { job: name, driver: 'inline' });
    return;
  }

  try {
    await (registration.handler as JobHandler<T>)(payload);
  } catch (error) {
    // Mirrors what pg-boss does with a failing job: record it and carry on. The
    // difference is that there is no retry, which is why `inline` is not a
    // production driver.
    log.error('inline job failed', { job: name, err: error });
  }
}

/**
 * Connects to pg-boss, declares a queue per registered job, attaches the
 * workers, and installs the cron schedules.
 *
 * pg-boss owns its own schema and migrates it on start, so this must run after
 * the application's own migrations but needs no migration of ours.
 */
export async function startQueue(): Promise<void> {
  if (queueDriver === 'inline') {
    log.warn('queue driver is inline: jobs run synchronously and no schedule will fire', {
      registered: registry.size,
    });
    return;
  }

  if (starting) return starting;

  starting = (async () => {
    const instance = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: env.QUEUE_SCHEMA,
      ...(env.DB_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
      // Its own small pool: job workers polling must not exhaust the connections
      // the HTTP request path needs.
      max: 3,
      application_name: 'prime-focus-css-queue',
    });

    // pg-boss reports background failures through events rather than rejections;
    // unhandled, they would be invisible.
    instance.on('error', (error) => log.error('queue error', { err: error }));

    await instance.start();

    for (const [name, registration] of registry) {
      await instance.createQueue(name, {
        retryLimit: env.QUEUE_RETRY_LIMIT,
        retryBackoff: true,
        expireInSeconds: env.QUEUE_JOB_EXPIRY_SECONDS,
      });

      await instance.work<object>(
        name,
        { localConcurrency: registration.concurrency ?? env.QUEUE_CONCURRENCY },
        // pg-boss 12 hands the worker a batch, even with the default batch size
        // of one. Failing the whole batch on one bad job would retry the others
        // needlessly, so each is caught on its own.
        async (jobs) => {
          for (const job of jobs) {
            try {
              await (registration.handler as JobHandler<object>)(job.data);
            } catch (error) {
              log.error('job failed', { job: name, jobId: job.id, err: error });
              throw error;
            }
          }
        },
      );

      if (registration.cron) {
        await instance.schedule(name, registration.cron, null, {
          tz: env.DEFAULT_TIMEZONE,
          singletonKey: name,
        });
      }
    }

    boss = instance;
    log.info('queue started', {
      schema: env.QUEUE_SCHEMA,
      queues: registry.size,
      schedules: [...registry.values()].filter((entry) => entry.cron).length,
    });
  })();

  try {
    await starting;
  } catch (error) {
    starting = null;
    throw error;
  }
}

/**
 * Lets in-flight jobs finish, then disconnects. Called during shutdown before
 * the application's own pool closes, so a running job still has a database.
 */
export async function stopQueue(): Promise<void> {
  if (!boss) return;

  const instance = boss;
  boss = null;
  starting = null;

  try {
    await instance.stop({ graceful: true, close: true, timeout: env.SHUTDOWN_TIMEOUT_MS });
    log.info('queue stopped');
  } catch (error) {
    log.error('error stopping queue', { err: error });
  }
}

export interface QueueHealth {
  state: 'ok' | 'unavailable' | 'not_configured';
  error?: string;
}

/**
 * Readiness probe. `inline` reports `not_configured` rather than `ok`: the
 * process is serviceable, but nothing is going to run a schedule, and an
 * operator reading `/readyz` should be able to see that.
 */
export async function checkQueue(): Promise<QueueHealth> {
  if (queueDriver === 'inline') return { state: 'not_configured' };
  if (!boss) return { state: 'unavailable', error: 'queue not started' };

  try {
    await boss.getQueues([JOB.slaScan]);
    return { state: 'ok' };
  } catch (error) {
    return { state: 'unavailable', error: error instanceof Error ? error.message : 'unknown' };
  }
}

export { queueDriver };
