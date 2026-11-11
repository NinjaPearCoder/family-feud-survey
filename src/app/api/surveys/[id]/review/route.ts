import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getSurveyReviewStatus } from '@/lib/review';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const result = await getSurveyReviewStatus((await params).id);
    return NextResponse.json(result || { error: 'Not found' }, { status: result ? 200 : 404, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Review status unavailable.' }, { status: 500 });
  }
}
