import { SignJWT, jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';

export const SESSION_COOKIE = 'admin-session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const ISSUER = 'feud-survey';
const AUDIENCE = 'feud-survey-admin';

export type AuthConfig = { password: string; secret: Uint8Array };

export function getAuthConfig(): AuthConfig | null {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  const isPlaceholder = (value: string) =>
    /^(changeme|changethis|replaceme|replacewith|yourpassword|youradminpassword|yoursecret|yoursessionsecret|devsecret|example|placeholder|password123|longrandomstring)/.test(
      value.toLowerCase().replace(/[^a-z0-9]/g, '')
    );

  if (
    !password || password.trim().length < 12 || isPlaceholder(password) ||
    !secret || !secret.trim() || isPlaceholder(secret) ||
    new TextEncoder().encode(secret.trim()).byteLength < 32
  ) {
    return null;
  }

  return { password, secret: new TextEncoder().encode(secret) };
}

export async function signAdminSession(config: AuthConfig): Promise<string> {
  return new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(config.secret);
}

export async function requireAdmin(request: Request): Promise<NextResponse | null> {
  const config = getAuthConfig();
  if (!config) {
    return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
  }

  try {
    // Read only this request's cookies, including in direct route-handler tests.
    const token = new NextRequest(request.url, { headers: request.headers })
      .cookies.get(SESSION_COOKIE)?.value;
    if (token) {
      const { payload } = await jwtVerify(token, config.secret, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        requiredClaims: ['exp', 'role'],
      });
      if (payload.role === 'admin') return null;
    }
  } catch {
    // Malformed cookies and all token verification failures are unauthorized.
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
