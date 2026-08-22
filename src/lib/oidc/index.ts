import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../../config/index.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { remember } from '../cache/index.js';
import { createModuleLogger } from '../logger/index.js';

const log = createModuleLogger('oidc');

/**
 * The OpenID Connect half of federated sign-in: discovery, the authorization
 * URL, the code exchange, and verification of the resulting `id_token`.
 *
 * Deliberately a thin adapter with no knowledge of users, providers-as-rows or
 * sessions — the `sso` module owns all of that. What lives here is the protocol,
 * so the day a provider needs a quirk (a non-standard token endpoint, a
 * different client authentication method) there is one file to change.
 *
 * No dependency beyond `jose`, which is already how access tokens are signed.
 * An OIDC client library would bring its own HTTP stack, its own cache and its
 * own opinions about storage for the three requests this makes.
 */

/** Asymmetric only. A provider offering HS256 would be signing with a secret we share. */
const ID_TOKEN_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

export interface DiscoveryDocument {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Advertised PKCE methods, when the provider says. */
  codeChallengeMethods: string[];
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface FederatedClaims {
  /** The provider's immutable identifier for this person. Never their email. */
  subject: string;
  email: string | null;
  /**
   * Tri-state on purpose. `undefined` means the provider said nothing, which is
   * different from `false` — Google always sends the claim, Microsoft Entra
   * never does, and only the caller knows which of those is acceptable for a
   * given provider.
   */
  emailVerified: boolean | undefined;
  fullName: string | null;
  /** Google's hosted-domain claim, when present. Logged, never trusted alone. */
  hostedDomain: string | null;
}

// -- discovery ---------------------------------------------------------------

/**
 * Fetches and caches `/.well-known/openid-configuration`.
 *
 * Cached in the shared cache rather than in process memory: every instance
 * would otherwise hold its own copy of a document that changes a few times a
 * decade. The signing keys behind `jwks_uri` are cached separately, by `kid`,
 * because those *do* rotate and are refetched on sight of an unknown one.
 */
export async function discover(issuer: string): Promise<DiscoveryDocument> {
  const normalised = normaliseIssuer(issuer);

  return remember(`oidc:discovery:${normalised}`, env.SSO_DISCOVERY_CACHE_SECONDS, () =>
    fetchDiscovery(normalised),
  );
}

async function fetchDiscovery(issuer: string): Promise<DiscoveryDocument> {
  const url = `${issuer}/.well-known/openid-configuration`;
  const body = await getJson(url, 'discovery');

  const document: DiscoveryDocument = {
    issuer: readString(body, 'issuer') ?? issuer,
    authorizationEndpoint: required(body, 'authorization_endpoint', url),
    tokenEndpoint: required(body, 'token_endpoint', url),
    jwksUri: required(body, 'jwks_uri', url),
    codeChallengeMethods: readStringArray(body, 'code_challenge_methods_supported'),
  };

  // The issuer is the identity of the provider, and it is what the `iss` claim
  // of every id_token is checked against. A document served from one issuer's
  // well-known path that names another is either a misconfiguration or a
  // redirect somebody controls.
  if (normaliseIssuer(document.issuer) !== issuer) {
    throw unavailable(`the document at ${url} is issued by ${document.issuer}`);
  }

  // Absent means the provider did not say, which several do not; present and
  // without S256 means it genuinely cannot do PKCE, and this client has no
  // fallback that is worth having.
  if (document.codeChallengeMethods.length > 0 && !document.codeChallengeMethods.includes('S256')) {
    throw unavailable(`${document.issuer} does not support PKCE with S256`);
  }

  log.info('discovered identity provider', { issuer: document.issuer });
  return document;
}

/** Trailing slashes are not significant to a URL but are to a string comparison. */
export function normaliseIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

// -- the authorization request -----------------------------------------------

/**
 * PKCE. The verifier stays on this side and is presented with the code; only
 * its hash travels through the browser, so a code intercepted in a redirect
 * cannot be redeemed by whoever caught it.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export interface AuthorizationRequest {
  discovery: DiscoveryDocument;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  nonce: string;
  codeChallenge: string;
}

export function buildAuthorizationUrl(input: AuthorizationRequest): string {
  const url = new URL(input.discovery.authorizationEndpoint);

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Staff share desks and browsers. Without it, a provider silently reuses
  // whichever account happens to be signed in, which is how one agent ends up
  // reading tickets as another.
  url.searchParams.set('prompt', 'select_account');

  return url.toString();
}

// -- the code exchange -------------------------------------------------------

export interface ExchangeInput {
  discovery: DiscoveryDocument;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

/**
 * Redeems the authorization code for an `id_token`.
 *
 * `client_secret_post` rather than HTTP Basic: both are standard, Google and
 * Entra accept both, and one of them does not have to guess how the other
 * escaped a secret containing a colon.
 *
 * The access token that comes back is deliberately discarded. This system reads
 * nothing from the provider's APIs — the identity is the point — and keeping a
 * token that grants access to somebody's mailbox would make this database worth
 * stealing for a reason that has nothing to do with support tickets.
 */
export async function exchangeCode(input: ExchangeInput): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(input.discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(env.SSO_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw unavailable('the token endpoint could not be reached', error);
  }

  const payload = (await readJsonBody(response)) ?? {};

  if (!response.ok) {
    // The provider's own error code (`invalid_grant`, `invalid_client`) is the
    // one piece of this worth showing a caller: it distinguishes "your code was
    // already used" from "this deployment is misconfigured". Its description is
    // not — those routinely quote back parameters.
    const code = readString(payload, 'error') ?? `http_${response.status}`;
    log.warn('token exchange refused', {
      status: response.status,
      error: code,
      endpoint: input.discovery.tokenEndpoint,
    });

    throw new AppError(
      400,
      ErrorCode.SSO_EXCHANGE_FAILED,
      'The identity provider refused to complete this sign-in',
      { details: [{ field: 'code', issue: code }] },
    );
  }

  const idToken = readString(payload, 'id_token');
  if (!idToken) {
    throw unavailable('the token response carried no id_token');
  }

  return idToken;
}

// -- the identity assertion --------------------------------------------------

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(uri);
  if (existing) return existing;

