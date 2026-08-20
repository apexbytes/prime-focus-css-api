/** Who is making a request. Resolved by the auth middleware, never trusted from input. */
export type ActorKind = 'user' | 'api_key' | 'system';

export interface UserActor {
  kind: 'user';
  id: string;
  email: string;
  fullName: string;
  roleId: string;
  roleCode: string;
  permissions: readonly string[];
  /** Session the access token was minted for, so logout can target it. */
  sessionId: string | null;
}

export interface ApiKeyActor {
  kind: 'api_key';
  id: string;
  name: string;
  permissions: readonly string[];
}

export interface SystemActor {
  kind: 'system';
  /** Job or process acting without a human, e.g. `sla.scan`. */
  name: string;
}

export type Actor = UserActor | ApiKeyActor | SystemActor;

export function isUserActor(actor: Actor | undefined): actor is UserActor {
  return actor?.kind === 'user';
}

/** Label persisted alongside audit rows so history survives actor deletion. */
export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case 'user':
      return actor.email;
    case 'api_key':
      return `api-key:${actor.name}`;
    case 'system':
      return `system:${actor.name}`;
  }
}
