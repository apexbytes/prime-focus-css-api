import { z } from 'zod';
import { isSafeReturnPath } from './sso.policy.js';

/** Lower-cased so a provider configured with `Example.COM` matches `example.com`. */
const emailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'expected a domain');

/**
 * `openid` is not optional and is added if omitted: without it the provider is
 * being asked for an OAuth grant rather than an identity, and there would be no
 * id_token to verify.
 */
const scopeList = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(20)
  .transform((values) => (values.includes('openid') ? values : ['openid', ...values]));

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

const returnPath = z
  .string()
  .trim()
  .max(512)
  .refine(isSafeReturnPath, { message: 'must be a path within the console, starting with /' });

export const providerCodeParam = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'expected a lower-case slug');

// -- the sign-in flow --------------------------------------------------------

/**
 * Either identifier works: the console lists providers by id, and a deep link
 * ("sign in with Google") is more readable with a code.
 */
export const startLoginBody = z
  .object({
    providerId: z.uuid().optional(),
    providerCode: providerCodeParam.optional(),
    returnPath: returnPath.optional(),
  })
  .refine((body) => Boolean(body.providerId ?? body.providerCode), {
    message: 'providerId or providerCode is required',
  });

/**
 * The authorization code and the state, read by the console out of its own URL.
 *
 * Neither is a secret this API issued, but both are single-use and short-lived,
 * and they arrive in a body rather than a query string for the same reason
 * invitation tokens do: a URL lands in history, `Referer` headers and proxy logs.
 */
export const completeLoginBody = z.object({
  state: z.string().min(20).max(200),
  code: z.string().min(1).max(4096),
});

// -- provider administration -------------------------------------------------

/** Shared by the provider routes and the identity-unlink route. */
export const idParams = z.object({ id: z.uuid() });

export const createProviderBody = z.object({
  code: providerCodeParam,
  displayName: z.string().trim().min(1).max(80),
  kind: z.enum(['google', 'microsoft', 'oidc']),
  issuer: z.string().trim().min(8).max(512),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(1).max(1024),
  scopes: scopeList.default(DEFAULT_SCOPES),
  /**
   * Required, and required to be non-empty: this is the check that stops a
   * personal account at a consumer provider from signing in as staff.
   */
  allowedEmailDomains: z.array(emailDomain).min(1, 'list at least one email domain').max(50),
  requireVerifiedEmail: z.boolean().default(true),
  requireOtp: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

/**
 * `clientSecret` is write-only: it may be replaced here and is never returned by
 * any endpoint. Omitting it leaves the stored one alone, which is what makes
 * every other field editable without pasting a secret back in.
 */
export const updateProviderBody = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    issuer: z.string().trim().min(8).max(512).optional(),
    clientId: z.string().trim().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(1024).optional(),
    scopes: scopeList.optional(),
    allowedEmailDomains: z.array(emailDomain).min(1).max(50).optional(),
    requireVerifiedEmail: z.boolean().optional(),
    requireOtp: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });

export type StartLoginBody = z.infer<typeof startLoginBody>;
export type CompleteLoginBody = z.infer<typeof completeLoginBody>;
export type CreateProviderBody = z.infer<typeof createProviderBody>;
export type UpdateProviderBody = z.infer<typeof updateProviderBody>;
