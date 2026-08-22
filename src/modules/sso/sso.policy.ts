import { AppError, ErrorCode } from '../../common/errors/index.js';
import { env, isProduction } from '../../config/index.js';
import type { FederatedClaims } from '../../lib/oidc/index.js';

/**
 * Who a provider is allowed to vouch for, and which providers are allowed to
 * vouch at all.
 *
 * Pure and separate from the service for the same reason the retention cutoffs
 * are: everything downstream of these checks is a signed-in member of staff with
 * access to customer financial data, and that deserves tests that need neither a
 * database nor an identity provider.
 */

/** The domain half of an address, lower-cased, or null if it has no shape. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Whether an address is inside a provider's allowlist.
 *
 * An empty list federates **nobody**. The API refuses to configure a provider
 * without at least one domain, so this is the fail-closed answer for a row that
 * got there another way — and it is the right way round: the alternative reading
 * of "no restrictions configured" is "every Google account on earth", because
 * `https://accounts.google.com` is the issuer for all of them.
 *
 * Subdomains do not match: `evil.example.com` is not `example.com`, and a
 * provider authoritative for one is not necessarily authoritative for the other.
 */
export function domainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return false;

  const domain = emailDomain(email);
  if (!domain) return false;

  return allowedDomains.some((allowed) => allowed.trim().toLowerCase() === domain);
}

export interface ClaimPolicy {
  requireVerifiedEmail: boolean;
  allowedEmailDomains: readonly string[];
}

/**
 * Decides whether a verified `id_token` describes somebody this provider may
 * sign in.
 *
 * Three refusals, in the order they matter:
 *
 *  - **No email.** The address is how the assertion is matched to a staff
 *    account. Without one there is nothing to match, and guessing from the
 *    subject would be inventing an identity.
 *  - **Unverified email**, when the provider is configured to require the claim.
 *    An address the provider has not checked is an address anybody can type.
 *  - **A domain outside the allowlist.** This is the check that stops a personal
 *    Google account from being accepted by a Google provider configured for one
 *    company.
 *
 * All three answer with the same error code and a specific reason: the caller
 * has already proven control of the address at the provider, so there is nothing
 * left to protect by being vague, and "your address is not on a domain this
 * desk federates" is the difference between a support call and a shrug.
 */
export function assertClaimsAcceptable(claims: FederatedClaims, policy: ClaimPolicy): string {
  if (!claims.email) {
    throw reject('The identity provider did not return an email address', 'email');
  }

  // Explicitly false is refused whatever the policy says. A provider that
  // volunteers "this address is not verified" is telling us something no
  // configuration should be allowed to override.
  if (claims.emailVerified === false) {
    throw reject(
      'The identity provider reports this email address as unverified',
      'email_verified',
    );
  }

  // Absent is the case the flag is really about: Entra never sends the claim, so
  // a Microsoft provider is configured to accept its absence, and a consumer
  // provider is not.
  if (policy.requireVerifiedEmail && claims.emailVerified !== true) {
    throw reject('The identity provider has not verified this email address', 'email_verified');
  }

  if (!domainAllowed(claims.email, policy.allowedEmailDomains)) {
    throw reject(
      'This email domain is not federated through the selected identity provider',
      'email',
    );
  }

  return claims.email;
}

function reject(message: string, field: string): AppError {
  return new AppError(403, ErrorCode.SSO_IDENTITY_REJECTED, message, {
    details: [{ field, issue: message }],
  });
}

// -- provider configuration --------------------------------------------------

const BLOCKED_HOSTS = new Set(['localhost', '0.0.0.0', '::1', '169.254.169.254']);
const PRIVATE_HOST = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Whether an issuer is one this system will accept identity assertions from.
 *
 * https, and not a host only this process can reach. The reasoning is the
 * webhook URL guard's, pointing the other way: there, the risk is this process
 * being aimed at an internal service; here, it is trusting an identity
 * assertion from something an attacker on the network can impersonate — and
 * this one authenticates staff.
 *
 * Pure, and told whether to be lenient rather than reading the setting itself,
 * so both answers are testable. Leniency exists because the test suite runs its
 * own provider on a loopback port, and `SSO_ALLOW_INSECURE_ISSUER` is refused
 * outright in production.
 */
export type IssuerCheck = { ok: true; issuer: string } | { ok: false; issue: string };

export function checkIssuer(raw: string, allowInsecure: boolean): IssuerCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, issue: 'expected an absolute https URL' };
  }

  if (url.protocol !== 'https:' && !allowInsecure) {
    return { ok: false, issue: `${url.protocol} is not allowed` };
  }

  const host = url.hostname.toLowerCase();
  if (!allowInsecure && (BLOCKED_HOSTS.has(host) || PRIVATE_HOST.test(host))) {
    return { ok: false, issue: `${host} is internal to this network` };
  }

  if (url.search || url.hash) {
    return { ok: false, issue: 'expected scheme, host and path only' };
  }

  // Trailing slashes are not significant to a URL but are to the string
  // comparison against an `iss` claim.
  return { ok: true, issuer: `${url.origin}${url.pathname}`.replace(/\/+$/, '') };
}

/** The env-aware wrapper the service uses. Returns the normalised issuer. */
export function assertFederatableIssuer(raw: string): string {
  const checked = checkIssuer(raw, env.SSO_ALLOW_INSECURE_ISSUER && !isProduction);

  if (!checked.ok) {
    throw AppError.validation('Issuer is not usable as an identity provider', {
      details: [{ field: 'issuer', issue: checked.issue }],
    });
  }

  return checked.issuer;
}

/**
 * Whether a `returnPath` is safe to hand back to the console after a sign-in.
 *
 * Path-only, and not protocol-relative. The value survives a round trip through
 * an identity provider and is used by the console to navigate, so accepting a
 * URL here would make this endpoint an open redirect with a login attached —
 * the classic way a phishing page borrows a real domain.
 */
export function isSafeReturnPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  // A control character or a backslash is a redirect somebody is trying to
  // split, not a route in the console.
  if (value.includes('\\') || /\p{Cc}/u.test(value)) return false;
  return true;
}