  const set = createRemoteJWKSet(new URL(uri), {
    timeoutDuration: env.SSO_HTTP_TIMEOUT_MS,
    // An unknown `kid` refetches, throttled: a rotating provider is followed
    // without asking a compromised token to trigger a fetch per attempt.
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });

  jwksCache.set(uri, set);
  return set;
}

export interface VerifyInput {
  idToken: string;
  discovery: DiscoveryDocument;
  clientId: string;
  /** The value this client put in the authorization request. */
  nonce: string;
}

/**
 * Verifies signature, issuer, audience, expiry and nonce, and normalises the
 * claims worth having.
 *
 * The nonce check is what makes an `id_token` unusable anywhere but the sign-in
 * that asked for it. `state` protects the redirect; the nonce protects the
 * token, and a provider that omits it is not one to accept a staff login from.
 */
export async function verifyIdToken(input: VerifyInput): Promise<FederatedClaims> {
  let payload: JWTPayload;

  try {
    ({ payload } = await jwtVerify(input.idToken, jwksFor(input.discovery.jwksUri), {
      issuer: input.discovery.issuer,
      audience: input.clientId,
      algorithms: ID_TOKEN_ALGORITHMS,
    }));
  } catch (error) {
    log.warn('id_token rejected', { issuer: input.discovery.issuer, err: error });
    throw new AppError(
      401,
      ErrorCode.SSO_IDENTITY_REJECTED,
      'The identity provider’s response could not be verified',
    );
  }

  if (typeof payload.nonce !== 'string' || payload.nonce !== input.nonce) {
    throw new AppError(
      401,
      ErrorCode.SSO_IDENTITY_REJECTED,
      'The identity provider’s response does not match this sign-in',
    );
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new AppError(
      401,
      ErrorCode.SSO_IDENTITY_REJECTED,
      'The identity provider returned no subject identifier',
    );
  }

  const emailVerified = payload.email_verified;

  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null,
    emailVerified:
      typeof emailVerified === 'boolean'
        ? emailVerified
        : // Some providers send the claim as a string, which is legal JSON and
          // wrong, but refusing the login over it helps nobody.
          typeof emailVerified === 'string'
          ? emailVerified === 'true'
          : undefined,
    fullName: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null,
    hostedDomain: typeof payload.hd === 'string' ? payload.hd : null,
  };
}

/** Exposed for tests, which stand up a provider of their own per suite. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

// -- shared plumbing ---------------------------------------------------------

async function getJson(url: string, what: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(env.SSO_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw unavailable(`${what} at ${url} could not be fetched`, error);
  }

  if (!response.ok) {
    throw unavailable(`${what} at ${url} answered ${response.status}`);
  }

  const body = await readJsonBody(response);
  if (!body) throw unavailable(`${what} at ${url} is not JSON`);
  return body;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function required(body: Record<string, unknown>, key: string, url: string): string {
  const value = readString(body, key);
  if (!value) throw unavailable(`the document at ${url} has no ${key}`);
  return value;
}

/**
 * A provider that cannot be reached is not the caller's fault and not a bug in
 * this system, so it is a 503 with the reason attached rather than a 500 that
 * pages somebody.
 */
function unavailable(reason: string, cause?: unknown): AppError {
  return new AppError(
    503,
    ErrorCode.SSO_PROVIDER_UNAVAILABLE,
    'The identity provider is not answering correctly',
    {
      details: [{ issue: reason }],
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}
