import assert from 'node:assert/strict';
import { before, after, beforeEach, describe, it, mock } from 'node:test';
import { Messages } from '@anthropic-ai/sdk/resources/messages';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { getAuthConfig, signAdminSession } from '@/lib/auth';

let prisma: PrismaClient;
let detail: typeof import('@/app/api/surveys/[id]/route');
let catalog: typeof import('@/app/api/surveys/route');
let lifecycle: typeof import('@/app/api/surveys/[id]/status/route');
let tabulate: typeof import('@/app/api/surveys/[id]/tabulate/route');
let exporting: typeof import('@/app/api/surveys/[id]/export/route');
let submit: typeof import('@/app/api/submit/[token]/route');
let directory: string;
let databaseUrl: string;
let cookie: string;
let survey: { id: string; token: string; questions: { id: string; text: string }[] };

function context(id = survey.id) { return { params: Promise.resolve({ id }) }; }
function request(method = 'GET', body?: unknown, authorized = true) {
  return new Request('http://localhost/api/surveys/test', {
    method,
    headers: { 'Content-Type': 'application/json', ...(authorized ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  // A unique throwaway database is essential: these tests intentionally delete fixture data.
  directory = await mkdtemp(path.join(tmpdir(), 'feud-survey-test-'));
  databaseUrl = `file:${path.join(directory, 'test.db').replaceAll('\\', '/')}`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.ADMIN_PASSWORD = 'test-only-admin-password';
  process.env.SESSION_SECRET = '71460ce79ab945be90da2c8ec114dceb';
  process.env.AI_ENABLED = 'false';
  process.env.ANTHROPIC_API_KEY = '';
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    env: process.env, stdio: 'pipe',
  });
  ({ prisma } = await import('@/lib/db'));
  detail = await import('@/app/api/surveys/[id]/route');
  catalog = await import('@/app/api/surveys/route');
  lifecycle = await import('@/app/api/surveys/[id]/status/route');
  tabulate = await import('@/app/api/surveys/[id]/tabulate/route');
  exporting = await import('@/app/api/surveys/[id]/export/route');
  submit = await import('@/app/api/submit/[token]/route');
  const config = getAuthConfig();
  assert.ok(config);
  cookie = `admin-session=${await signAdminSession(config)}`;
});

after(async () => {
  await prisma?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('survey safety', { concurrency: false }, () => {
  beforeEach(async () => {
    assert.equal(process.env.DATABASE_URL, databaseUrl);
    await prisma.survey.deleteMany();
    survey = await prisma.survey.create({
      data: {
        title: 'Original title', description: 'Original description', source: 'Test fixtures',
        status: 'OPEN', openedAt: new Date('2026-11-01T12:00:00Z'),
        questions: { create: [
          { text: 'An answered question', sortOrder: 0 },
          { text: 'An unanswered question', sortOrder: 1 },
          { text: 'Another unanswered question', sortOrder: 2 },
        ] },
      },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
    const response = await submit.POST(request('POST', {
      respondentToken: 'test-browser',
      submissionId: 'fixture-submission-0001',
      answers: [{ questionId: survey.questions[0].id, text: 'A real stored answer' }],
    }, false), { params: Promise.resolve({ token: survey.token }) });
    assert.equal(response.status, 200);
    await prisma.tabulation.create({ data: { questionId: survey.questions[0].id, answerText: 'Stored result', count: 1 } });
  });

  async function snapshot() {
    return prisma.survey.findUniqueOrThrow({ where: { id: survey.id }, include: {
      responses: { include: { answers: true } },
      questions: { orderBy: { sortOrder: 'asc' }, include: { answers: true, tabulations: true } },
    } });
  }

  it('preserves question IDs, answers, responses, and tabulations on a metadata save and no-op save', async () => {
    const before = await snapshot();
    for (const body of [
      { title: 'Updated title', description: 'Updated description' },
      { title: 'Updated title', questions: survey.questions.map(({ id, text }) => ({ id, text })) },
    ]) {
      assert.equal((await detail.PUT(request('PUT', body), context())).status, 200);
      const saved = await snapshot();
      assert.equal(saved.title, 'Updated title');
      assert.equal(saved.source, 'Test fixtures');
      assert.deepEqual(saved.responses, before.responses);
      assert.deepEqual(saved.questions, before.questions);
    }
  });

  it('allows adding, reordering, editing and removing only unanswered questions', async () => {
    const before = await snapshot();
    const questions = [
      { id: survey.questions[2].id, text: 'Rewritten unanswered question' },
      { id: survey.questions[0].id, text: survey.questions[0].text },
      { text: 'New question' },
    ];
    assert.equal((await detail.PUT(request('PUT', { title: 'Updated', questions }), context())).status, 200);
    const saved = await snapshot();
    assert.deepEqual(saved.questions.map(q => q.text), questions.map(q => q.text));
    assert.notEqual(saved.questions[0].id, survey.questions[2].id);
    assert.equal(await prisma.question.findUnique({ where: { id: survey.questions[2].id } }), null);
    assert.equal(saved.questions[1].id, survey.questions[0].id);
    assert.equal(await prisma.question.findUnique({ where: { id: survey.questions[1].id } }), null);
    assert.deepEqual(saved.responses, before.responses);
    assert.deepEqual(saved.questions[1].tabulations, before.questions[0].tabulations);
  });

  it('rejects rewriting or deleting answered questions without modifying anything', async () => {
    const before = await snapshot();
    for (const questions of [
      survey.questions.map((q, i) => ({ id: q.id, text: i === 0 ? 'Changed meaning' : q.text })),
      survey.questions.slice(1).map(({ id, text }) => ({ id, text })),
      survey.questions.map(({ text }) => ({ text })),
    ]) {
      assert.equal((await detail.PUT(request('PUT', { title: 'Must not persist', questions }), context())).status, 409);
      assert.deepEqual(await snapshot(), before);
    }
  });

  it('also protects saved results when no raw answers remain', async () => {
    await prisma.answer.deleteMany();
    const before = await snapshot();
    const response = await detail.PUT(request('PUT', { title: 'Changed', questions: survey.questions.slice(1) }), context());
    assert.equal(response.status, 409);
    assert.deepEqual(await snapshot(), before);
  });

  it('rejects malformed JSON, invalid metadata, empty questions, duplicate and foreign question IDs', async () => {
    const other = await prisma.survey.create({ data: { title: 'Other', questions: { create: { text: 'Other question', sortOrder: 0 } } }, include: { questions: true } });
    const before = await snapshot();
    for (const body of [
      null, [], {}, { title: ' ' }, { title: 12 },
      { title: 'Valid', source: {} }, { title: 'Valid', description: 123 },
      { title: 'Valid', questions: [] }, { title: 'Valid', questions: null },
      { title: 'Valid', questions: [{ text: ' ' }] },
      { title: 'Valid', questions: [{ text: 3 }] },
      { title: 'Valid', questions: [{ text: 'valid', id: null }] },
      { title: 'Valid', questions: [survey.questions[0], survey.questions[0]] },
      { title: 'Valid', questions: [...survey.questions, { id: other.questions[0].id, text: 'Other question' }] },
    ]) {
      assert.equal((await detail.PUT(request('PUT', body), context())).status, 400);
      assert.deepEqual(await snapshot(), before);
    }
    const malformed = new Request('http://localhost/api/surveys/test', { method: 'PUT', headers: { Cookie: cookie }, body: '{' });
    assert.equal((await detail.PUT(malformed, context())).status, 400);
    assert.deepEqual(await snapshot(), before);
  });

  it('rolls back metadata, deletions and question updates if a later insert fails', async () => {
    const before = await snapshot();
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_test_insert BEFORE INSERT ON "Question"
      WHEN NEW."text" = 'FORCE_ROLLBACK' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
    try {
      await assert.rejects(detail.PUT(request('PUT', {
        title: 'Must roll back',
        questions: [{ id: survey.questions[0].id, text: survey.questions[0].text }, { text: 'FORCE_ROLLBACK' }],
      }), context()));
      assert.deepEqual(await snapshot(), before);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_test_insert');
    }
  });

  it('returns 404 for an absent survey', async () => {
    assert.equal((await detail.PUT(request('PUT', { title: 'Missing' }), context('not-found'))).status, 404);
  });

  it('preserves verbatim legacy text and allows existing long content to be saved', async () => {
    await prisma.question.update({ where: { id: survey.questions[0].id }, data: { text: `  ${'Q'.repeat(1100)}  ` } });
    const before = await snapshot();
    const response = await detail.PUT(request('PUT', {
      title: 'T'.repeat(250), source: 'S'.repeat(4100),
      questions: before.questions.map(({ id, text }) => ({ id, text })),
    }), context());
    assert.equal(response.status, 200);
    assert.deepEqual((await snapshot()).questions, before.questions);
    assert.deepEqual((await snapshot()).responses, before.responses);
  });

  it('rejects a stale form after unanswered question wording changes, without partially accepting answers', async () => {
    const response = await detail.PUT(request('PUT', {
      title: 'Updated', questions: survey.questions.map((q, i) => ({ id: q.id, text: i === 1 ? 'New meaning' : q.text })),
    }), context());
    assert.equal(response.status, 200);
    const before = await snapshot();
    const stale = await submit.POST(request('POST', {
      respondentToken: 'stale-browser', submissionId: 'stale-submission-0001', answers: [
        { questionId: survey.questions[0].id, text: 'Valid answer' },
        { questionId: survey.questions[1].id, text: 'Answer to the old meaning' },
      ],
    }, false), { params: Promise.resolve({ token: survey.token }) });
    assert.equal(stale.status, 409);
    assert.deepEqual(await snapshot(), before);
  });

  it('enforces authentication in every admin handler even when proxy is bypassed', async () => {
    const handlers = [
      () => catalog.GET(request()),
      () => catalog.POST(request('POST', {})),
      () => detail.GET(request(), context()),
      () => detail.PUT(request('PUT', {}), context()),
      () => detail.DELETE(request('DELETE'), context()),
      () => lifecycle.POST(request('POST'), context()),
      () => tabulate.POST(request('POST'), context()),
      () => exporting.GET(request(), context()),
    ];
    const original = cookie;
    const before = await snapshot();
    for (const invalid of ['', 'admin-session=invalid']) {
      cookie = invalid;
      try {
        for (const handler of handlers) assert.equal((await handler()).status, 401);
        assert.deepEqual(await snapshot(), before);
      } finally { cookie = original; }
    }
    const secret = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      for (const handler of handlers) assert.equal((await handler()).status, 503);
      assert.deepEqual(await snapshot(), before);
    } finally { process.env.SESSION_SECRET = secret; }
  });

  it('keeps public submission, admin read/export, locking and disabled AI functional', async () => {
    assert.equal((await catalog.GET(request())).status, 200);
    const info = await (await detail.GET(request(), context())).json();
    assert.equal(info._count.responses, 1);
    assert.equal(info.questions[0]._count.answers, 1);
    const exported = await (await exporting.GET(request(), context())).json();
    assert.equal(exported.rounds[0].answers[0].text, 'Stored result');
    assert.equal((await tabulate.POST(request('POST'), context())).status, 503);
    const publicContext = { params: Promise.resolve({ token: survey.token }) };
    assert.equal((await submit.GET(request('GET', undefined, false), publicContext)).status, 200);
    assert.equal((await lifecycle.POST(request('POST', { status: 'CLOSED', expectedStatus: 'OPEN' }), context())).status, 200);
    assert.equal((await submit.GET(request('GET', undefined, false), publicContext)).status, 403);
    assert.equal((await submit.POST(request('POST', { submissionId: 'closed-submission-0001', respondentToken: 'closed', answers: [{ questionId: survey.questions[0].id, text: 'Blocked' }] }, false), publicContext)).status, 403);
    assert.equal((await prisma.response.count()), 1);
  });

  it('creates validated drafts with audience and opens them explicitly', async () => {
    const created = await catalog.POST(request('POST', {
      title: '  New survey  ', audience: '  LLNL employees  ', description: 'Notes', source: 'Event',
      questions: [{ text: '  New question  ' }],
    }));
    assert.equal(created.status, 200);
    const draft = await created.json();
    assert.equal(draft.title, 'New survey');
    assert.equal(draft.audience, 'LLNL employees');
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.openedAt, null);
    assert.equal(draft.closedAt, null);
    const publicContext = { params: Promise.resolve({ token: draft.token }) };
    const unavailable = await submit.GET(request(), publicContext);
    assert.equal(unavailable.status, 403);
    assert.equal((await unavailable.json()).status, 'DRAFT');
    const opening = await lifecycle.POST(request('POST', { status: 'OPEN', expectedStatus: 'DRAFT' }), context(draft.id));
    assert.equal(opening.status, 200);
    assert.ok((await opening.json()).openedAt);
    assert.equal((await submit.GET(request(), publicContext)).status, 200);
    for (const invalid of [null, {}, { title: ' ' }, { title: 'Only a title' }, { title: 'Valid', questions: [] },
      { title: 'Valid', audience: 123, questions: [{ text: 'Question' }] },
      { title: 'Valid', status: 'OPEN', questions: [{ text: 'Question' }] },
      { title: 'Valid', questions: [{ text: ' ' }] },
      { title: 'Valid', questions: [{ id: 'foreign', text: 'Question' }] },
    ]) assert.equal((await catalog.POST(request('POST', invalid))).status, 400);
  });

  it('tracks close/reopen/archive/restore dates without deleting data and rejects stale transitions', async () => {
    const original = await snapshot();
    const change = (status: string, expectedStatus: string) => lifecycle.POST(request('POST', { status, expectedStatus }), context());
    assert.equal((await change('ARCHIVED', 'OPEN')).status, 409);
    assert.equal((await change('CLOSED', 'DRAFT')).status, 409);
    const closed = await (await change('CLOSED', 'OPEN')).json();
    assert.equal(closed.status, 'CLOSED');
    assert.ok(closed.closedAt);
    const repeated = await (await change('CLOSED', 'OPEN')).json();
    assert.equal(repeated.closedAt, closed.closedAt);
    assert.equal(repeated.updatedAt, closed.updatedAt);
    const reopened = await (await change('OPEN', 'CLOSED')).json();
    assert.equal(reopened.openedAt, original.openedAt?.toISOString());
    assert.equal(reopened.closedAt, null);
    await change('CLOSED', 'OPEN');
    const archived = await (await change('ARCHIVED', 'CLOSED')).json();
    assert.ok(archived.archivedAt);
    const archivedData = await snapshot();
    assert.deepEqual(archivedData.responses, original.responses);
    assert.deepEqual(archivedData.questions, original.questions);
    assert.equal((await detail.PUT(request('PUT', { title: 'Cannot edit archive' }), context())).status, 409);
    const denied = await submit.GET(request(), { params: Promise.resolve({ token: survey.token }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).status, 'ARCHIVED');
    assert.equal((await change('OPEN', 'ARCHIVED')).status, 409);
    const restored = await (await change('CLOSED', 'ARCHIVED')).json();
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.closedAt, archived.closedAt);
    assert.equal((await detail.PUT(request('PUT', { title: 'Editable again', audience: 'HS students' }), context())).status, 200);
  });

  it('filters admin surveys and exposes actual response dates without leaking audience publicly', async () => {
    await detail.PUT(request('PUT', { title: 'Original', audience: 'LLNL employees' }), context());
    await catalog.POST(request('POST', { title: 'School', audience: 'HS students', questions: [{ text: 'Question' }] }));
    const filtered = await catalog.GET(new Request('http://localhost/api/surveys?status=OPEN&audience=LLNL', { headers: { Cookie: cookie } }));
    assert.deepEqual((await filtered.json()).map((s: { id: string }) => s.id), [survey.id]);
    assert.equal((await catalog.GET(new Request('http://localhost/api/surveys?status=INVALID', { headers: { Cookie: cookie } }))).status, 400);
    const info = await (await detail.GET(request(), context())).json();
    const stored = await snapshot();
    assert.equal(info.collection.firstResponseAt, stored.responses[0].submittedAt.toISOString());
    assert.equal(info.collection.lastResponseAt, info.collection.firstResponseAt);
    const publicData = await (await submit.GET(request(), { params: Promise.resolve({ token: survey.token }) })).json();
    assert.equal(publicData.audience, undefined);
    assert.equal(publicData.collection, undefined);
  });

  it('does not invent an original opening date when reopening a legacy survey', async () => {
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'CLOSED', openedAt: null, closedAt: new Date() } });
    const result = await lifecycle.POST(request('POST', { status: 'OPEN', expectedStatus: 'CLOSED' }), context());
    assert.equal(result.status, 200);
    assert.equal((await result.json()).openedAt, null);
  });

  it('rejects duplicate answers and malformed submission identities without inserting anything', async () => {
    const before = await snapshot();
    const answer = { questionId: survey.questions[0].id, text: 'Answer' };
    for (const body of [
      { respondentToken: 'x', answers: [answer] },
      { submissionId: 'tiny', respondentToken: 'x', answers: [answer] },
      { submissionId: 'duplicate-answer-test', respondentToken: 'x', answers: [answer, answer] },
      { submissionId: 'empty-answer-test', respondentToken: 'x', answers: [{ ...answer, text: ' ' }] },
      { submissionId: 'empty-token-test', respondentToken: '', answers: [answer] },
    ]) {
      assert.equal((await submit.POST(request('POST', body, false), { params: Promise.resolve({ token: survey.token }) })).status, 400);
      assert.deepEqual(await snapshot(), before);
    }
  });

  it('acknowledges identical retries once, including after closing, and rejects key reuse with different content', async () => {
    const publicContext = { params: Promise.resolve({ token: survey.token }) };
    const body = { submissionId: 'idempotency-test-0001', respondentToken: 'repeat-browser', answers: [
      { questionId: survey.questions[0].id, text: ' Answer one ' },
      { questionId: survey.questions[1].id, text: 'Answer two' },
    ] };
    assert.equal((await submit.POST(request('POST', body, false), publicContext)).status, 200);
    const before = await snapshot();
    const reordered = { ...body, answers: [...body.answers].reverse().map(a => ({ ...a, text: a.text.trim() })) };
    assert.equal((await (await submit.POST(request('POST', reordered, false), publicContext)).json()).duplicate, true);
    assert.deepEqual(await snapshot(), before);
    const conflict = await submit.POST(request('POST', { ...body, answers: [{ ...body.answers[0], text: 'Changed' }] }, false), publicContext);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');
    await lifecycle.POST(request('POST', { status: 'CLOSED', expectedStatus: 'OPEN' }), context());
    assert.equal((await submit.POST(request('POST', body, false), publicContext)).status, 200);
    assert.equal((await submit.POST(request('POST', { ...body, submissionId: 'new-after-close-0001' }, false), publicContext)).status, 403);
    assert.equal(await prisma.response.count(), 2);
  });

  it('serializes simultaneous retries into one response', async () => {
    const body = { submissionId: 'concurrent-retry-0001', respondentToken: 'repeat-browser', answers: [{ questionId: survey.questions[1].id, text: 'Answer' }] };
    const post = () => submit.POST(request('POST', body, false), { params: Promise.resolve({ token: survey.token }) });
    const results = await Promise.all([post(), post(), post()]);
    for (const result of results) {
      assert.ok([200, 503].includes(result.status));
      if (result.status === 503) assert.equal((await post()).status, 200);
    }
    assert.equal(await prisma.response.count({ where: { submissionId: body.submissionId } }), 1);
    assert.equal(await prisma.answer.count({ where: { questionId: survey.questions[1].id } }), 1);
  });

  it('does not accept new data after a concurrent close has completed', async () => {
    const body = { submissionId: 'concurrent-close-0001', respondentToken: 'browser', answers: [{ questionId: survey.questions[1].id, text: 'Answer' }] };
    const publicContext = { params: Promise.resolve({ token: survey.token }) };
    const close = () => lifecycle.POST(request('POST', { status: 'CLOSED', expectedStatus: 'OPEN' }), context());
    const [posted, closed] = await Promise.all([submit.POST(request('POST', body, false), publicContext), close()]);
    assert.ok([200, 403, 503].includes(posted.status));
    assert.ok([200, 409].includes(closed.status));
    if (closed.status !== 200) assert.equal((await close()).status, 200);
    const before = await snapshot();
    assert.equal((await submit.POST(request('POST', { ...body, submissionId: 'confirmed-closed-0001' }, false), publicContext)).status, 403);
    assert.deepEqual(await snapshot(), before);
  });

  it('does not publish in-flight AI results after archival', async () => {
    let notifyStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const intercepted = mock.method(Messages.prototype, 'create', (async (params: { messages: { content: string }[] }) => {
      notifyStarted();
      await released;
      const input = JSON.parse(params.messages[0].content);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
        assignments: input.answers.map((a: { answerId: string }) => ({ answerId: a.answerId, group: 'Replacement', reason: null })),
        questionScore: 90, summary: 'Mocked review', issues: [],
      }) }] };
    }) as unknown as typeof Messages.prototype.create);
    process.env.AI_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'test-key-no-network';
    try {
      const pending = tabulate.POST(request('POST'), context());
      await started;
      await lifecycle.POST(request('POST', { status: 'CLOSED', expectedStatus: 'OPEN' }), context());
      await lifecycle.POST(request('POST', { status: 'ARCHIVED', expectedStatus: 'CLOSED' }), context());
      const before = await snapshot();
      release();
      const result = await pending;
      assert.equal(result.status, 200);
      assert.equal((await result.json()).ok, false);
      const after = await snapshot();
      assert.deepEqual(after.questions, before.questions);
      assert.deepEqual(after.responses, before.responses);
      assert.equal(after.status, 'ARCHIVED');
    } finally {
      release();
      intercepted.mock.restore();
      process.env.AI_ENABLED = 'false';
      process.env.ANTHROPIC_API_KEY = '';
    }
  });
});
