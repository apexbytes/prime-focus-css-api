import { describe, expect, it } from 'vitest';
import { AppError } from '../../common/errors/index.js';
import type { FederatedClaims } from '../../lib/oidc/index.js';
import {
  assertClaimsAcceptable,
  checkIssuer,
  domainAllowed,
  emailDomain,
  isSafeReturnPath,
} from './sso.policy.js';

const claims = (overrides: Partial<FederatedClaims> = {}): FederatedClaims => ({
  subject: 'sub-1',
  email: 'tarisai@primefocus.co.zw',
  emailVerified: true,
  fullName: 'Tarisai M',
  hostedDomain: null,
  ...overrides,
});

const POLICY = { requireVerifiedEmail: true, allowedEmailDomains: ['primefocus.co.zw'] };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('emailDomain', () => {
  it('takes the part after the last @', () => {
    expect(emailDomain('tarisai@primefocus.co.zw')).toBe('primefocus.co.zw');
    // Legal in an address, and the last @ is the delimiter.
    expect(emailDomain('odd"@"name@primefocus.co.zw')).toBe('primefocus.co.zw');
  });

  it('lower-cases, so a provider shouting the domain still matches', () => {
    expect(emailDomain('Tarisai@PrimeFocus.CO.ZW')).toBe('primefocus.co.zw');
  });

  it('has no answer for something that is not an address', () => {
    expect(emailDomain('primefocus.co.zw')).toBeNull();
    expect(emailDomain('@primefocus.co.zw')).toBeNull();
    expect(emailDomain('tarisai@')).toBeNull();
  });
});

describe('domainAllowed', () => {
  it('matches a listed domain exactly', () => {
    expect(domainAllowed('tarisai@primefocus.co.zw', ['primefocus.co.zw'])).toBe(true);
    expect(domainAllowed('tarisai@PRIMEFOCUS.co.zw', ['primefocus.co.zw'])).toBe(true);
    expect(domainAllowed('tarisai@primefocus.co.zw', ['Primefocus.CO.ZW'])).toBe(true);
  });

  it('does not match a subdomain of a listed domain', () => {
    // A provider authoritative for one is not necessarily authoritative for the
    // other, and this is the shape of the trick if it were.
    expect(domainAllowed('attacker@evil.primefocus.co.zw', ['primefocus.co.zw'])).toBe(false);
    expect(domainAllowed('attacker@primefocus.co.zw.evil.com', ['primefocus.co.zw'])).toBe(false);
  });

  it('federates nobody when the list is empty', () => {
    // The other reading — "no restrictions" — would mean every Google account in
    // the world, because they all share one issuer.
    expect(domainAllowed('anyone@gmail.com', [])).toBe(false);
  });
});

describe('assertClaimsAcceptable', () => {
  it('returns the address when everything holds', () => {
    expect(assertClaimsAcceptable(claims(), POLICY)).toBe('tarisai@primefocus.co.zw');
  });

  it('refuses an assertion with no address to match on', () => {
    expect(codeOf(() => assertClaimsAcceptable(claims({ email: null }), POLICY))).toBe(
      'SSO_IDENTITY_REJECTED',
    );
  });

  it('refuses an address the provider says is unverified, whatever the policy', () => {
    const permissive = { requireVerifiedEmail: false, allowedEmailDomains: ['primefocus.co.zw'] };

    expect(codeOf(() => assertClaimsAcceptable(claims({ emailVerified: false }), permissive))).toBe(
      'SSO_IDENTITY_REJECTED',
    );
  });

  it('refuses a missing verification claim only when the provider requires one', () => {
    const absent = claims({ emailVerified: undefined });

    expect(codeOf(() => assertClaimsAcceptable(absent, POLICY))).toBe('SSO_IDENTITY_REJECTED');
    // Entra never sends the claim, which is why a provider can be configured to
    // accept its absence.
    expect(
      assertClaimsAcceptable(absent, {
        requireVerifiedEmail: false,
        allowedEmailDomains: ['primefocus.co.zw'],
      }),
    ).toBe('tarisai@primefocus.co.zw');
  });

  it('refuses a domain the provider is not federated for', () => {
    expect(
      codeOf(() => assertClaimsAcceptable(claims({ email: 'someone@gmail.com' }), POLICY)),
    ).toBe('SSO_IDENTITY_REJECTED');
  });
});

describe('checkIssuer', () => {
  it('normalises a trailing slash away', () => {
    expect(checkIssuer('https://accounts.google.com/', false)).toEqual({
      ok: true,
      issuer: 'https://accounts.google.com',
    });
  });

  it('keeps a path, which tenant-scoped issuers have', () => {
    expect(checkIssuer('https://login.microsoftonline.com/tenant-id/v2.0', false)).toEqual({
      ok: true,
      issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
    });
  });

  it('refuses plain http and internal hosts', () => {
    expect(checkIssuer('http://accounts.google.com', false).ok).toBe(false);
    expect(checkIssuer('https://127.0.0.1:9000', false).ok).toBe(false);
    expect(checkIssuer('https://10.0.0.4', false).ok).toBe(false);
    expect(checkIssuer('https://169.254.169.254', false).ok).toBe(false);
    expect(checkIssuer('not-a-url', false).ok).toBe(false);
  });

  it('allows a loopback issuer only when told to, which is what the suite runs', () => {
    expect(checkIssuer('http://127.0.0.1:9000', true)).toEqual({
      ok: true,
      issuer: 'http://127.0.0.1:9000',
    });
  });

  it('refuses a query string, which would not survive the iss comparison', () => {
    expect(checkIssuer('https://idp.example.com?tenant=1', false).ok).toBe(false);
  });
});

describe('isSafeReturnPath', () => {
  it('accepts a path inside the console', () => {
    expect(isSafeReturnPath('/tickets/PF-2026-000123')).toBe(true);
    expect(isSafeReturnPath('/reports?from=2026-01-01')).toBe(true);
  });

  it('refuses anything that could leave the console', () => {
    // Protocol-relative is the one that looks like a path and is not.
    expect(isSafeReturnPath('//evil.example.com')).toBe(false);
    expect(isSafeReturnPath('https://evil.example.com')).toBe(false);
    expect(isSafeReturnPath('tickets')).toBe(false);
    expect(isSafeReturnPath('/tickets\\..\\admin')).toBe(false);
    expect(isSafeReturnPath('/tickets\nLocation: https://evil.example.com')).toBe(false);
  });
});
