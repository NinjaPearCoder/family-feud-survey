import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { decodeBackgroundQuestion } from '@/lib/background';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const page = query.get('page') ?? '1';
  const pageSize = query.get('pageSize') ?? '25';
  if (!/^[1-9]\d*$/.test(page) || !/^[1-9]\d*$/.test(pageSize) ||
      !Number.isSafeInteger(Number(page)) || Number(pageSize) > 100 ||
      !Number.isSafeInteger((Number(page) - 1) * Number(pageSize))) {
    return NextResponse.json({ error: 'Use a positive integer page and pageSize between 1 and 100.' }, { status: 400 });
  }
  const { id } = await params;
  return prisma.$transaction(async tx => {
    const survey = await tx.survey.findUnique({ where: { id }, select: {
      backgroundQuestions: { orderBy: { sortOrder: 'asc' }, include: { answers: { select: { valuesJson: true } } } },
    } });
    if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const totalResponses = await tx.response.count({ where: { surveyId: id } });
    const responses = (Number(page) - 1) * Number(pageSize) >= totalResponses ? [] : await tx.response.findMany({ where: { surveyId: id },
      orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }], skip: (Number(page) - 1) * Number(pageSize), take: Number(pageSize),
      select: { id: true, submittedAt: true, backgroundAnswers: {
        orderBy: { question: { sortOrder: 'asc' } }, select: { questionId: true, valuesJson: true },
      } },
    });
    return NextResponse.json({
      questions: survey.backgroundQuestions.map(q => {
        const question = decodeBackgroundQuestion(q);
        const counts = new Map(question.options.map(value => [value, 0]));
        let answeredCount = 0;
        for (const answer of q.answers) {
          const values = new Set((JSON.parse(answer.valuesJson) as string[]).filter(Boolean));
          if (values.size) answeredCount++;
          for (const value of values) if (counts.has(value)) counts.set(value, counts.get(value)! + 1);
        }
        return { ...question, answeredCount, choices: question.type === 'TEXT' ? [] : [...counts].map(([value, count]) => ({ value, count })) };
      }),
      responses: responses.map(r => ({ id: r.id, submittedAt: r.submittedAt,
        answers: r.backgroundAnswers.map(a => ({ questionId: a.questionId, values: JSON.parse(a.valuesJson) as string[] })) })),
      totalResponses, page: Number(page), pageSize: Number(pageSize), pageCount: Math.max(1, Math.ceil(totalResponses / Number(pageSize))),
    }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
