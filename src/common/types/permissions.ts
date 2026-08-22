/**
 * The authorisation vocabulary of the whole system.
 *
 * Permission codes are referenced from source (`requirePermission('user:invite')`)
 * *and* stored as rows, so this list is append-only: renaming a code silently
 * strips the permission from every role that holds it.
 *
 * Codes for later phases are seeded now so a role can be granted them before the
 * feature ships — cheaper than a migration per phase.
 */
export const PERMISSION_CATALOGUE = [
  // users
  { code: 'user:read', description: 'View staff accounts', category: 'users' },
  { code: 'user:invite', description: 'Invite new staff members', category: 'users' },
  { code: 'user:manage', description: 'Change staff roles, details and status', category: 'users' },
  { code: 'user:delete', description: 'Delete staff accounts', category: 'users' },
  // roles
  { code: 'role:read', description: 'View roles and permissions', category: 'roles' },
  {
    code: 'role:manage',
    description: 'Create roles and change permission grants',
    category: 'roles',
  },
  // teams
  { code: 'team:read', description: 'View teams and membership', category: 'teams' },
  { code: 'team:manage', description: 'Create teams and change membership', category: 'teams' },
  // machine credentials
  {
    code: 'api_key:read',
    description: 'View API keys issued to product systems',
    category: 'api_keys',
  },
  { code: 'api_key:manage', description: 'Issue and revoke API keys', category: 'api_keys' },
  // audit
  { code: 'audit:read', description: 'Read the audit trail', category: 'audit' },
  // products
  { code: 'product:read', description: 'View the product catalogue', category: 'products' },
  {
    code: 'product:manage',
    description: 'Create products and grant agents access to them',
    category: 'products',
  },
  // customers
  { code: 'customer:read', description: 'View customer records', category: 'customers' },
  {
    code: 'customer:manage',
    description: 'Create, edit and merge customer records',
    category: 'customers',
  },
  // tickets (Phase 3)
  { code: 'ticket:read', description: 'View tickets', category: 'tickets' },
  {
    code: 'ticket:reply',
    description: 'Reply to tickets and post internal notes',
    category: 'tickets',
  },
  {
    code: 'ticket:assign_self',
    description: 'Take ownership of an unassigned ticket',
    category: 'tickets',
  },
  { code: 'ticket:assign', description: 'Assign tickets to anyone', category: 'tickets' },
  {
    code: 'ticket:escalate',
    description: 'Escalate tickets to a higher tier',
    category: 'tickets',
  },
  {
    code: 'ticket:manage',
    description: 'Change ticket status, priority and category',
    category: 'tickets',
  },
  { code: 'ticket:delete', description: 'Delete tickets and attachments', category: 'tickets' },
  {
    code: 'ticket:read_all_products',
    description: 'See tickets across every product, ignoring per-product access grants',
    category: 'tickets',
  },
  // knowledge base (Phase 5)
  { code: 'kb:read', description: 'Read knowledge base articles', category: 'knowledge_base' },
  {
    code: 'kb:manage',
    description: 'Write and publish knowledge base articles',
    category: 'knowledge_base',
  },
  // service levels (Phase 4)
  {
    code: 'sla:manage',
    description: 'Configure SLA policies and escalation rules',
    category: 'sla',
  },
  // reporting (Phase 5)
  { code: 'report:view', description: 'View dashboards and reports', category: 'reporting' },
  {
    code: 'report:refresh',
    description: 'Rebuild the reporting views by hand instead of waiting for the schedule',
    category: 'reporting',
  },
  // outbound webhooks (Phase 6)
  {
    code: 'webhook:read',
    description: 'View outbound webhook subscriptions and their delivery log',
    category: 'webhooks',
  },
  {
    code: 'webhook:manage',
    description: 'Create and delete outbound webhook subscriptions, and redeliver events to them',
    category: 'webhooks',
  },
  // federated sign-in (Phase 7)
  {
    code: 'sso:read',
    description: 'View configured identity providers and who is linked to them',
    category: 'sso',
  },
  {
    code: 'sso:manage',
    description:
      'Configure identity providers: which staff email domains may sign in through them, and with what client credentials',
    category: 'sso',
  },
  // omnichannel channels (Phase 8)
  {
    code: 'channel:read',
    description: 'View live chat and WhatsApp conversations and their inbound backlog',
    category: 'channels',
  },
  {
    code: 'channel:manage',
    description: 'End a live-chat conversation and retry a message that failed to file',
    category: 'channels',
  },
  // retention (Phase 5)
  {
    code: 'retention:run',
    description:
      'Run the data-retention sweep by hand, deleting and anonymising data past its retention period',
    category: 'retention',
  },
] as const;

