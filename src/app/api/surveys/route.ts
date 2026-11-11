import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { isSurveyInput, isSurveyStatus, surveyForAdmin } from '@/lib/survey';
import { decodeBackgroundQuestion, normalizeBackgroundQuestions } from '@/lib/background';

export async function GET(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const query = new URL(request.url).searchParams;
  const status = query.get('status');
  if (status && !isSurveyStatus(status)) return NextResponse.json({ error: 'Invalid survey status' }, { status: 400 });
  const audience = query.get('audience')?.trim();
  const surveys = await prisma.survey.findMany({
    where: { ...(status ? { status } : {}), ...(audience ? { audience: { contains: audience } } : {}) },
    include: { _count: { select: { responses: true, questions: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json(surveys.map(surveyForAdmin));
}

export async function POST(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const body: unknown = await request.json().catch(() => null);
  if (!isSurveyInput(body) || !body.questions || body.questions.some(q => q.id !== undefined) || body.backgroundQuestions?.some(q => q.id !== undefined)) {
    return NextResponse.json({ error: 'Provide a title, valid metadata, and at least one nonempty question.' }, { status: 400 });
  }
  const { title, description, source, audience, questions } = body;

  const survey = await prisma.survey.create({
    data: {
      title: title.trim(),
      description,
      source,
      audience: audience?.trim() || null,
      status: 'DRAFT',
      backgroundQuestions: {
        create: normalizeBackgroundQuestions(body.backgroundQuestions ?? []).map((q, sortOrder) => ({
          label: q.label, type: q.type, required: q.required, optionsJson: JSON.stringify(q.options), sortOrder,
        })),
      },
      questions: {
        create: questions.map((q, i) => ({
          text: q.text.trim(),
          sortOrder: i,
        })),
      },
    },
    include: { questions: { orderBy: { sortOrder: 'asc' } }, backgroundQuestions: {
      orderBy: { sortOrder: 'asc' }, include: { _count: { select: { answers: true } } },
    } },
  });

  return NextResponse.json({ ...surveyForAdmin(survey), backgroundQuestions: survey.backgroundQuestions.map(decodeBackgroundQuestion) });
}
