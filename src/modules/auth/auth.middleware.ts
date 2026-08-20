import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { setActor } from '../../common/context/request-context.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import type { PermissionCode } from '../../common/types/permissions.js';
import * as authService from './auth.service.js';

const API_KEY_HEADER = 'x-api-key';

/**
 * Resolves the caller into `req.actor`.
 *
 * Two credential types are accepted: a staff access token (`Authorization:
 * Bearer`) and a product system's API key (`X-API-Key`). Everything downstream
 * reads `req.actor` and does not care which was used.
 */
export const authenticate: RequestHandler = (req, res, next) => {
  void resolveActor(req)
    .then((actor) => {
      req.actor = actor;
      setActor({ actorId: actor.kind === 'system' ? undefined : actor.id, actorType: actor.kind });
      next();
    })
    .catch(next);
};

async function resolveActor(req: Request): Promise<Actor> {
  const apiKey = req.get(API_KEY_HEADER);
  if (apiKey) return authService.actorFromApiKey(apiKey);

  const header = req.get('authorization');
  if (!header) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required');
  }

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new AppError(
      401,
      ErrorCode.UNAUTHENTICATED,
      'Expected an "Authorization: Bearer" header',
    );
  }

  return authService.actorFromAccessToken(token);
}

/**
 * Requires every listed permission. Deliberately a hard failure with no
 * information about what was missing — a caller who lacks a permission has no
 * business learning the permission model.
 */
export function requirePermission(...required: PermissionCode[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const actor = req.actor;
    if (!actor) {
      next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
      return;
    }

    // System actors are internal jobs, not HTTP callers; they bypass by design.
    if (actor.kind === 'system') {
      next();
      return;
    }

    const held = new Set(actor.permissions);
    const missing = required.filter((permission) => !held.has(permission));

    if (missing.length > 0) {
      next(
        AppError.forbidden('You do not have permission to perform this action', {
          context: { missing, actorId: actor.id, kind: actor.kind },
        }),
      );
      return;
    }

    next();
  };
}

/** Requires at least one of the listed permissions. */
export function requireAnyPermission(...accepted: PermissionCode[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const actor = req.actor;
    if (!actor) {
      next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
      return;
    }
    if (actor.kind === 'system') {
      next();
      return;
    }

    const held = new Set(actor.permissions);
    if (!accepted.some((permission) => held.has(permission))) {
      next(
        AppError.forbidden('You do not have permission to perform this action', {
          context: { accepted, actorId: actor.id },
        }),
      );
      return;
    }

    next();
  };
}

/** Only staff sessions; rejects API keys on endpoints that assume a human. */
export const requireUserActor: RequestHandler = (req, _res, next) => {
  if (req.actor?.kind !== 'user') {
    next(AppError.forbidden('This endpoint requires a signed-in user'));
    return;
  }
  next();
};

/**
 * Allows the action when the actor is the target, or when it holds the given
 * permission. Lets an agent edit their own profile without granting them the
 * ability to edit everyone else's.
 */
export function requireSelfOrPermission(
  paramName: string,
  permission: PermissionCode,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = req.actor;
    if (actor?.kind === 'user' && req.params[paramName] === actor.id) {
      next();
      return;
    }
    requirePermission(permission)(req, res, next);
  };
}
