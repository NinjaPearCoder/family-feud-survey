import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const survey = await prisma.survey.findUnique({
    where: { id },
    include: {
      questions: {
        orderBy: { sortOrder: 'asc' },
        include: { tabulations: { orderBy: { count: 'desc' }, take: 8 } },
      },
    },
  });

  if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const totalResponses = await prisma.response.count({ where: { surveyId: id } });
  const scale = totalResponses > 0 ? 100 / totalResponses : 1;

  const gameFile = {
    title: survey.title,
    rounds: survey.questions
      .filter(q => q.tabulations.length > 0)
      .map(q => ({
        question: q.text,
        answers: q.tabulations.map(t => ({
          text: t.answerText,
          points: Math.max(1, Math.round(t.count * scale)),
        })),
      })),
  };

  const filename = survey.title.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.json';

  return new NextResponse(JSON.stringify(gameFile, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
