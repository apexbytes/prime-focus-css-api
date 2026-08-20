import { db } from './client.js';
import { createModuleLogger } from '../lib/logger/index.js';

const log = createModuleLogger('db:transaction');

/** The transaction-scoped database handle. Repositories accept this or `db`. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What a repository function runs against: either the pool or an open
 * transaction. Repositories take this as their last argument, defaulted to the
 * pool, so a service can compose several of them into one atomic unit without
 * the repository knowing.
 */
export type Executor = typeof db | Transaction;

export interface TransactionContext {
  tx: Transaction;
  /**
   * Defer a side effect until the transaction commits. Domain events, queue
   * enqueues, and emails go here: publishing them inside the transaction risks
   * announcing a state change that then rolls back.
   */
  afterCommit: (effect: () => void | Promise<void>) => void;
}

/**
 * Wraps a unit of work that touches more than one table. Service methods own
 * transactions; repositories never open them.
 */
export async function withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
  const effects: (() => void | Promise<void>)[] = [];

  const result = await db.transaction(async (tx) =>
    fn({ tx, afterCommit: (effect) => effects.push(effect) }),
  );

  // Post-commit failures must not undo committed work or fail the request; they
  // are logged for retry by the owning job instead.
  for (const effect of effects) {
    try {
      await effect();
    } catch (error) {
      log.error('after-commit effect failed', { err: error });
    }
  }

  return result;
}
