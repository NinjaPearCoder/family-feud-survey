import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { isSurveyStatus, STATUS_TRANSITIONS, surveyForAdmin } from '@/lib/survey';
import { decodeBackgroundQuestion } from '@/lib/background';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  if (!body || !isSurveyStatus(body.status) || !isSurveyStatus(body.expectedStatus)) {
    return NextResponse.json({ error: 'Provide a valid target and expected survey status.' }, { status: 400 });
  }
  const { status, expectedStatus } = body;
  const { id } = await params;
  try {
    return await prisma.$transaction(async tx => {
      const survey = await tx.survey.findUnique({ where: { id }, include: { questions: true,
        backgroundQuestions: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { answers: true } } } } } });
      if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (survey.status === status) return NextResponse.json({ ...surveyForAdmin(survey), backgroundQuestions: survey.backgroundQuestions.map(decodeBackgroundQuestion) });
      if (survey.status !== expectedStatus || !isSurveyStatus(survey.status)) {
        return NextResponse.json({ error: 'The survey status changed. Refresh before trying again.' }, { status: 409 });
      }
      if (!STATUS_TRANSITIONS[survey.status].includes(status)) {
        return NextResponse.json({ error: 'This status transition is not allowed.' }, { status: 409 });
      }
      if (status === 'OPEN' && (!survey.questions.length || survey.questions.some(q => !q.text.trim()))) {
        return NextResponse.json({ error: 'Add at least one valid question before opening this survey.' }, { status: 409 });
      }
      const now = new Date();
      const updated = await tx.survey.update({ where: { id }, data: {
        status,
        ...(status === 'OPEN' ? { openedAt: survey.status === 'DRAFT' ? now : survey.openedAt, closedAt: null, archivedAt: null } : {}),
        ...(status === 'CLOSED' ? { closedAt: survey.status === 'OPEN' ? now : survey.closedAt, archivedAt: null } : {}),
        ...(status === 'ARCHIVED' ? { archivedAt: now } : {}),
      } });
      return NextResponse.json({ ...surveyForAdmin(updated), backgroundQuestions: survey.backgroundQuestions.map(decodeBackgroundQuestion) });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2028', 'P2034'].includes(error.code)) {
      return NextResponse.json({ error: 'Survey is busy. Refresh and retry.' }, { status: 409 });
    }
    throw error;
  }
}
