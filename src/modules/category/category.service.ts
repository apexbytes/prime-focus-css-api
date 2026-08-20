import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { withTransaction } from '../../db/transaction.js';
import * as auditService from '../audit/audit.service.js';
import * as productService from '../product/product.service.js';
import type { CategoryRow } from './category.model.js';
import * as repository from './category.repository.js';

export async function listForProduct(
  productId: string,
  activeOnly: boolean,
  actor: Actor,
): Promise<CategoryRow[]> {
  await productService.assertAccess(actor, productId);
  return repository.listForProduct(productId, activeOnly);
}

/**
 * Validates that a category belongs to the ticket's product. Without this a
 * ticket could be filed under another product's taxonomy, which would quietly
 * corrupt every report that groups by category.
 */
export async function requireForProduct(
  categoryId: string,
  productId: string,
): Promise<CategoryRow> {
  const category = await repository.findById(categoryId);
  if (!category) {
    throw AppError.validation('Unknown category', {
      details: [{ field: 'categoryId', issue: 'no category exists with this id' }],
    });
  }

  if (category.productId !== productId) {
    throw AppError.validation('Category belongs to a different product', {
      details: [{ field: 'categoryId', issue: 'must belong to the ticket’s product' }],
    });
  }

  return category;
}

export async function create(
  input: {
    productId: string;
    name: string;
    description?: string | undefined;
    parentId?: string | undefined;
    sortOrder?: number | undefined;
  },
  actor: Actor,
): Promise<CategoryRow> {
  await productService.requireById(input.productId);

  if (input.parentId) {
    const parent = await requireForProduct(input.parentId, input.productId);
    if (parent.parentId) {
      // Two levels is enough for routing and reporting; deeper trees become
      // unmaintainable for agents choosing from a dropdown.
      throw AppError.badRequest('Categories may only be nested one level deep');
    }
  }

  return withTransaction(async ({ tx }) => {
    const category = await repository.insert(
      {
        productId: input.productId,
        name: input.name,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      tx,
    );

    await auditService.record(
      {
        action: 'category.created',
        entityType: 'category',
        entityId: category.id,
        after: category,
      },
      actor,
      tx,
    );
    return category;
  });
}

export async function update(
  id: string,
  patch: {
    name?: string | undefined;
    description?: string | null | undefined;
    sortOrder?: number | undefined;
    isActive?: boolean | undefined;
  },
  actor: Actor,
): Promise<CategoryRow> {
  const before = await repository.findById(id);
  if (!before) throw AppError.notFound('Category not found');

  return withTransaction(async ({ tx }) => {
    const row = await repository.update(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Category not found');

    await auditService.record(
      { action: 'category.updated', entityType: 'category', entityId: id, before, after: row },
      actor,
      tx,
    );
    return row;
  });
}

/**
 * Refuses to delete a category that tickets still reference — deactivating it
 * hides it from new tickets without rewriting history.
 */
export async function remove(id: string, actor: Actor): Promise<void> {
  const category = await repository.findById(id);
  if (!category) throw AppError.notFound('Category not found');

  const inUse = await repository.countTickets(id);
  if (inUse > 0) {
    throw AppError.conflict(
      `This category is used by ${inUse} ${inUse === 1 ? 'ticket' : 'tickets'}; deactivate it instead`,
    );
  }

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      { action: 'category.deleted', entityType: 'category', entityId: id, before: category },
      actor,
      tx,
    );
    await repository.remove(id, tx);
  });
}
