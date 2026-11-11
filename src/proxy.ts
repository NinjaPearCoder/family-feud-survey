import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const denied = await requireAdmin(request);

  if (denied) {
    if (pathname.startsWith('/admin')) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    return denied;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/surveys/:path*'],
};
