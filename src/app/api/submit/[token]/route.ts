import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { BackgroundValidationError, canonicalBackgroundAnswers, decodeBackgroundQuestion, getBackgroundErrors, normalizeBackgroundAnswers } from '@/lib/background';

function unavailable(status: string) {
  const message = status === 'DRAFT' ? 'This survey is not open yet.'
    : status === 'ARCHIVED' ? 'This survey has been archived and is no longer available.'
    : 'This survey is closed and is no longer accepting responses.';
  return NextResponse.json({ error: message, status }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const survey = await prisma.survey.findUnique({
    where: { token },
    include: { questions: { orderBy: { sortOrder: 'asc' } }, backgroundQuestions: { orderBy: { sortOrder: 'asc' } } },
  });

  if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (survey.status !== 'OPEN') return unavailable(survey.status);

  return NextResponse.json({
    id: survey.id,
    title: survey.title,
    description: survey.description,
    questions: survey.questions.map(q => ({ id: q.id, text: q.text })),
    backgroundQuestions: survey.backgroundQuestions.map(decodeBackgroundQuestion),
    backgroundVersion: survey.backgroundVersion,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.submissionId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.submissionId) ||
      typeof body.respondentToken !== 'string' || !body.respondentToken.trim() || body.respondentToken.length > 200 ||
      !Array.isArray(body.answers) || !body.answers.length || body.answers.some((answer: unknown) =>
        !answer || typeof answer !== 'object' || !('questionId' in answer) || typeof answer.questionId !== 'string' ||
        !('text' in answer) || typeof answer.text !== 'string')) {
    return NextResponse.json({ error: 'Provide a submission ID and valid survey answers.' }, { status: 400 });
  }
  const { submissionId, respondentToken, answers }: {
    submissionId: string; respondentToken: string; answers: { questionId: string; text: string }[];
  } = body;
  if (new Set(answers.map(a => a.questionId)).size !== answers.length || answers.some(a => !a.text.trim())) {
    return NextResponse.json({ error: 'Provide one nonempty answer per question.' }, { status: 400 });
  }
  const normalized = answers.map(a => ({ questionId: a.questionId, text: a.text.trim() }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
  const backgroundVersion = body.backgroundVersion === undefined ? 0 : body.backgroundVersion;
  if (!Number.isSafeInteger(backgroundVersion) || backgroundVersion < 0) {
    return NextResponse.json({ error: 'Provide a nonnegative integer backgroundVersion.' }, { status: 400 });
  }
  let backgroundAnswers;
  try {
    backgroundAnswers = normalizeBackgroundAnswers(body.backgroundAnswers);
  } catch (error) {
    if (!(error instanceof BackgroundValidationError)) throw error;
    return NextResponse.json({ code: 'BACKGROUND_VALIDATION', error: error.message, fieldErrors: error.fieldErrors }, { status: 400 });
  }
  const canonicalBackground = canonicalBackgroundAnswers(backgroundAnswers);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        // Acquire SQLite's writer lock before reading state, serializing submissions with close/archive and edits.
        await tx.$executeRaw`UPDATE "Survey" SET "status" = "status" WHERE "token" = ${token}`;
        const survey = await tx.survey.findUnique({ where: { token }, include: { questions: true, backgroundQuestions: true } });
        if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        const existing = await tx.response.findUnique({
          where: { surveyId_submissionId: { surveyId: survey.id, submissionId } },
          include: { answers: { select: { questionId: true, text: true } }, backgroundAnswers: { select: { questionId: true, valuesJson: true } } },
        });
        // A retry may confirm an accepted submission after collection closes; it cannot add data.
        if (existing) {
          const saved = existing.answers.sort((a, b) => a.questionId.localeCompare(b.questionId));
          const savedBackground = canonicalBackgroundAnswers(existing.backgroundAnswers.map(a => ({ questionId: a.questionId, values: JSON.parse(a.valuesJson) as string[] })));
          if (existing.respondentToken !== respondentToken || JSON.stringify(saved) !== JSON.stringify(normalized) ||
              JSON.stringify(savedBackground) !== JSON.stringify(canonicalBackground)) {
            return NextResponse.json({ code: 'IDEMPOTENCY_CONFLICT', error: 'This submission ID was already accepted with different answers. Do not submit a replacement.' }, { status: 409 });
          }
          return NextResponse.json({ ok: true, duplicate: true });
        }
        if (backgroundVersion !== survey.backgroundVersion) {
          return NextResponse.json({ code: 'STALE_QUESTIONS', error: 'Background fields have changed. Reload and review your answers before submitting.' }, { status: 409 });
        }
        if (survey.status !== 'OPEN') return unavailable(survey.status);
        const validIds = new Set(survey.questions.map(q => q.id));
        if (normalized.some(a => !validIds.has(a.questionId))) {
          return NextResponse.json({ code: 'STALE_QUESTIONS', error: 'Survey questions have changed. Reload and review your answers before submitting.' }, { status: 409 });
        }
        const fieldErrors = getBackgroundErrors(survey.backgroundQuestions.map(decodeBackgroundQuestion),
          Object.fromEntries(backgroundAnswers.map(a => [a.questionId, a.values])));
        if (Object.keys(fieldErrors).length) {
          return NextResponse.json({ code: 'BACKGROUND_VALIDATION', error: 'Review your background answers.', fieldErrors }, { status: 400 });
        }
        await tx.response.create({ data: {
          surveyId: survey.id, submissionId, respondentToken,
          answers: { create: normalized },
          backgroundAnswers: { create: canonicalBackground.map(a => ({ questionId: a.questionId, valuesJson: JSON.stringify(a.values) })) },
        } });
        return NextResponse.json({ ok: true });
      }, { maxWait: 5000, timeout: 10000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P1008', 'P2002', 'P2028', 'P2034'].includes(error.code)) {
        if (attempt < 2) continue;
        return NextResponse.json({ code: 'RETRY', error: 'Survey is busy. Retry the same submission in a moment.' }, { status: 503, headers: { 'Retry-After': '1' } });
      }
      throw error;
    }
  }

  throw new Error('Submission retry loop exhausted');
}
