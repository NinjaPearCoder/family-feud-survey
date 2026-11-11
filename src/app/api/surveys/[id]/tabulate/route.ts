import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getSurveyReviewStatus, reviewSurvey } from '@/lib/review';

export const runtime = 'nodejs';
export const maxDuration = 330;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const force = new URL(request.url).searchParams.get('force') === 'true';
  try {
    const run = await reviewSurvey(id, { force });
    const status = run.status === 'disabled' ? 503 : run.status === 'not_found' ? 404
      : ['busy', 'ineligible', 'not_due'].includes(run.status) ? 409 : 200;
    const results = status === 200 ? await prisma.question.findMany({ where: { surveyId: id },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, tabulations: { orderBy: [{ count: 'desc' }, { answerText: 'asc' }] } } }) : undefined;
    return NextResponse.json({ ok: status === 200 && run.failed === 0 && run.stale === 0, run, results,
      ...(status === 200 ? { review: await getSurveyReviewStatus(id) } : { error: `Review ${run.status}.` }) }, { status });
  } catch {
    return NextResponse.json({ error: 'Review could not be completed.' }, { status: 500 });
  }
}
