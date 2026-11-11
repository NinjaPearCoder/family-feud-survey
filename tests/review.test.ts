import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getAIConfig, type AIQuestionReview, type ReviewAnswer } from '@/lib/ai';
import { getAuthConfig, signAdminSession } from '@/lib/auth';

// No Prisma CLI or dotenv: migrations are applied only to this suite's new temporary SQLite file.
// Generation is owned by integration, not this suite (important with Windows DLL locks).
const generated = Prisma.dmmf.datamodel.models.some(model => model.name === 'QuestionReview');
let service: typeof import('@/lib/review');
let prisma: PrismaClient;
let directory: string;
let databaseUrl: string;
let environment: NodeJS.ProcessEnv;
let cookie: string;
let survey: { id: string; questions: { id: string; text: string }[] };
const evaluate = async (_question: string, answers: ReviewAnswer[]): Promise<AIQuestionReview> => ({
  assignments: answers.map(a => ({ answerId: a.id, group: a.text === 'junk' ? null : a.text, reason: a.text === 'junk' ? 'Off topic.' : null })),
  questionScore: 90, summary: 'A useful question.', issues: [],
});

it('adds the review schema without changing existing survey data (in-memory SQLite)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of ['20240101000000_init', '20261111000000_survey_lifecycle']) {
      db.exec(await readFile(path.resolve('prisma/migrations', name, 'migration.sql'), 'utf8'));
    }
    db.exec(`
      INSERT INTO Survey (id, title, status, updatedAt, token) VALUES ('s', 'Keep me', 'OPEN', CURRENT_TIMESTAMP, 'token');
      INSERT INTO Question (id, surveyId, text, sortOrder) VALUES ('q', 's', 'Question', 0);
      INSERT INTO Response (id, surveyId, respondentToken) VALUES ('r', 's', 'respondent');
      INSERT INTO Answer (id, responseId, questionId, text) VALUES ('a', 'r', 'q', 'Raw answer');
      INSERT INTO Tabulation (id, questionId, answerText, count) VALUES ('t', 'q', 'Existing group', 1);
    `);
    const before = ['Question', 'Response', 'Answer', 'Tabulation'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
    db.exec(await readFile(path.resolve('prisma/migrations/20261111010000_question_reviews/migration.sql'), 'utf8'));
    assert.deepEqual(['Question', 'Response', 'Answer', 'Tabulation'].map(table => db.prepare(`SELECT ${table === 'Question' ? 'id,surveyId,text,sortOrder' : '*'} FROM ${table}`).all()), before);
    const survey = db.prepare('SELECT title, status, reviewLeaseId, reviewLeaseUntil, lastReviewAttemptAt, lastReviewError FROM Survey').get();
    assert.deepEqual({ ...survey }, { title: 'Keep me', status: 'OPEN', reviewLeaseId: null, reviewLeaseUntil: null, lastReviewAttemptAt: null, lastReviewError: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM QuestionReview').get()?.count, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

describe('review service with temporary SQLite', { concurrency: false }, () => {
  before(async () => {
    assert.ok(generated, 'Run npm run db:generate before testing the review service.');
    environment = { ...process.env };
    directory = await mkdtemp(path.join(tmpdir(), 'feud-review-test-'));
    const filename = path.join(directory, 'review.db');
    databaseUrl = `file:${filename.replaceAll('\\', '/')}`;
    process.env.DATABASE_URL = databaseUrl;
    // node:sqlite is a test-only built-in on Node 22.13+; the worker needs only fetch/timers.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(filename);
    try {
      const migrations = path.resolve('prisma/migrations');
      for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        db.exec(await readFile(path.join(migrations, entry.name, 'migration.sql'), 'utf8'));
      }
    } finally { db.close(); }
    ({ prisma } = await import('@/lib/db'));
    service = await import('@/lib/review');
    process.env.ADMIN_PASSWORD = 'review-test-admin-password';
    process.env.SESSION_SECRET = '82d1cc645134a27767268523d7aa4e61';
    cookie = `admin-session=${await signAdminSession(getAuthConfig()!)}`;
  });
  after(async () => {
    mock.restoreAll();
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (environment) process.env = environment;
  });
  beforeEach(async () => {
    mock.restoreAll();
    assert.equal(process.env.DATABASE_URL, databaseUrl);
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'anthropic';
    process.env.AI_MODEL = 'test-model';
    process.env.AI_BASE_URL = 'https://provider.invalid';
    process.env.ANTHROPIC_API_KEY = 'fake-review-key';
    process.env.REVIEW_TARGET_RESPONSES = '2';
    process.env.REVIEW_INTERVAL_MINUTES = '15';
    process.env.REVIEW_SCHEDULER_SECRET = 'a1bcde23456789abcdef0123456789abcd';
    // Any accidental real provider call fails immediately, even with a fake credential.
    mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected outbound call'); });
    await prisma.survey.deleteMany();
    survey = await prisma.survey.create({ data: { title: 'Review fixture', status: 'OPEN',
      questions: { create: [{ text: 'Name a kitchen appliance', sortOrder: 0 }] } }, include: { questions: true } });
    await answer('Fridge');
  });
  async function answer(text: string, questionId = survey.questions[0].id) {
    return prisma.response.create({ data: { surveyId: survey.id, respondentToken: 'fixture',
      answers: { create: { questionId, text } } }, include: { answers: true } });
  }
  async function saved() {
    return prisma.question.findUniqueOrThrow({ where: { id: survey.questions[0].id }, include: { review: true, tabulations: { orderBy: { answerText: 'asc' } }, answers: true } });
  }

  it('computes deterministic counts, quality/sample/distribution metrics and advisory labels', async () => {
    const review = await evaluate('q', [{ id: 'a', text: 'Fridge' }, { id: 'b', text: 'Stove' }, { id: 'c', text: 'junk' }]);
    const metrics = service.computeReviewMetrics(review, 2);
    assert.deepEqual(metrics.groups, [{ answerText: 'Fridge', count: 1 }, { answerText: 'Stove', count: 1 }]);
    assert.equal(metrics.validCount, 2);
    assert.equal(metrics.flaggedCount, 1);
    assert.equal(metrics.qualityScore, 66.67);
    assert.equal(metrics.sampleScore, 100);
    assert.equal(metrics.topAnswerShare, 0.5);
    assert.equal(metrics.topEightShare, 1);
    assert.equal(metrics.distributionScore, 100);
    assert.equal(metrics.recommendation, 'NEEDS_ATTENTION');
    const clean = await evaluate('q', [{ id: 'a', text: 'Fridge' }, { id: 'b', text: 'Stove' }]);
    assert.equal(service.computeReviewMetrics(clean, 2).recommendation, 'PROMISING');
    assert.equal(service.computeReviewMetrics(clean, 100).recommendation, 'NEEDS_MORE_RESPONSES');
    assert.equal(service.computeReviewMetrics(await evaluate('q', [{ id: 'a', text: 'Fridge' }]), 1).distributionScore, 0);
    assert.equal(service.computeReviewMetrics(await evaluate('q', []), 100).sampleScore, 0);
  });

  it('hashes sorted IDs/text and all policy/config inputs without depending on answer order', () => {
    const answers = [{ id: 'a', text: 'Fridge' }, { id: 'b', text: 'Stove' }];
    const config = getAIConfig();
    const baseline = service.reviewInputHash('q', answers, config);
    assert.equal(service.reviewInputHash('q', answers.toReversed(), config), baseline);
    assert.notEqual(service.reviewInputHash('edited', answers, config), baseline);
    assert.notEqual(service.reviewInputHash('q', [{ id: 'a', text: 'edited' }, answers[1]], config), baseline);
    for (const update of [{ model: 'other' }, { targetResponses: 9 }, { baseURL: 'https://other.invalid' }, { provider: 'openai-compatible' as const }]) {
      assert.notEqual(service.reviewInputHash('q', answers, { ...config, ...update }), baseline);
    }
  });

  it('skips unchanged questions and fully reanalyzes changed questions; force is explicit', async () => {
    const evaluator = mock.fn(evaluate);
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluator)).reviewed, 1);
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluator)).unchanged, 1);
    assert.equal(evaluator.mock.callCount(), 1);
    await answer('Stove');
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluator)).reviewed, 1);
    assert.equal(evaluator.mock.calls[1].arguments[1].length, 2);
    assert.equal((await service.reviewSurvey(survey.id, { force: true }, evaluator)).reviewed, 1);
    assert.equal((await saved()).review?.responseCount, 2);
    assert.equal((await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } })).status, 'OPEN');
  });

  it('does not acquire a lease or call evaluators when disabled, draft or archived', async () => {
    const evaluator = mock.fn(evaluate);
    process.env.AI_ENABLED = 'false';
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluator)).status, 'disabled');
    assert.equal((await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } })).lastReviewAttemptAt, null);
    process.env.AI_ENABLED = 'true';
    for (const status of ['DRAFT', 'ARCHIVED']) {
      await prisma.survey.update({ where: { id: survey.id }, data: { status } });
      assert.equal((await service.reviewSurvey(survey.id, {}, evaluator)).status, 'ineligible');
    }
    assert.equal(evaluator.mock.callCount(), 0);
  });

  it('rejects overlapping leases while the first evaluator is in flight', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = service.reviewSurvey(survey.id, {}, async (q, a) => { started(); await gate; return evaluate(q, a); });
    await entered;
    try {
      assert.equal((await service.reviewSurvey(survey.id, {}, evaluate)).status, 'busy');
      assert.equal((await service.getSurveyReviewStatus(survey.id))?.job.running, true);
    } finally { release(); }
    assert.equal((await first).reviewed, 1);
    assert.equal((await service.getSurveyReviewStatus(survey.id))?.job.running, false);
  });

  it('discards changed in-flight data and preserves the last good review/tabulations', async () => {
    await service.reviewSurvey(survey.id, {}, evaluate);
    const prior = await saved();
    const run = await service.reviewSurvey(survey.id, { force: true }, async (q, a) => { await answer('Stove'); return evaluate(q, a); });
    assert.equal(run.stale, 1);
    assert.deepEqual((await saved()).review, prior.review);
    assert.deepEqual((await saved()).tabulations, prior.tabulations);
    assert.equal((await service.getSurveyReviewStatus(survey.id))?.questions[0].pendingCount, 2);
  });

  it('does not publish if question text or provider policy changes in flight', async () => {
    const run = await service.reviewSurvey(survey.id, {}, async (q, a) => {
      await prisma.question.update({ where: { id: survey.questions[0].id }, data: { text: 'Edited question' } });
      return evaluate(q, a);
    });
    assert.equal(run.stale, 1);
    assert.equal((await saved()).review, null);
    const changedConfig = await service.reviewSurvey(survey.id, {}, async (q, a) => { process.env.AI_MODEL = 'changed-model'; return evaluate(q, a); });
    assert.equal(changedConfig.stale, 1);
  });

  it('does not publish after archive or deletion', async () => {
    const archived = await service.reviewSurvey(survey.id, {}, async (q, a) => {
      await prisma.survey.update({ where: { id: survey.id }, data: { status: 'ARCHIVED' } });
      return evaluate(q, a);
    });
    assert.equal(archived.stale, 1);
    assert.equal((await saved()).review, null);
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
    const deleted = await service.reviewSurvey(survey.id, {}, async (q, a) => {
      await prisma.survey.delete({ where: { id: survey.id } });
      return evaluate(q, a);
    });
    assert.equal(deleted.stale, 1);
    assert.equal(await prisma.questionReview.count(), 0);
  });

  it('fences expired leases and does not release a successor token', async () => {
    const expired = await service.reviewSurvey(survey.id, {}, async (q, a) => {
      await prisma.survey.update({ where: { id: survey.id }, data: { reviewLeaseUntil: new Date(0) } });
      return evaluate(q, a);
    });
    assert.equal(expired.stale, 1);
    const replaced = await service.reviewSurvey(survey.id, {}, async (q, a) => {
      await prisma.survey.update({ where: { id: survey.id }, data: { reviewLeaseId: 'successor', reviewLeaseUntil: new Date(Date.now() + 90_000), lastReviewError: 'Successor diagnostic' } });
      return evaluate(q, a);
    });
    assert.equal(replaced.stale, 1);
    const current = await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } });
    assert.equal(current.reviewLeaseId, 'successor');
    assert.equal(current.lastReviewError, 'Successor diagnostic');
    assert.equal((await saved()).review, null);
  });

  it('preserves old results on evaluator failure or malformed assignments and stores only safe errors', async () => {
    await service.reviewSurvey(survey.id, {}, evaluate);
    const prior = await saved();
    for (const evaluator of [
      async () => { throw new Error('secret provider payload'); },
      async () => ({ assignments: [], questionScore: 90, summary: 'Invalid review', issues: [] }),
    ]) {
      const run = await service.reviewSurvey(survey.id, { force: true }, evaluator);
      assert.equal(run.failed, 1);
      assert.deepEqual((await saved()).review, prior.review);
      assert.deepEqual((await saved()).tabulations, prior.tabulations);
      const status = await service.getSurveyReviewStatus(survey.id);
      assert.equal(status?.job.running, false);
      assert.ok(status?.job.lastError);
      assert.doesNotMatch(JSON.stringify(status), /secret provider payload|fake-review-key|reviewLeaseId/);
    }
  });

  it('bounds each run to five changed questions and schedules at most one due survey', async () => {
    for (let i = 1; i < 7; i++) {
      const q = await prisma.question.create({ data: { surveyId: survey.id, text: `Question ${i}`, sortOrder: i } });
      await answer('Fridge', q.id);
    }
    const second = await prisma.survey.create({ data: { title: 'Second', status: 'CLOSED' } });
    const evaluator = mock.fn(evaluate);
    const first = await service.runDueReviews(evaluator);
    assert.equal(first.surveyId, survey.id);
    assert.equal('reviewed' in first && first.reviewed, 5);
    assert.equal('remaining' in first && first.remaining, 2);
    assert.equal(evaluator.mock.callCount(), 5);
    assert.equal((await prisma.survey.findUniqueOrThrow({ where: { id: second.id } })).lastReviewAttemptAt, null);
    assert.equal((await service.runDueReviews(evaluator)).surveyId, second.id);
    assert.equal((await service.runDueReviews(evaluator)).status, 'idle');
    const remaining = await service.reviewSurvey(survey.id, {}, evaluator);
    assert.equal(remaining.unchanged, 5);
    assert.equal(remaining.reviewed, 2);
    await prisma.survey.update({ where: { id: survey.id }, data: { lastReviewAttemptAt: new Date(0) } });
    assert.equal('unchanged' in (await service.runDueReviews(evaluator)), true);
    assert.equal(evaluator.mock.callCount(), 7);
  });

  it('rolls back review and tabulation replacement together on a database write failure', async () => {
    await service.reviewSurvey(survey.id, {}, evaluate);
    const prior = await saved();
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_review_tabulation BEFORE INSERT ON Tabulation BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END`);
    try {
      const result = await service.reviewSurvey(survey.id, { force: true }, evaluate);
      assert.equal(result.failed, 1);
      assert.deepEqual((await saved()).review, prior.review);
      assert.deepEqual((await saved()).tabulations, prior.tabulations);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_review_tabulation');
    }
  });

  it('prioritizes unreviewed questions even when earlier questions receive new answers', async () => {
    const ids = [survey.questions[0].id];
    for (let i = 1; i < 7; i++) {
      const question = await prisma.question.create({ data: { surveyId: survey.id, text: `Question ${i}`, sortOrder: i } });
      ids.push(question.id);
      await answer('Fridge', question.id);
    }
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluate)).reviewed, 5);
    for (const id of ids.slice(0, 5)) await answer('Stove', id);
    await service.reviewSurvey(survey.id, {}, evaluate);
    for (const id of ids.slice(5)) assert.ok(await prisma.questionReview.findUnique({ where: { questionId: id } }));
  });

  it('rejects over-limit questions before invoking even an injected evaluator', async () => {
    const current = await saved();
    await prisma.answer.update({ where: { id: current.answers[0].id }, data: { text: 'x'.repeat(60_000) } });
    const evaluator = mock.fn(evaluate);
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluator)).failed, 1);
    assert.equal(evaluator.mock.callCount(), 0);
    assert.equal((await saved()).review, null);
  });

  it('moves past repeated failures so later valid questions still get reviewed', async () => {
    await prisma.question.update({ where: { id: survey.questions[0].id }, data: { text: 'x'.repeat(60_001) } });
    for (let i = 1; i < 5; i++) await prisma.question.create({ data: { surveyId: survey.id, text: 'x'.repeat(60_001), sortOrder: i } });
    const last = await prisma.question.create({ data: { surveyId: survey.id, text: 'Valid later question', sortOrder: 5 } });
    await answer('Stove', last.id);
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluate)).failed, 5);
    assert.equal((await service.reviewSurvey(survey.id, {}, evaluate)).reviewed, 1);
    assert.ok(await prisma.questionReview.findUnique({ where: { questionId: last.id } }));
  });

  it('scheduler excludes active leases, draft and archived surveys and allows expired leases', async () => {
    await prisma.survey.update({ where: { id: survey.id }, data: { reviewLeaseId: 'busy', reviewLeaseUntil: new Date(Date.now() + 90_000) } });
    for (const status of ['DRAFT', 'ARCHIVED']) await prisma.survey.create({ data: { title: status, status } });
    assert.equal((await service.runDueReviews(evaluate)).status, 'idle');
    await prisma.survey.update({ where: { id: survey.id }, data: { reviewLeaseUntil: new Date(0) } });
    assert.equal((await service.runDueReviews(evaluate)).surveyId, survey.id);
  });

  it('requires a dedicated scheduler secret; route has POST only and disabled runs never call providers', async () => {
    const route = await import('@/app/api/reviews/run/route');
    assert.equal('GET' in route, false);
    const request = (token?: string) => new Request('http://localhost/api/reviews/run', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    for (const token of [undefined, 'wrong', process.env.ADMIN_PASSWORD]) assert.equal((await route.POST(request(token))).status, 401);
    process.env.REVIEW_SCHEDULER_SECRET = process.env.ADMIN_PASSWORD;
    assert.equal(service.schedulerConfigured(), false);
    process.env.REVIEW_SCHEDULER_SECRET = 'short';
    assert.equal(service.schedulerConfigured(), false);
    process.env.REVIEW_SCHEDULER_SECRET = 'a1bcde23456789abcdef0123456789abcd';
    process.env.AI_ENABLED = 'false';
    const result = await route.POST(request(process.env.REVIEW_SCHEDULER_SECRET));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).status, 'disabled');
  });

  it('protects admin status/manual routes and returns bounded flags without credentials or lease tokens', async () => {
    const flagged = await answer('junk');
    await service.reviewSurvey(survey.id, {}, evaluate);
    const statusRoute = await import('@/app/api/surveys/[id]/review/route');
    const manual = await import('@/app/api/surveys/[id]/tabulate/route');
    const context = { params: Promise.resolve({ id: survey.id }) };
    assert.equal((await statusRoute.GET(new Request('http://localhost/review'), context)).status, 401);
    assert.equal((await manual.POST(new Request('http://localhost/tabulate', { method: 'POST' }), context)).status, 401);
    const request = new Request('http://localhost/review', { headers: { Cookie: cookie } });
    const response = await statusRoute.GET(request, context);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.questions[0].pendingCount, 0);
    assert.deepEqual(status.questions[0].review.flags, [{ answerId: flagged.answers[0].id, text: 'junk', reason: 'Off topic.' }]);
    assert.equal((await saved()).answers.length, 2);
    assert.doesNotMatch(JSON.stringify(status), /fake-review-key|reviewLeaseId|textHash|apiKey|baseURL/);
    await prisma.answer.update({ where: { id: flagged.answers[0].id }, data: { text: 'Fixed answer' } });
    assert.deepEqual((await service.getSurveyReviewStatus(survey.id))?.questions[0].review?.flags, []);
    process.env.AI_ENABLED = 'false';
    assert.equal((await manual.POST(new Request('http://localhost/tabulate', { method: 'POST', headers: { Cookie: cookie } }), context)).status, 503);
  });
});
