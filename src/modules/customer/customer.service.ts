import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as productService from '../product/product.service.js';
import type { CustomerRow, CustomerTier } from './customer.model.js';
import * as repository from './customer.repository.js';
import type { CustomerWithAccounts, ListCustomersFilter } from './customer.types.js';

const log = createModuleLogger('customer');

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findByEmail(email: string, exec?: Executor): Promise<CustomerRow | undefined> {
  return repository.findByEmail(normaliseEmail(email), exec);
}

/**
 * A customer, or nothing. For callers where absence is an ordinary outcome
 * rather than a 404 — a survey dispatch that finds the record deleted skips the
 * survey, it does not fail.
 */
export function findById(id: string, exec?: Executor): Promise<CustomerRow | undefined> {
  return repository.findById(id, exec);
}

export async function requireById(id: string): Promise<CustomerRow> {
  const customer = await repository.findById(id);
  if (!customer) throw AppError.notFound('Customer not found');
  return customer;
}

export function list(filter: ListCustomersFilter): Promise<CustomerRow[]> {
  return repository.list(filter);
}

export async function get(id: string): Promise<CustomerWithAccounts> {
  const customer = await requireById(id);
  return { ...customer, accounts: await repository.accounts(id) };
}

export async function create(
  input: {
    email: string;
    fullName: string;
    phone?: string | undefined;
    language?: string | undefined;
    tier?: CustomerTier | undefined;
    notes?: string | undefined;
  },
  actor: Actor,
): Promise<CustomerRow> {
  const email = normaliseEmail(input.email);
  if (await repository.findByEmail(email)) {
    throw AppError.conflict('A customer with this email already exists');
  }

  return withTransaction(async ({ tx }) => {
    const customer = await repository.insert(
      {
        email,
        fullName: input.fullName,
        phone: input.phone ?? null,
        ...(input.language ? { language: input.language } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        notes: input.notes ?? null,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'customer.created',
        entityType: 'customer',
        entityId: customer.id,
        // Deliberately not the whole row: the audit trail should not become a
        // second copy of every customer's contact details.
        after: { email: customer.email, tier: customer.tier },
      },
      actor,
      tx,
    );
    return customer;
  });
}

/**
 * Finds the customer behind an inbound email, creating a stub record when the
 * address is new. Called from the inbound pipeline, where there is no actor.
 */
export async function findOrCreateFromEmail(
  input: { email: string; fullName?: string | undefined },
  exec: Executor,
): Promise<{ customer: CustomerRow; created: boolean }> {
  const email = normaliseEmail(input.email);
  const existing = await repository.findByEmail(email, exec);
  if (existing) return { customer: existing, created: false };

  const customer = await repository.insert(
    {
      email,
      // Falling back to the local part gives agents something readable until the
      // customer's real name is known.
      fullName: input.fullName?.trim() || (email.split('@')[0] ?? email),
    },
    exec,
  );

  log.info('customer created from inbound email', { customerId: customer.id });
  return { customer, created: true };
}

export async function update(
  id: string,
  patch: {
    fullName?: string | undefined;
    phone?: string | null | undefined;
    language?: string | undefined;
    tier?: CustomerTier | undefined;
    notes?: string | null | undefined;
  },
  actor: Actor,
): Promise<CustomerWithAccounts> {
  const before = await requireById(id);

  await withTransaction(async ({ tx }) => {
    const row = await repository.update(
      id,
      {
        ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Customer not found');

    await auditService.record(
      {
        action: 'customer.updated',
        entityType: 'customer',
        entityId: id,
        before: { tier: before.tier, language: before.language },
        after: { tier: row.tier, language: row.language },
      },
      actor,
      tx,
    );
  });

  return get(id);
}

export async function addAccount(
  customerId: string,
  input: { productId: string; externalAccountId: string; status?: string | undefined },
  actor: Actor,
): Promise<CustomerWithAccounts> {
  await requireById(customerId);
  await productService.requireById(input.productId);

  await withTransaction(async ({ tx }) => {
    const account = await repository.addAccount(
      {
        customerId,
        productId: input.productId,
        externalAccountId: input.externalAccountId,
        status: input.status ?? null,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'customer.account_linked',
        entityType: 'customer',
        entityId: customerId,
        after: { productId: input.productId, accountId: account.id },
      },
      actor,
      tx,
    );
  });

  return get(customerId);
}

export async function removeAccount(
  customerId: string,
  accountId: string,
  actor: Actor,
): Promise<CustomerWithAccounts> {
  await requireById(customerId);

  await withTransaction(async ({ tx }) => {
    const removed = await repository.removeAccount(customerId, accountId, tx);
    if (!removed) throw AppError.notFound('Account link not found');

    await auditService.record(
      {
        action: 'customer.account_unlinked',
        entityType: 'customer',
        entityId: customerId,
        before: { accountId },
      },
      actor,
      tx,
    );
  });

  return get(customerId);
}

/**
 * Folds a duplicate record into the survivor: tickets and product accounts move
 * across, and the loser is soft-deleted with a pointer to where it went. The row
 * is kept rather than deleted so historic audit entries still resolve.
 *
 * Ticket reassignment lives here rather than in the ticket module because the
 * merge has to be one transaction.
 */
export async function merge(
  survivorId: string,
  duplicateId: string,
  actor: Actor,
): Promise<CustomerWithAccounts> {
  if (survivorId === duplicateId) {
    throw AppError.badRequest('A customer cannot be merged into itself');
  }

  const survivor = await requireById(survivorId);
  const duplicate = await requireById(duplicateId);

  await withTransaction(async ({ tx }) => {
    await repository.reassignAccounts(duplicateId, survivorId, tx);
    const movedTickets = await repository.reassignTickets(duplicateId, survivorId, tx);

    await repository.update(
      duplicateId,
      { mergedIntoCustomerId: survivorId, deletedAt: new Date() },
      tx,
    );

    await auditService.record(
      {
        action: 'customer.merged',
        entityType: 'customer',
        entityId: survivorId,
        before: { duplicateId, duplicateEmail: duplicate.email },
        after: { survivorId, survivorEmail: survivor.email, ticketsMoved: movedTickets },
      },
      actor,
      tx,
    );

    log.info('customers merged', { survivorId, duplicateId, ticketsMoved: movedTickets });
  });

  return get(survivorId);
}

// -- retention ---------------------------------------------------------------

/**
 * Anonymises customers with nothing on file since the cutoff.
 *
 * Returns how many it touched so the sweep can report progress and stop when a
 * batch comes back short. No actor: this is a scheduled obligation, not
 * something a person decides customer by customer.
 */
export async function anonymiseDormant(before: Date, limit: number): Promise<number> {
  const dormant = await repository.listDormantBefore(before, limit);

  for (const customer of dormant) {
    await withTransaction(async ({ tx }) => {
      await repository.anonymise(customer.id, tx);

      // The audit row names the customer being anonymised and nothing else:
      // recording the email we just removed would defeat the exercise.
      await auditService.record(
        {
          action: 'customer.anonymised',
          entityType: 'customer',
          entityId: customer.id,
          after: { reason: 'data retention period elapsed' },
        },
        { kind: 'system', name: 'retention.sweep' },
        tx,
      );
    });
  }

  return dormant.length;
}
