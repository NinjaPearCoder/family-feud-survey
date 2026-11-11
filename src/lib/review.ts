import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  getAIConfig, reviewQuestion, REVIEW_POLICY, safeReviewError, validateQuestionReview, validateReviewInput,
  type AIConfig, type AIQuestionReview, type ReviewAnswer,
} from '@/lib/ai';

export const REVIEW_LEASE_MS = 90_000;
export const MAX_QUESTIONS_PER_RUN = 5;
export type ReviewEvaluator = (question: string, answers: ReviewAnswer[], config: AIConfig) => Promise<AIQuestionReview>;
export interface ReviewRun {
  surveyId: string;
  status: 'completed' | 'disabled' | 'busy' | 'not_found' | 'ineligible' | 'not_due';
  reviewed: number;
  unchanged: number;
  failed: number;
  stale: number;
  remaining: number;
}
export interface ReviewOptions { force?: boolean; dueBefore?: Date }
const eligible = ['OPEN', 'CLOSED'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function reviewInputHash(question: string, answers: readonly ReviewAnswer[], config = getAIConfig()): string {
  return hash(JSON.stringify({
    question, answers: [...answers].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(a => [a.id, a.text]),
    provider: config.provider, model: config.model, endpoint: config.baseURL,
    policy: REVIEW_POLICY, target: config.targetResponses,
  }));
}

export function computeReviewMetrics(review: AIQuestionReview, targetResponses: number) {
  const counts = new Map<string, { answerText: string; count: number }>();
  for (const a of review.assignments) {
    if (a.group === null) continue;
    const label = a.group.trim().replace(/\s+/g, ' ');
    const key = label.toLowerCase();
    const group = counts.get(key) ?? { answerText: label, count: 0 };
    group.count++;
    counts.set(key, group);
  }
  const groups = [...counts.values()].sort((a, b) => b.count - a.count || (a.answerText < b.answerText ? -1 : a.answerText > b.answerText ? 1 : 0));
  const responseCount = review.assignments.length;
  const validCount = groups.reduce((n, g) => n + g.count, 0);
  const flaggedCount = responseCount - validCount;
  const topAnswerShare = validCount ? (groups[0]?.count || 0) / validCount : 0;
  const topEightShare = validCount ? groups.slice(0, 8).reduce((n, g) => n + g.count, 0) / validCount : 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  // All scores are 0..100; shares are 0..1. Quality is the usable-answer percentage,
  // sample is valid/target capped at 1, distribution rewards top-eight coverage but
  // linearly penalizes dominance above 50% (100% dominance gives zero).
  // Recommendations are advisory only: no survey lifecycle transitions occur here.
  const qualityScore = round(responseCount ? 100 * validCount / responseCount : 0);
  const sampleScore = round(100 * Math.min(1, validCount / Math.max(1, targetResponses)));
  const distributionScore = round(100 * topEightShare * Math.min(1, 2 * (1 - topAnswerShare)));
  const recommendation = validCount < targetResponses ? 'NEEDS_MORE_RESPONSES'
    : qualityScore < 80 || review.questionScore < 60 || distributionScore < 50 || groups.length < 2 || review.issues.length > 0
      ? 'NEEDS_ATTENTION' : 'PROMISING';
  return { groups, responseCount, validCount, flaggedCount, questionScore: review.questionScore,
    qualityScore, sampleScore, distributionScore, topAnswerShare, topEightShare, groupCount: groups.length, recommendation };
}

export function schedulerConfigured(): boolean {
  const secret = process.env.REVIEW_SCHEDULER_SECRET;
  return !!secret && secret.trim().length >= 32 && !/^(replace|change|example|your[-_ ]|placeholder)/i.test(secret.trim()) && secret !== process.env.ADMIN_PASSWORD && secret !== process.env.SESSION_SECRET;
}

export function authorizeReviewScheduler(request: Request): boolean {
  if (!schedulerConfigured()) return false;
  const supplied = request.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.REVIEW_SCHEDULER_SECRET}`;
  // Fixed-size digests keep comparison constant-time, including different token lengths.
  return timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest());
}

export async function reviewSurvey(id: string, options: ReviewOptions = {}, evaluator: ReviewEvaluator = reviewQuestion): Promise<ReviewRun> {
  const result: ReviewRun = { surveyId: id, status: 'completed', reviewed: 0, unchanged: 0, failed: 0, stale: 0, remaining: 0 };
  const config = getAIConfig();
  if (!config.enabled) return { ...result, status: 'disabled' };
  const token = randomUUID();
  const now = new Date();
  const acquired = await prisma.survey.updateMany({
    where: { id, status: { in: eligible },
      AND: [
        { OR: [{ reviewLeaseUntil: null }, { reviewLeaseUntil: { lte: now } }] },
        ...(options.dueBefore ? [{ OR: [{ lastReviewAttemptAt: null }, { lastReviewAttemptAt: { lte: options.dueBefore } }] }] : []),
      ],
    },
    data: { reviewLeaseId: token, reviewLeaseUntil: new Date(now.getTime() + REVIEW_LEASE_MS), lastReviewAttemptAt: now, lastReviewError: null },
  });
  if (!acquired.count) {
    const survey = await prisma.survey.findUnique({ where: { id } });
    return { ...result, status: !survey ? 'not_found' : !eligible.includes(survey.status) ? 'ineligible'
      : survey.reviewLeaseUntil && survey.reviewLeaseUntil > now ? 'busy' : 'not_due' };
  }
  const owner = () => ({ id, reviewLeaseId: token, reviewLeaseUntil: { gt: new Date() }, status: { in: eligible } });
  let lastError: string | null = null;
  try {
    const questions = await prisma.question.findMany({
      where: { surveyId: id }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { answers: { select: { id: true, text: true } }, review: true },
    });
    // Rotate by attempts, not successes: repeatedly failing questions must not starve later ones.
    questions.sort((a, b) => (a.reviewAttemptedAt?.getTime() || 0) - (b.reviewAttemptedAt?.getTime() || 0));
    let attempted = 0;
    for (const question of questions) {
      const inputHash = reviewInputHash(question.text, question.answers, config);
      if (!options.force && question.review?.inputHash === inputHash) { result.unchanged++; continue; }
      if (attempted >= MAX_QUESTIONS_PER_RUN) { result.remaining++; continue; }
      attempted++;
      try {
        const renewed = await prisma.survey.updateMany({ where: owner(), data: { reviewLeaseUntil: new Date(Date.now() + REVIEW_LEASE_MS) } });
        if (!renewed.count) { result.stale++; continue; }
        await prisma.question.update({ where: { id: question.id }, data: { reviewAttemptedAt: new Date() } });
        validateReviewInput(question.text, question.answers);
        // Validate injected evaluators too: no route to unchecked model counts.
        const evaluated = question.answers.length
          ? await evaluator(question.text, question.answers.map(a => ({ ...a })), { ...config })
          : { assignments: [], questionScore: 0, summary: 'No responses to review.', issues: [] };
        const review = validateQuestionReview(evaluated, question.answers);
        const { groups, ...metrics } = computeReviewMetrics(review, config.targetResponses);
        const answerById = new Map(question.answers.map(a => [a.id, a.text]));
        const flags = review.assignments.filter(a => a.group === null).map(a => {
          const text = answerById.get(a.answerId)!;
          return { answerId: a.answerId, text: text.slice(0, 2000), textHash: hash(text), reason: a.reason };
        });
        const saved = await prisma.$transaction(async tx => {
          // Take SQLite's write lock BEFORE reading inputs, serializing against submissions,
          // lifecycle updates and competing owners. Never resurrect an expired lease.
          const fenced = await tx.survey.updateMany({ where: owner(), data: { reviewLeaseUntil: new Date(Date.now() + REVIEW_LEASE_MS) } });
          if (!fenced.count) return false;
          const current = await tx.question.findUnique({ where: { id: question.id }, include: { answers: { select: { id: true, text: true } } } });
          const currentConfig = getAIConfig();
          if (!current || current.surveyId !== id || !currentConfig.enabled || reviewInputHash(current.text, current.answers, currentConfig) !== inputHash) return false;
          const data = { inputHash, reviewedAt: new Date(), ...metrics, summary: review.summary,
            issuesJson: JSON.stringify(review.issues), flagsJson: JSON.stringify(flags), provider: config.provider, model: config.model };
          await tx.questionReview.upsert({ where: { questionId: question.id }, create: { questionId: question.id, ...data }, update: data });
          await tx.tabulation.deleteMany({ where: { questionId: question.id } });
          if (groups.length) await tx.tabulation.createMany({ data: groups.map(g => ({ questionId: question.id, ...g, qualityScore: metrics.qualityScore })) });
          return true;
        });
        if (saved) result.reviewed++; else result.stale++;
      } catch (error) {
        result.failed++;
        lastError = safeReviewError(error);
        await prisma.survey.updateMany({ where: owner(), data: { lastReviewError: lastError } });
      }
    }
  } catch (error) {
    result.failed++;
    lastError = safeReviewError(error);
  } finally {
    // Token predicate prevents a late worker from clearing its successor's lease or error.
    await prisma.survey.updateMany({ where: { id, reviewLeaseId: token },
      data: { reviewLeaseId: null, reviewLeaseUntil: null, lastReviewError: lastError } });
  }
  return result;
}

export async function runDueReviews(evaluator: ReviewEvaluator = reviewQuestion) {
  const config = getAIConfig();
  if (!config.enabled) return { status: 'disabled' as const, surveyId: null };
  const now = new Date();
  const dueBefore = new Date(now.getTime() - config.intervalMinutes * 60_000);
  const survey = await prisma.survey.findFirst({
    where: { status: { in: eligible }, AND: [
      { OR: [{ lastReviewAttemptAt: null }, { lastReviewAttemptAt: { lte: dueBefore } }] },
      { OR: [{ reviewLeaseUntil: null }, { reviewLeaseUntil: { lte: now } }] },
    ] },
    orderBy: [{ lastReviewAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { id: true },
  });
  return survey ? reviewSurvey(survey.id, { dueBefore }, evaluator) : { status: 'idle' as const, surveyId: null };
}

export async function getSurveyReviewStatus(id: string) {
  const config = getAIConfig();
  return prisma.$transaction(async tx => {
  const survey = await tx.survey.findUnique({ where: { id }, include: {
    _count: { select: { responses: true } },
    questions: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { review: true, answers: { select: { id: true, text: true } }, tabulations: { orderBy: [{ count: 'desc' }, { answerText: 'asc' }] } } },
  } });
  if (!survey) return null;
  const questions = survey.questions.map(q => {
    const stale = !q.review || q.review.inputHash !== reviewInputHash(q.text, q.answers, config);
    let review = null;
    if (q.review) {
      const { issuesJson, flagsJson, ...fields } = q.review;
      let issues: string[] = [];
      let flags: { answerId: string; text: string; reason: string }[] = [];
      try {
        const decodedIssues: unknown = JSON.parse(issuesJson);
        if (Array.isArray(decodedIssues)) issues = decodedIssues.filter((s): s is string => typeof s === 'string').slice(0, 20).map(s => s.slice(0, 500));
        const decodedFlags: unknown = JSON.parse(flagsJson);
        const answers = new Map(q.answers.map(a => [a.id, a.text]));
        if (Array.isArray(decodedFlags)) flags = decodedFlags.slice(0, 300).filter(f =>
          f && typeof f.answerId === 'string' && typeof f.reason === 'string' && typeof f.textHash === 'string' &&
          answers.has(f.answerId) && hash(answers.get(f.answerId)!) === f.textHash
        ).map(f => ({ answerId: f.answerId, text: answers.get(f.answerId)!.slice(0, 2000), reason: f.reason.slice(0, 500) }));
      } catch { /* Invalid stored diagnostic JSON must not break admin status. */ }
      review = { ...fields, issues, flags };
    }
    // Any snapshot change requires full-question regrouping, so all current answers are pending.
    return { questionId: q.id, pendingCount: stale ? q.answers.length : 0, stale, review };
  });
  return {
    survey: { id: survey.id, title: survey.title, status: survey.status, _count: survey._count,
      questions: survey.questions.map(q => ({ id: q.id, text: q.text, _count: { answers: q.answers.length }, tabulations: q.tabulations })) },
    ai: { enabled: config.enabled, provider: config.provider, model: config.model, targetResponses: config.targetResponses,
      intervalMinutes: config.intervalMinutes, schedulerConfigured: schedulerConfigured() },
    job: { running: !!survey.reviewLeaseId && !!survey.reviewLeaseUntil && survey.reviewLeaseUntil > new Date(),
      lastAttemptAt: survey.lastReviewAttemptAt, lastError: survey.lastReviewError },
    questions, totalPending: questions.reduce((n, q) => n + q.pendingCount, 0),
  };
  });
}
