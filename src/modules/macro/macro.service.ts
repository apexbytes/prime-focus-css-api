import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { withTransaction } from '../../db/transaction.js';
import * as auditService from '../audit/audit.service.js';
import * as customerService from '../customer/customer.service.js';
import * as productService from '../product/product.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import type { MacroRow } from './macro.model.js';
import * as repository from './macro.repository.js';
import type { AppliedMacro, MacroActions } from './macro.types.js';

export async function listForProduct(
  productId: string | undefined,
  actor: Actor,
): Promise<MacroRow[]> {
  if (productId) await productService.assertAccess(actor, productId);
  return repository.listForProduct(productId);
}

export async function create(
  input: {
    name: string;
    productId?: string | undefined;
    body?: string | undefined;
    actions: MacroActions;
  },
  actor: Actor,
): Promise<MacroRow> {
  if (input.productId) await productService.requireById(input.productId);

  return withTransaction(async ({ tx }) => {
    const macro = await repository.insert(
      {
        name: input.name,
        productId: input.productId ?? null,
        body: input.body ?? null,
        actions: input.actions,
        createdByUserId: isUserActor(actor) ? actor.id : null,
      },
      tx,
    );

    await auditService.record(
      { action: 'macro.created', entityType: 'macro', entityId: macro.id, after: macro },
      actor,
      tx,
    );
    return macro;
  });
}

export async function update(
  id: string,
  patch: {
    name?: string | undefined;
    body?: string | null | undefined;
    actions?: MacroActions | undefined;
    isActive?: boolean | undefined;
  },
  actor: Actor,
): Promise<MacroRow> {
  const before = await repository.findById(id);
  if (!before) throw AppError.notFound('Macro not found');

  return withTransaction(async ({ tx }) => {
    const row = await repository.update(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.actions !== undefined ? { actions: patch.actions } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Macro not found');

    await auditService.record(
      { action: 'macro.updated', entityType: 'macro', entityId: id, before, after: row },
      actor,
      tx,
    );
    return row;
  });
}

export async function remove(id: string, actor: Actor): Promise<void> {
  const macro = await repository.findById(id);
  if (!macro) throw AppError.notFound('Macro not found');

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      { action: 'macro.deleted', entityType: 'macro', entityId: id, before: macro },
      actor,
      tx,
    );
    await repository.remove(id, tx);
  });
}

/**
 * Applies a macro's field changes and returns its rendered reply text.
 *
 * The reply is deliberately *not* sent: the agent reviews and posts it. A macro
 * that emailed a customer on click would make a misfire unrecoverable.
 */
export async function apply(
  macroId: string,
  ticketId: string,
  actor: Actor,
): Promise<AppliedMacro> {
  const macro = await repository.findById(macroId);
  if (!macro || !macro.isActive) throw AppError.notFound('Macro not found');

  const ticket = await ticketService.requireAccessible(ticketId, actor);

  if (macro.productId && macro.productId !== ticket.productId) {
    throw AppError.validation('That macro belongs to a different product', {
      details: [{ field: 'macroId', issue: 'macro and ticket products must match' }],
    });
  }

  const actions = (macro.actions ?? {}) as MacroActions;

  if (actions.status || actions.priority || actions.categoryId) {
    await ticketService.updateFields(
      ticketId,
      {
        ...(actions.status ? { status: actions.status } : {}),
        ...(actions.priority ? { priority: actions.priority } : {}),
        ...(actions.categoryId ? { categoryId: actions.categoryId } : {}),
      },
      actor,
    );
  }

  for (const tag of actions.addTags ?? []) {
    await ticketService.addTag(ticketId, tag, actor);
  }

  if (actions.assignTo === 'self' && isUserActor(actor)) {
    await ticketService.assign(ticketId, actor.id, `macro: ${macro.name}`, actor);
  } else if (actions.assignTo === 'unassign') {
    await ticketService.assign(ticketId, null, `macro: ${macro.name}`, actor);
  }

  const customer = await customerService.requireById(ticket.customerId);

  return {
    ticketId,
    macroId,
    body: macro.body ? render(macro.body, { ticket, customer, actor }) : null,
    applied: actions,
  };
}

/**
 * Minimal placeholder substitution. Deliberately not a template engine: macro
 * bodies are written by administrators, and anything evaluating expressions from
 * the database would be a code-execution hole.
 */
function render(
  template: string,
  context: {
    ticket: { reference: string; subject: string };
    customer: { fullName: string; email: string };
    actor: Actor;
  },
): string {
  const values: Record<string, string> = {
    'ticket.reference': context.ticket.reference,
    'ticket.subject': context.ticket.subject,
    'customer.fullName': context.customer.fullName,
    'customer.firstName': context.customer.fullName.split(' ')[0] ?? context.customer.fullName,
    'agent.fullName': isUserActor(context.actor) ? context.actor.fullName : 'Prime Focus Support',
  };

  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => values[key] ?? match);
}
