import { boolean, index, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { users } from '../user/user.model.js';

/**
 * What kind of provider this is. The protocol is OpenID Connect in every case —
 * the value exists so the console can render the right button, and so the two
 * providers whose behaviour differs in a way that matters are named rather than
 * discovered at 2am: Google always sends `email_verified`, Microsoft Entra never
 * does.
 */
export const identityProviderKind = pgEnum('identity_provider_kind', [
  'google',
  'microsoft',
  'oidc',
]);

/**
 * An identity provider staff may sign in through.
 *
 * A row here, rather than a block of environment variables, for the same reason
 * routing rules and SLA policies are rows: adding a partner's tenant, or
 * removing a domain that should no longer get in, is an administrator's decision
 * with an audit trail, not a redeploy.
 */
export const identityProviders = pgTable(
  'identity_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable handle the console puts in a URL, e.g. `google`. */
    code: text('code').notNull().unique(),
    displayName: text('display_name').notNull(),
    kind: identityProviderKind('kind').notNull(),
    /** Issuer URL, without a trailing slash. Discovery hangs off it. */
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    /**
     * The client secret, in the clear.
     *
     * The same argument as the webhook signing secret: everything stored as a
     * digest in this system is something we *verify*, and a digest cannot be
     * presented to a token endpoint that expects the original. Unlike the
     * webhook secret this one is supplied rather than generated — the provider
     * issued it — so it is write-only through the API: never returned by any
     * endpoint, never in an audit row, and rotated by a `PATCH` that overwrites
     * it.
     */
    clientSecret: text('client_secret').notNull(),
    /** Requested at the authorization endpoint. `openid` is what makes it OIDC. */
    scopes: text('scopes').array().notNull(),
    /**
     * Email domains this provider may vouch for. At least one is required by
     * the API, and an empty list federates nobody rather than everybody: the
     * Google issuer is shared by every consumer account in the world, so
     * "no domains configured" must not read as "any domain".
     */
    allowedEmailDomains: text('allowed_email_domains').array().notNull().default([]),
    /**
     * Whether an `email_verified: true` claim is required. On by default, and
     * turned off deliberately for Entra, which does not emit the claim at all —
     * a tenant-bound issuer is the verification in that case. Off for a
     * consumer provider means accepting an address nobody proved control of.
     */
    requireVerifiedEmail: boolean('require_verified_email').notNull().default(true),
    /**
     * Whether a successful federated sign-in still has to pass the emailed code.
     * Off by default: the provider is the authentication authority, and mailing
     * a code to the address it just proved is friction without a second factor.
     * On for a provider whose own MFA cannot be relied on.
     */
    requireOtp: boolean('require_otp').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [index('identity_providers_active_idx').on(table.isActive)],
);

/**
 * The link between a staff account and a subject at a provider.
 *
 * Keyed on the provider's `sub`, never on the email address. An address changes
 * hands — an employee leaves and their mailbox is reassigned — and a system that
 * matched on it would hand the leaver's tickets to whoever inherited the
 * mailbox. The email is stored alongside for the console and for the audit
 * trail, and is refreshed when the provider reports a new one.
 */
export const ssoIdentities = pgTable(
  'sso_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The `sub` claim. Opaque, immutable, and unique only within a provider. */
    subject: text('subject').notNull(),
    /** The address the provider asserted, at the last sign-in. */
    email: text('email').notNull(),
    lastLoginAt: instant('last_login_at'),
    ...timestamps,
  },
  (table) => [
    // One subject is one account. The constraint is what makes the link
    // authoritative rather than advisory.
    unique('sso_identities_subject_unique').on(table.providerId, table.subject),
    // And one account has at most one identity per provider, so a second
    // subject claiming an already-linked address is refused rather than
    // silently becoming a second way into the same account.
    unique('sso_identities_user_unique').on(table.providerId, table.userId),
    index('sso_identities_user_idx').on(table.userId),
  ],
);

/**
 * One sign-in in flight.
 *
 * Server-side because this API has no cookies and no session store: the `state`,
 * the nonce and the PKCE verifier have to survive a round trip through the
 * provider and a browser that is not trusted with any of them. The row is
 * consumed on completion — the `consumed_at` update is what makes an
 * authorization code single-use on our side as well as the provider's — and
 * swept once expired.
 */
export const ssoLoginRequests = pgTable(
  'sso_login_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    /**
     * Hash of the `state`, not the value. It comes back to us through a browser
     * redirect, which makes it a bearer credential presented by a client, and
     * those are stored as digests here without exception.
     */
    stateHash: text('state_hash').notNull().unique(),
    /**
     * The nonce and the verifier are stored as-is: neither is presented to us.
     * The nonce is compared against a claim the provider signed, and the
     * verifier is presented *by* this system to the token endpoint.
     */
    nonce: text('nonce').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    /** Sent to the provider and repeated at the exchange; the provider compares. */
    redirectUri: text('redirect_uri').notNull(),
    /** Where in the console to land afterwards. A path, never a URL. */
    returnPath: text('return_path'),
    expiresAt: instant('expires_at').notNull(),
    consumedAt: instant('consumed_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (table) => [
    index('sso_login_requests_provider_idx').on(table.providerId),
    // The sweep of expired rows.
    index('sso_login_requests_expires_at_idx').on(table.expiresAt),
  ],
);

export type IdentityProviderRow = typeof identityProviders.$inferSelect;
export type NewIdentityProvider = typeof identityProviders.$inferInsert;
export type IdentityProviderKind = (typeof identityProviderKind.enumValues)[number];
export type SsoIdentityRow = typeof ssoIdentities.$inferSelect;
export type SsoLoginRequestRow = typeof ssoLoginRequests.$inferSelect;