export type PermissionCode = (typeof PERMISSION_CATALOGUE)[number]['code'];

export const ALL_PERMISSION_CODES: readonly PermissionCode[] = PERMISSION_CATALOGUE.map(
  (permission) => permission.code,
);

/** Marks a role that holds every permission, including ones added later. */
export const WILDCARD = '*' as const;

export interface SystemRoleDefinition {
  code: string;
  name: string;
  description: string;
  permissions: readonly PermissionCode[] | typeof WILDCARD;
}

/**
 * Seeded roles. `super_admin` is intentionally a wildcard so a new permission is
 * never stranded with nobody able to grant it.
 */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    code: 'super_admin',
    name: 'Super Administrator',
    description: 'Unrestricted access, including role and permission management',
    permissions: WILDCARD,
  },
  {
    code: 'admin',
    name: 'Administrator',
    description: 'Runs the support operation: staff, teams, SLAs and reporting',
    permissions: [
      'user:read',
      'user:invite',
      'user:manage',
      'user:delete',
      'role:read',
      'team:read',
      'team:manage',
      'api_key:read',
      'api_key:manage',
      'audit:read',
      'product:read',
      'product:manage',
      'customer:read',
      'customer:manage',
      'ticket:read',
      'ticket:reply',
      'ticket:assign',
      'ticket:assign_self',
      'ticket:escalate',
      'ticket:manage',
      'ticket:read_all_products',
      'kb:read',
      'kb:manage',
      'sla:manage',
      'report:view',
      'report:refresh',
      // Alongside `api_key:manage`, and for the same reason: a subscription is
      // an egress of ticket data to a host of the holder's choosing.
      'webhook:read',
      'webhook:manage',
      // Same class again: a provider is a decision about who may become a
      // signed-in member of staff.
      'sso:read',
      'sso:manage',
      // A conversation is a ticket thread seen from the channel's side, so the
      // read follows `ticket:read`; ending one is a moderation act, which is why
      // it is separate.
      'channel:read',
      'channel:manage',
    ],
  },
  {
    code: 'tier2_specialist',
    name: 'Tier 2 Specialist',
    description: 'Handles escalations and complex product issues',
    permissions: [
      'user:read',
      'team:read',
      'product:read',
      'customer:read',
      'customer:manage',
      'ticket:read',
      'ticket:reply',
      'ticket:assign',
      'ticket:assign_self',
      'ticket:escalate',
      'ticket:manage',
      'kb:read',
      'kb:manage',
      'report:view',
      'channel:read',
      'channel:manage',
    ],
  },
  {
    code: 'tier1_agent',
    name: 'Tier 1 Agent',
    description: 'First line of response to customer queries',
    permissions: [
      'user:read',
      'team:read',
      'product:read',
      'customer:read',
      'ticket:read',
      'ticket:reply',
      'ticket:assign_self',
      'ticket:escalate',
      'kb:read',
      // Read only: a tier-1 agent works the conversations they are given and
      // does not decide that somebody's chat is over.
      'channel:read',
    ],
  },
] as const;

export const SUPER_ADMIN_ROLE_CODE = 'super_admin';

/** Resolves a role's grant list, expanding the wildcard. */
export function resolveRolePermissions(
  definition: SystemRoleDefinition,
): readonly PermissionCode[] {
  return definition.permissions === WILDCARD ? ALL_PERMISSION_CODES : definition.permissions;
}
