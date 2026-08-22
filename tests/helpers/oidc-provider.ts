import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/**
 * A real OpenID Connect provider on a loopback port.
 *
 * Not a stub of `lib/oidc`: it serves a discovery document, publishes a JWKS,
 * and signs `id_token`s with a key it generated, so the suite exercises the
 * discovery fetch, the remote key set, the signature check, the audience and
 * issuer checks, the nonce, and PKCE — the parts of federated sign-in that are
 * either right or a way in. A mocked adapter would assert that our own code was
 * called and prove nothing about any of them.
 *
 * The token endpoint is strict on purpose: it checks the client credentials and
 * recomputes the PKCE challenge from the verifier, so a regression that stopped
 * sending either would fail here rather than in production.
 */
export interface FakeIdentity {
  subject: string;
  email: string;
  /** Omitted from the token entirely when undefined, which is what Entra does. */
  emailVerified?: boolean | undefined;
  name?: string | undefined;
}

export interface AuthorizeOptions {
  /** Overrides the nonce, to prove a mismatched token is refused. */
  nonce?: string;
  /** Overrides the audience, to prove a token minted for another client is refused. */
  audience?: string;
}

export interface FakeProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /**
   * Plays the part of the browser at the provider: reads the authorization
   * request, remembers what it promised, and hands back an authorization code.
   */
  authorize(authorizationUrl: string, identity: FakeIdentity, options?: AuthorizeOptions): string;
  /** How many times the token endpoint has been called. */
  tokenRequests(): number;
  close(): Promise<void>;
}

interface PendingCode {
  nonce: string;
  audience: string;
  codeChallenge: string;
  identity: FakeIdentity;
}

export async function startFakeProvider(
  options: { clientId?: string; clientSecret?: string } = {},
): Promise<FakeProvider> {
  const clientId = options.clientId ?? 'prime-focus-console';
  const clientSecret = options.clientSecret ?? 'idp-issued-client-secret';

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = 'fake-idp-key-1';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  const codes = new Map<string, PendingCode>();
  let tokenCalls = 0;
  let issuer = '';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jwks') {
      json(200, { keys: [jwk] });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      tokenCalls += 1;
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(raw);

          if (
            form.get('client_id') !== clientId ||
            form.get('client_secret') !== clientSecret ||
            form.get('grant_type') !== 'authorization_code'
          ) {
            json(401, { error: 'invalid_client' });
            return;
          }

          const pending = codes.get(form.get('code') ?? '');
          if (!pending) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          // Single-use, like the real thing.
          codes.delete(form.get('code') ?? '');

          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (challenge !== pending.codeChallenge) {
            json(400, { error: 'invalid_grant' });
            return;
          }

          const idToken = await new SignJWT({
            nonce: pending.nonce,
            email: pending.identity.email,
            ...(pending.identity.emailVerified === undefined
              ? {}
              : { email_verified: pending.identity.emailVerified }),
            ...(pending.identity.name ? { name: pending.identity.name } : {}),
          })
            .setProtectedHeader({ alg: 'RS256', kid })
            .setIssuer(issuer)
            .setAudience(pending.audience)
            .setSubject(pending.identity.subject)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);

          json(200, {
            access_token: randomBytes(16).toString('hex'),
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          });
        })();
      });
      return;
    }

    json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,

    authorize(authorizationUrl, identity, authorizeOptions = {}) {
      const params = new URL(authorizationUrl).searchParams;
      const code = randomBytes(12).toString('hex');

      codes.set(code, {
        nonce: authorizeOptions.nonce ?? (params.get('nonce') as string),
        audience: authorizeOptions.audience ?? (params.get('client_id') as string),
        codeChallenge: params.get('code_challenge') as string,
        identity,
      });

      return code;
    },

    tokenRequests: () => tokenCalls,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
