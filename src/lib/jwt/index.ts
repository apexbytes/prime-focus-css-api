import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../../config/index.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session (refresh-token family member) this access token belongs to. */
  sid: string;
  /** Role code at mint time — informational; authorisation re-reads the role. */
  role: string;
}

export type VerifyFailure = 'expired' | 'invalid';

export type VerifyResult =
  { ok: true; claims: AccessTokenClaims } | { ok: false; reason: VerifyFailure };

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256', kid: env.JWT_KID })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_MINUTES}m`)
    .sign(secret);
}

/**
 * Verifies signature, issuer, audience and expiry. Distinguishes "expired" from
 * "invalid" so the client knows to refresh rather than to re-authenticate.
 */
export async function verifyAccessToken(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });

    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      return { ok: false, reason: 'invalid' };
    }

    return {
      ok: true,
      claims: {
        sub: payload.sub,
        sid: payload.sid,
        role: typeof payload.role === 'string' ? payload.role : '',
      },
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}
