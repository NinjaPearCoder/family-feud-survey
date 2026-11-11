import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

export async function POST() {
  // Intentionally unauthenticated: expired/invalid sessions must remain clearable.
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}
