import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Actor, ApiKeyActor } from '../../common/types/actor.js';
import type { PermissionCode } from '../../common/types/permissions.js';
import { generateApiKey, hashSecret, secureEquals } from '../../common/utils/crypto.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import type { ApiKeyRow } from './api-key.model.js';
import * as repository from './api-key.repository.js';
import type { CreatedApiKey, PublicApiKey } from './api-key.types.js';

const log = createModuleLogger('api-key');

export function toPublic(row: ApiKeyRow): PublicApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export async function list(): Promise<PublicApiKey[]> {
  const rows = await repository.list();
  return rows.map(toPublic);
}

/**
 * Issues a key for a Prime Focus product system. The plaintext is returned once
 * and only its hash is stored, so a lost key is replaced rather than recovered.
 */
export async function issue(
  input: { name: string; scopes: PermissionCode[]; expiresAt?: Date | undefined },
  actor: Actor,
): Promise<CreatedApiKey> {
  const generated = generateApiKey();

  const row = await repository.insert({
    name: input.name,
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
    scopes: input.scopes,
    expiresAt: input.expiresAt ?? null,
    createdByUserId: actor.kind === 'user' ? actor.id : null,
  });

  await auditService.recordSafely(
    {
      action: 'api_key.issued',
      entityType: 'api_key',
      entityId: row.id,
      after: { name: row.name, keyPrefix: row.keyPrefix, scopes: row.scopes },
    },
    actor,
  );

  log.info('api key issued', { id: row.id, prefix: row.keyPrefix, scopes: row.scopes.length });
  return { ...toPublic(row), key: generated.plaintext };
}

export async function revoke(id: string, actor: Actor): Promise<void> {
  const existing = await repository.findById(id);
  if (!existing) throw AppError.notFound('API key not found');

  const revoked = await repository.revoke(id);
  if (!revoked) throw AppError.conflict('This API key is already revoked');

  await auditService.recordSafely(
    {
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: id,
      before: { name: existing.name, revokedAt: existing.revokedAt },
    },
    actor,
  );
}

/**
 * Verifies a presented key. Every failure returns the same error, so a caller
 * cannot distinguish "no such key" from "wrong secret" or "revoked".
 */
export async function authenticate(prefix: string, secret: string): Promise<ApiKeyActor> {
  const invalid = () => new AppError(401, ErrorCode.API_KEY_INVALID, 'API key is not valid');

  const row = await repository.findByPrefix(prefix);
  if (!row) throw invalid();
  if (!secureEquals(hashSecret(secret), row.keyHash)) throw invalid();
  if (row.revokedAt) throw invalid();
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw invalid();

  // Fire-and-forget: a busy key should not pay a write on every request path.
  void repository.touch(row.id).catch((error: unknown) => {
    log.warn('failed to update api key last-used', { id: row.id, err: error });
  });

  return { kind: 'api_key', id: row.id, name: row.name, permissions: row.scopes };
}
