import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { requireAdmin } from '@/lib/auth';
import { isSurveyInput, surveyForAdmin } from '@/lib/survey';
import { decodeBackgroundQuestion, normalizeBackgroundQuestions, sameBackgroundMeaning } from '@/lib/background';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const survey = await prisma.survey.findUnique({
    where: { id },
    include: {
      backgroundQuestions: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { answers: true } } } },
      questions: {
        orderBy: { sortOrder: 'asc' },
        include: {
          _count: { select: { answers: true } },
          tabulations: { orderBy: { count: 'desc' } },
        },
      },
      _count: { select: { responses: true } },
    },
  });

  if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const dates = await prisma.response.aggregate({ where: { surveyId: id }, _min: { submittedAt: true }, _max: { submittedAt: true } });
  return NextResponse.json({ ...surveyForAdmin(survey), backgroundQuestions: survey.backgroundQuestions.map(decodeBackgroundQuestion), collection: { firstResponseAt: dates._min.submittedAt, lastResponseAt: dates._max.submittedAt } });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const body: unknown = await request.json().catch(() => null);
  if (!isSurveyInput(body)) {
    return NextResponse.json({ error: 'Provide a title, valid game/background fields with unique IDs, and a nonnegative integer backgroundVersion.' }, { status: 400 });
  }
  const { id } = await params;

  try {
    // Read, validate, and write in one transaction so failures never leave a partial survey.
    return await prisma.$transaction(async tx => {
      // Serialize edits with submissions before checking answer counts and the expected version.
      await tx.$executeRaw`UPDATE "Survey" SET "status" = "status" WHERE "id" = ${id}`;
      const current = await tx.survey.findUnique({
        where: { id },
        include: { questions: { include: { _count: { select: { answers: true, tabulations: true } } } },
          backgroundQuestions: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { answers: true } } } } },
      });
      if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (current.status === 'ARCHIVED') return NextResponse.json({ error: 'Restore this archived survey before editing it.' }, { status: 409 });

      const questions = body.questions;
      if (questions) {
        if (questions.some(q => q.id && !current.questions.some(old => old.id === q.id))) {
          return NextResponse.json({ error: 'A question does not belong to this survey. Refresh and try again.' }, { status: 400 });
        }
        for (const old of current.questions) {
          const replacement = questions.find(q => q.id === old.id);
          if ((old._count.answers > 0 || old._count.tabulations > 0) && (!replacement || replacement.text.trim() !== old.text.trim())) {
            return NextResponse.json({ error: 'Questions with responses or results cannot be rewritten or deleted. Add a new question instead.' }, { status: 409 });
          }
        }
      }

      const background = body.backgroundQuestions === undefined ? undefined : normalizeBackgroundQuestions(body.backgroundQuestions);
      const oldBackground = current.backgroundQuestions.map(decodeBackgroundQuestion);
      if (background) {
        if (background.some(q => q.id && !oldBackground.some(old => old.id === q.id))) {
          return NextResponse.json({ error: 'A background field does not belong to this survey.' }, { status: 400 });
        }
        if ((body.backgroundVersion ?? 0) !== current.backgroundVersion) {
          return NextResponse.json({ code: 'STALE_QUESTIONS', error: 'Background fields changed. Refresh before saving.' }, { status: 409 });
        }
        for (const old of oldBackground) {
          const replacement = background.find(q => q.id === old.id);
          if (old._count!.answers > 0 && (!replacement || !sameBackgroundMeaning(old, replacement))) {
            return NextResponse.json({ error: 'Background fields with answers cannot be rewritten or removed. Add a new field instead.' }, { status: 409 });
          }
        }
      }
      const backgroundChanged = background !== undefined && (background.length !== oldBackground.length || background.some((q, i) => {
        const old = oldBackground[i];
        return !old || q.id !== old.id || q.required !== old.required || !sameBackgroundMeaning(q, old);
      }));

      await tx.survey.update({
        where: { id },
        data: { title: body.title.trim(), description: body.description, source: body.source, audience: body.audience === undefined ? undefined : body.audience?.trim() || null,
          ...(backgroundChanged ? { backgroundVersion: { increment: 1 } } : {}) },
      });
      if (questions) {
        const removed = current.questions.filter(old => !questions.some(q => q.id === old.id));
        await tx.question.deleteMany({ where: { surveyId: id, id: { in: removed.map(q => q.id) } } });
        for (const [sortOrder, question] of questions.entries()) {
          if (question.id) {
            const old = current.questions.find(q => q.id === question.id)!;
            if (question.text.trim() === old.text.trim()) {
              await tx.question.update({ where: { id: question.id }, data: { sortOrder } });
            } else {
              // New wording gets a new identity, so open forms cannot answer the revised question by its old ID.
              await tx.question.delete({ where: { id: question.id } });
              await tx.question.create({ data: { surveyId: id, text: question.text.trim(), sortOrder } });
            }
          } else {
            await tx.question.create({ data: { surveyId: id, text: question.text.trim(), sortOrder } });
          }
        }
      }
      if (background && backgroundChanged) {
        const retained = background.filter(q => q.id && sameBackgroundMeaning(q, oldBackground.find(old => old.id === q.id)!));
        await tx.backgroundQuestion.deleteMany({ where: { surveyId: id, id: { notIn: retained.map(q => q.id!) } } });
        for (const [sortOrder, q] of background.entries()) {
          if (retained.some(old => old.id === q.id)) {
            await tx.backgroundQuestion.update({ where: { id: q.id! }, data: { required: q.required, sortOrder } });
          } else {
            await tx.backgroundQuestion.create({ data: { surveyId: id, label: q.label, type: q.type,
              required: q.required, optionsJson: JSON.stringify(q.options), sortOrder } });
          }
        }
      }
      const saved = await tx.survey.findUnique({
        where: { id },
        include: {
          backgroundQuestions: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { answers: true } } } },
          questions: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { answers: true } }, tabulations: { orderBy: { count: 'desc' } } } },
          _count: { select: { responses: true } },
        },
      });
      const dates = await tx.response.aggregate({ where: { surveyId: id }, _min: { submittedAt: true }, _max: { submittedAt: true } });
      return NextResponse.json({ ...surveyForAdmin(saved!), backgroundQuestions: saved!.backgroundQuestions.map(decodeBackgroundQuestion), collection: { firstResponseAt: dates._min.submittedAt, lastResponseAt: dates._max.submittedAt } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P1008', 'P2034', 'P2028'].includes(error.code)) {
      return NextResponse.json({ error: 'The survey is busy. Refresh and retry your changes.' }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  await prisma.survey.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
