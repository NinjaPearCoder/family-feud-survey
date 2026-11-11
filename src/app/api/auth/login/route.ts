import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getAuthConfig, signAdminSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth';

export async function POST(request: Request) {
  const config = getAuthConfig();
  if (!config) {
    return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (
    !body || typeof body !== 'object' || Array.isArray(body) ||
    !('password' in body) || typeof body.password !== 'string' ||
    !timingSafeEqual(
      createHash('sha256').update(body.password).digest(),
      createHash('sha256').update(config.password).digest()
    )
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = await signAdminSession(config);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });

  return response;
}
