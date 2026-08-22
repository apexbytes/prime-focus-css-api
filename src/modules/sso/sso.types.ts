import type { LoginResult } from '../auth/auth.types.js';
import type {
  IdentityProviderKind,
  IdentityProviderRow,
  SsoIdentityRow,
  SsoLoginRequestRow,
} from './sso.model.js';

/** An administrator's view of a provider. Never carries the client secret. */
export type IdentityProviderView = Omit<IdentityProviderRow, 'clientSecret'>;

/**
 * What the sign-in screen is allowed to know before anybody has authenticated:
 * enough to draw the buttons, and nothing about which domains get in.
 */
export interface PublicIdentityProvider {
  id: string;
  code: string;
  displayName: string;
  kind: IdentityProviderKind;
}

export interface StartedLogin {
  /** Where to send the browser. Carries state, nonce and the PKCE challenge. */
  authorizationUrl: string;
  provider: PublicIdentityProvider;
  expiresAt: Date;
}

/**
 * The same shape a password login answers with — `authenticated` with tokens, or
 * `otp_required` for a provider whose own second factor is not relied on — plus
 * where in the console the sign-in started.
 */
export interface FederatedLoginResult {
  login: LoginResult;
  returnPath: string | null;
  provider: PublicIdentityProvider;
}

export interface PublicSsoIdentity {
  id: string;
  providerId: string;
  providerCode: string;
  providerName: string;
  /** The address the provider asserted, not necessarily the account's. */
  email: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export type { IdentityProviderKind, IdentityProviderRow, SsoIdentityRow, SsoLoginRequestRow };
