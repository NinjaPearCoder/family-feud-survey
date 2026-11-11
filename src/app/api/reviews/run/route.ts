import { NextResponse } from 'next/server';
import { authorizeReviewScheduler, runDueReviews } from '@/lib/review';

export const runtime = 'nodejs';
export const maxDuration = 330;

export async function POST(request: Request) {
  if (!authorizeReviewScheduler(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await runDueReviews(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Scheduled review could not be completed.' }, { status: 500 });
  }
}
