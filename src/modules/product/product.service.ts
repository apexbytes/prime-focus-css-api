import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as roleService from '../role/role.service.js';
import * as userService from '../user/user.service.js';
import type { ProductRow } from './product.model.js';
import * as repository from './product.repository.js';
import type { ProductScope, ProductWithAgents } from './product.types.js';

const log = createModuleLogger('product');

/**
 * A dedicated permission rather than an existing one: `ticket:manage` looked
 * tempting, but tier-2 specialists hold it and they are precisely the people who
 * should stay product-scoped. Only administrators get this.
 */
const CROSS_PRODUCT_PERMISSION = 'ticket:read_all_products';

/**
 * The products this actor may touch. Everything that reads tickets funnels
 * through here, so a missing grant means an empty result rather than a leak.
 */
export async function scopeFor(actor: Actor): Promise<ProductScope> {
  if (actor.kind === 'system') return { kind: 'all' };

  if (actor.permissions.includes(CROSS_PRODUCT_PERMISSION)) return { kind: 'all' };

  if (actor.kind === 'api_key') {
    // Phase 3 API keys are not product-bound yet; the column arrives with the
    // per-product key work. Until then a key sees the whole catalogue, which is
    // why issuing one requires api_key:manage.
    return { kind: 'all' };
  }

  const productIds = await repository.grantedProductIds(actor.id);
  return { kind: 'limited', productIds };
}

/** Throws unless the actor may act on this product. */
export async function assertAccess(actor: Actor, productId: string): Promise<void> {
  const scope = await scopeFor(actor);
  if (scope.kind === 'all') return;

  if (!scope.productIds.includes(productId)) {
    // 404 rather than 403: whether a product exists is itself information.
    throw AppError.notFound('Product not found');
  }
}

/**
 * Whether a specific user may work a product, independent of any request. Used
 * when assigning work: handing a ticket to someone who cannot open it would
 * strand it.
 *
 * Reads the grant table directly rather than synthesising an actor, so it cannot
 * drift from whatever `scopeFor` grows into.
 */
export async function userHasProductAccess(userId: string, productId: string): Promise<boolean> {
  const user = await userService.findById(userId);
  if (!user) return false;

  const permissions =
    user.roleCode === 'super_admin'
      ? [CROSS_PRODUCT_PERMISSION]
      : await roleService.permissionsForRole(user.roleId);

  if (permissions.includes(CROSS_PRODUCT_PERMISSION)) return true;

  const granted = await repository.grantedProductIds(userId);
  return granted.includes(productId);
}

export function list(activeOnly = false): Promise<ProductRow[]> {
  return repository.list(activeOnly);
}

/** Only the products the caller works, for populating console filters. */
export async function listForActor(actor: Actor): Promise<ProductRow[]> {
  const scope = await scopeFor(actor);
  const all = await repository.list(true);

  return scope.kind === 'all'
    ? all
    : all.filter((product) => scope.productIds.includes(product.id));
}

export async function get(id: string): Promise<ProductWithAgents> {
  const product = await repository.findById(id);
  if (!product) throw AppError.notFound('Product not found');

  return { ...product, agents: await repository.agents(id) };
}

export async function requireById(id: string, exec?: Executor): Promise<ProductRow> {
  const product = await repository.findById(id, exec);
  if (!product) {
    throw AppError.validation('Unknown product', {
      details: [{ field: 'productId', issue: 'no product exists with this id' }],
    });
  }
  return product;
}

export function findByCode(code: string): Promise<ProductRow | undefined> {
  return repository.findByCode(code);
}

export function findBySupportEmail(address: string): Promise<ProductRow | undefined> {
  return repository.findBySupportEmail(address);
}

export async function create(
  input: {
    code: string;
    name: string;
    description?: string | undefined;
    supportEmail?: string | undefined;
  },
  actor: Actor,
): Promise<ProductRow> {
  if (await repository.findByCode(input.code)) {
    throw AppError.conflict('A product with this code already exists');
  }

  return withTransaction(async ({ tx }) => {
    const product = await repository.insert(
      {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        supportEmail: input.supportEmail?.toLowerCase() ?? null,
      },
      tx,
    );

    await auditService.record(
      { action: 'product.created', entityType: 'product', entityId: product.id, after: product },
      actor,
      tx,
    );
    return product;
  });
}

export async function update(
  id: string,
  patch: {
    name?: string | undefined;
    description?: string | undefined;
    supportEmail?: string | null | undefined;
    isActive?: boolean | undefined;
    defaultTeamId?: string | null | undefined;
  },
  actor: Actor,
): Promise<ProductRow> {
  const before = await repository.findById(id);
  if (!before) throw AppError.notFound('Product not found');

  return withTransaction(async ({ tx }) => {
    const row = await repository.update(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.supportEmail !== undefined
          ? { supportEmail: patch.supportEmail?.toLowerCase() ?? null }
          : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.defaultTeamId !== undefined ? { defaultTeamId: patch.defaultTeamId } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Product not found');

    await auditService.record(
      { action: 'product.updated', entityType: 'product', entityId: id, before, after: row },
      actor,
      tx,
    );
    return row;
  });
}

export async function grantAccess(
  productId: string,
  userId: string,
  actor: Actor,
): Promise<ProductWithAgents> {
  const product = await repository.findById(productId);
  if (!product) throw AppError.notFound('Product not found');
  const user = await userService.requireById(userId);

  await withTransaction(async ({ tx }) => {
    await repository.grant(productId, userId, actor.kind === 'user' ? actor.id : null, tx);
    await auditService.record(
      {
        action: 'product.access_granted',
        entityType: 'product',
        entityId: productId,
        after: { userId, email: user.email },
      },
      actor,
      tx,
    );
  });

  log.info('product access granted', { productId, userId });
  return get(productId);
}

export async function revokeAccess(
  productId: string,
  userId: string,
  actor: Actor,
): Promise<ProductWithAgents> {
  const product = await repository.findById(productId);
  if (!product) throw AppError.notFound('Product not found');

  await withTransaction(async ({ tx }) => {
    const removed = await repository.revoke(productId, userId, tx);
    if (!removed) throw AppError.notFound('That user does not have access to this product');

    await auditService.record(
      {
        action: 'product.access_revoked',
        entityType: 'product',
        entityId: productId,
        before: { userId },
      },
      actor,
      tx,
    );
  });

  return get(productId);
}
