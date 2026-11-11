import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getAuthConfig, signAdminSession } from '@/lib/auth';
import { isSurveyInput } from '@/lib/survey';
import {
  BACKGROUND_TYPES, BackgroundValidationError, canonicalBackgroundAnswers, getBackgroundErrors,
  normalizeBackgroundAnswers, normalizeBackgroundQuestions, type BackgroundQuestion, type BackgroundQuestionInput,
} from '@/lib/background';

const definitions: BackgroundQuestionInput[] = BACKGROUND_TYPES.map(type => ({
  label: ` ${type} label `, type, required: false, options: type === 'TEXT' ? [] : [' Alpha ', ' Beta '],
}));

describe('pure background validation', () => {
  it('normalizes config and enforces labels, types, explicit booleans, choices, limits and IDs', () => {
    const fields = normalizeBackgroundQuestions(definitions);
    assert.equal(fields[0].label, 'RADIO label');
    assert.deepEqual(fields[0].options, ['Alpha', 'Beta']);
    assert.deepEqual(normalizeBackgroundQuestions([]), []);
    for (const invalid of [null, {}, Array(21).fill(definitions[0]),
      [{ ...definitions[0], label: '' }], [{ ...definitions[0], label: 'x'.repeat(301) }],
      [{ ...definitions[0], type: 'INVALID' }], [{ ...definitions[0], required: undefined }],
      [{ ...definitions[0], required: 'false' }], [{ ...definitions[0], options: [] }],
      [{ ...definitions[0], options: ['a', ' a '] }], [{ ...definitions[0], options: [' '] }],
      [{ ...definitions[0], options: ['x'.repeat(101)] }], [{ ...definitions[0], options: Array.from({ length: 51 }, (_, i) => `${i}`) }],
      [{ ...definitions[3], options: ['not a text choice'] }], [{ ...definitions[0], id: ' ' }],
      [{ ...definitions[0], id: 'id' }, { ...definitions[1], id: ' id ' }],
    ]) {
      assert.throws(() => normalizeBackgroundQuestions(invalid), BackgroundValidationError);
      assert.equal(isSurveyInput({ title: 'Valid', backgroundQuestions: invalid }), false);
    }
    assert.equal(isSurveyInput({ title: 'Valid', backgroundQuestions: definitions }), true);
    for (const backgroundVersion of [-1, 0.1, '0', null]) assert.equal(isSurveyInput({ title: 'Valid', backgroundVersion }), false);
  });

  it('handles required and skippable fields for all types, including cardinality and foreign blank IDs', () => {
    const questions = normalizeBackgroundQuestions(definitions).map((q, i) => ({ ...q, id: `q${i}` }));
    assert.deepEqual(getBackgroundErrors(questions, {}), {});
    assert.deepEqual(getBackgroundErrors(questions, Object.fromEntries(questions.map(q => [q.id, [' ']]))), {});
    const required = questions.map(q => ({ ...q, required: true }));
    assert.deepEqual(Object.keys(getBackgroundErrors(required, {})), required.map(q => q.id));
    assert.deepEqual(getBackgroundErrors(required, { q0: ['Alpha'], q1: ['Alpha', 'Beta'], q2: ['Beta'], q3: [' Notes '] }), {});
    for (const q of questions) {
      const bad = q.type === 'TEXT' ? ['x'.repeat(2001)] : ['Foreign'];
      assert.ok(getBackgroundErrors(questions, { [q.id]: bad })[q.id]);
      if (q.type !== 'CHECKBOX') assert.ok(getBackgroundErrors(questions, { [q.id]: ['Alpha', 'Beta'] })[q.id]);
    }
    assert.ok(getBackgroundErrors(questions, { q1: ['Alpha', 'Alpha'] }).q1);
    assert.ok(getBackgroundErrors(questions, { foreign: [] }).foreign);
    assert.ok(Object.hasOwn(getBackgroundErrors(questions, JSON.parse('{"__proto__":[]}')), '__proto__'));
  });

  it('normalizes retry payloads independently of definitions without dropping blank field IDs before validation', () => {
    assert.deepEqual(normalizeBackgroundAnswers(), []);
    assert.deepEqual(normalizeBackgroundAnswers([{ questionId: 'q', values: [' '] }]), [{ questionId: 'q', values: [''] }]);
    for (const value of [null, {}, [{ questionId: 'q', values: 'x' }], [{ questionId: 'q', values: [1] }],
      [{ questionId: '', values: [] }], [{ questionId: 'q', values: [] }, { questionId: 'q', values: [] }],
      [{ questionId: 'q', values: ['a', ' a '] }], [{ questionId: 'q', values: ['x'.repeat(2001)] }],
    ]) assert.throws(() => normalizeBackgroundAnswers(value), BackgroundValidationError);
    assert.deepEqual(canonicalBackgroundAnswers([{ questionId: 'z', values: [] }, { questionId: 'b', values: ['B', ' A '] }, { questionId: 'a', values: ['Text'] }]),
      [{ questionId: 'a', values: ['Text'] }, { questionId: 'b', values: ['A', 'B'] }]);
  });
});

it('background migration preserves every old table and enforces the new enum, uniqueness and cascades', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of ['20240101000000_init', '20261111000000_survey_lifecycle', '20261111010000_question_reviews']) {
      db.exec(await readFile(path.resolve('prisma/migrations', name, 'migration.sql'), 'utf8'));
    }
    db.exec(`
      INSERT INTO Survey (id,title,status,updatedAt,token) VALUES ('s','Legacy','OPEN',CURRENT_TIMESTAMP,'token');
      INSERT INTO Question (id,surveyId,text,sortOrder) VALUES ('q','s','Game',0);
      INSERT INTO Response (id,surveyId,respondentToken,submissionId) VALUES ('r','s','browser','legacy-submission');
      INSERT INTO Answer (id,responseId,questionId,text) VALUES ('a','r','q','Original answer');
      INSERT INTO Tabulation (id,questionId,answerText,count) VALUES ('t','q','Original group',1);
      INSERT INTO QuestionReview (questionId,inputHash,responseCount,validCount,flaggedCount,questionScore,qualityScore,sampleScore,
        distributionScore,topAnswerShare,topEightShare,groupCount,recommendation,summary,issuesJson,flagsJson,provider,model)
        VALUES ('q','hash',1,1,0,90,100,1,100,1,1,1,'NEEDS_MORE_RESPONSES','Keep review','[]','[]','test','test');
    `);
    const tables = ['Survey', 'Question', 'Response', 'Answer', 'Tabulation', 'QuestionReview'];
    const previous = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all().map(r => ({ ...r })));
    db.exec(await readFile(path.resolve('prisma/migrations/20261111020000_background_questions/migration.sql'), 'utf8'));
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all().map(r => ({ ...r }))),
      previous.map((rows, i) => i === 0 ? rows.map(row => ({ ...row, backgroundVersion: 0 })) : rows));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM BackgroundQuestion').get()?.n, 0);
    db.exec(`INSERT INTO BackgroundQuestion (id,surveyId,label,type,sortOrder) VALUES ('b','s','Field','TEXT',0)`);
    assert.deepEqual({ ...db.prepare('SELECT required,optionsJson FROM BackgroundQuestion').get() }, { required: 0, optionsJson: '[]' });
    assert.throws(() => db.exec(`UPDATE BackgroundQuestion SET type='INVALID'`), /CHECK constraint/);
    db.exec(`INSERT INTO BackgroundAnswer (id,responseId,questionId,valuesJson) VALUES ('ba','r','b','["Private"]')`);
    assert.throws(() => db.exec(`INSERT INTO BackgroundAnswer (id,responseId,questionId,valuesJson) VALUES ('bb','r','b','[]')`), /UNIQUE constraint/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec(`DELETE FROM Response WHERE id='r'`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM BackgroundAnswer').get()?.n, 0);
    db.exec(`DELETE FROM Survey WHERE id='s'`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM BackgroundQuestion').get()?.n, 0);
  } finally { db.close(); }
});

describe('background backend with temporary SQLite', { concurrency: false }, () => {
  let prisma: PrismaClient;
  let detail: typeof import('@/app/api/surveys/[id]/route');
  let catalog: typeof import('@/app/api/surveys/route');
  let submit: typeof import('@/app/api/submit/[token]/route');
  let reporting: typeof import('@/app/api/surveys/[id]/background-results/route');
  let lifecycle: typeof import('@/app/api/surveys/[id]/status/route');
  let directory: string;
  let databaseUrl: string;
  let environment: NodeJS.ProcessEnv;
  let cookie: string;
  let survey: { id: string; token: string; title: string; backgroundVersion: number; questions: { id: string; text: string }[]; backgroundQuestions: BackgroundQuestion[] };
  const context = () => ({ params: Promise.resolve({ id: survey.id }) });
  const publicContext = () => ({ params: Promise.resolve({ token: survey.token }) });
  const request = (method = 'GET', body?: unknown, authorized = true, query = '') => new Request(`http://localhost/api/surveys/test${query}`, {
    method, headers: { 'Content-Type': 'application/json', ...(authorized ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (overrides: Record<string, unknown> = {}) => ({
    submissionId: 'background-submission-0001', respondentToken: 'private-browser-token', backgroundVersion: survey.backgroundVersion,
    answers: survey.questions.map(q => ({ questionId: q.id, text: ' Game answer ' })), ...overrides,
  });
  const post = (body: unknown) => submit.POST(request('POST', body, false), publicContext());
  const put = (body: Record<string, unknown>) => detail.PUT(request('PUT', { title: survey.title, backgroundVersion: survey.backgroundVersion, ...body }), context());
  const snapshot = () => prisma.survey.findUniqueOrThrow({ where: { id: survey.id }, include: {
    questions: { orderBy: { sortOrder: 'asc' }, include: { answers: true } },
    backgroundQuestions: { orderBy: { sortOrder: 'asc' }, include: { answers: true } },
    responses: { include: { answers: true, backgroundAnswers: true } },
  } });
  const validAnswers = () => survey.backgroundQuestions.map(q => ({ questionId: q.id,
    values: q.type === 'TEXT' ? [' Private background note '] : q.type === 'CHECKBOX' ? ['Beta', 'Alpha'] : ['Alpha'],
  }));

  before(async () => {
    // Fail loudly, rather than silently skipping service coverage; generation belongs to integration.
    assert.ok(Prisma.dmmf.datamodel.models.some(m => m.name === 'BackgroundQuestion'), 'Main integration must generate the Prisma client before running background service tests.');
    environment = { ...process.env };
    directory = await mkdtemp(path.join(tmpdir(), 'feud-background-test-'));
    const filename = path.join(directory, 'background.db');
    databaseUrl = `file:${filename.replaceAll('\\', '/')}`;
    process.env.DATABASE_URL = databaseUrl;
    const db = new DatabaseSync(filename);
    try {
      const migrations = path.resolve('prisma/migrations');
      for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        db.exec(await readFile(path.join(migrations, entry.name, 'migration.sql'), 'utf8'));
      }
    } finally { db.close(); }
    ({ prisma } = await import('@/lib/db'));
    detail = await import('@/app/api/surveys/[id]/route');
    catalog = await import('@/app/api/surveys/route');
    submit = await import('@/app/api/submit/[token]/route');
    reporting = await import('@/app/api/surveys/[id]/background-results/route');
    lifecycle = await import('@/app/api/surveys/[id]/status/route');
    process.env.ADMIN_PASSWORD = 'background-test-admin-password';
    process.env.SESSION_SECRET = '109782d1cc645134a27767268523d7aa4';
    cookie = `admin-session=${await signAdminSession(getAuthConfig()!)}`;
  });
  after(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (environment) process.env = environment;
  });
  beforeEach(async () => {
    assert.equal(process.env.DATABASE_URL, databaseUrl);
    await prisma.survey.deleteMany();
    const result = await catalog.POST(request('POST', { title: 'Background fixture',
      questions: [{ text: 'Game question one' }, { text: 'Game question two' }], backgroundQuestions: definitions }));
    assert.equal(result.status, 200);
    survey = await result.json();
    assert.equal(survey.backgroundVersion, 0);
    assert.equal(survey.backgroundQuestions[0]._count?.answers, 0);
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
  });

  it('accepts all four types atomically and returns only decoded definitions publicly and in admin detail', async () => {
    assert.equal((await post(payload({ backgroundAnswers: validAnswers() }))).status, 200);
    const saved = await snapshot();
    assert.equal(saved.responses.length, 1);
    assert.equal(saved.responses[0].answers.length, 2);
    assert.equal(saved.responses[0].backgroundAnswers.length, 4);
    const info = await (await detail.GET(request(), context())).json();
    assert.ok(info.backgroundQuestions.every((q: BackgroundQuestion) => q._count?.answers === 1));
    const publicInfo = await (await submit.GET(request(), publicContext())).json();
    assert.equal(publicInfo.backgroundVersion, 0);
    assert.equal(publicInfo.backgroundQuestions.length, 4);
    const serialized = JSON.stringify(publicInfo);
    for (const forbidden of ['optionsJson', '_count', 'Private background note', 'respondentToken', 'backgroundAnswers', 'responses']) assert.ok(!serialized.includes(forbidden));
  });

  it('omits optional empty values, supports no-background legacy forms, and still requires game answers', async () => {
    assert.equal((await post(payload({ backgroundAnswers: survey.backgroundQuestions.map(q => ({ questionId: q.id, values: [' '] })) }))).status, 200);
    assert.equal(await prisma.backgroundAnswer.count(), 0);
    const removed = await put({ backgroundQuestions: [] });
    assert.equal(removed.status, 200);
    const saved = await removed.json();
    assert.deepEqual(saved.backgroundQuestions, []);
    const created = await (await catalog.POST(request('POST', { title: 'Legacy', questions: [{ text: 'Game' }] }))).json();
    assert.deepEqual(created.backgroundQuestions, []);
    await prisma.survey.update({ where: { id: created.id }, data: { status: 'OPEN' } });
    const legacy = { submissionId: 'legacy-new-submission', respondentToken: 'browser', answers: [{ questionId: created.questions[0].id, text: 'Answer' }] };
    assert.equal((await submit.POST(request('POST', legacy), { params: Promise.resolve({ token: created.token }) })).status, 200);
    assert.equal((await post(payload({ answers: [], backgroundVersion: saved.backgroundVersion }))).status, 400);
  });

  it('validates required, choice, cardinality, shape, duplicate and foreign IDs without any partial writes', async () => {
    const changed = await put({ backgroundQuestions: survey.backgroundQuestions.map(q => ({ ...q, required: true })) });
    survey = await changed.json();
    const before = await snapshot();
    const missing = await post(payload());
    assert.equal(missing.status, 400);
    assert.deepEqual(Object.keys((await missing.json()).fieldErrors).sort(), survey.backgroundQuestions.map(q => q.id).sort());
    const other = await prisma.survey.create({ data: { title: 'Other', backgroundQuestions: { create: { label: 'Foreign', type: 'TEXT', sortOrder: 0 } } }, include: { backgroundQuestions: true } });
    const valid = validAnswers();
    for (const backgroundAnswers of [null, {},
      valid.map((a, i) => i === 0 ? { ...a, values: ['Unknown'] } : a),
      valid.map((a, i) => i === 0 ? { ...a, values: ['Alpha', 'Beta'] } : a),
      valid.map((a, i) => i === 1 ? { ...a, values: ['Alpha', ' Alpha '] } : a),
      valid.map((a, i) => i === 3 ? { ...a, values: ['x'.repeat(2001)] } : a),
      valid.map((a, i) => i === 3 ? { ...a, values: [false] } : a),
      [...valid, { questionId: valid[0].questionId, values: [] }],
      [...valid, { questionId: other.backgroundQuestions[0].id, values: [] }],
    ]) {
      const result = await post(payload({ backgroundAnswers }));
      assert.equal(result.status, 400);
      assert.equal((await result.json()).code, 'BACKGROUND_VALIDATION');
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal((await post(payload({ backgroundAnswers: valid }))).status, 200);
  });

  it('preserves normalized no-ops and omitted config; rotates unanswered meanings and fences stale editors and forms', async () => {
    const original = await snapshot();
    assert.equal((await put({ backgroundQuestions: survey.backgroundQuestions.map(q => ({ ...q, label: ` ${q.label} `, options: q.options.map(v => ` ${v} `) })) })).status, 200);
    assert.equal((await snapshot()).backgroundVersion, 0);
    assert.deepEqual((await snapshot()).backgroundQuestions, original.backgroundQuestions);
    assert.equal((await put({ title: 'Metadata only' })).status, 200);
    assert.deepEqual((await snapshot()).backgroundQuestions, original.backgroundQuestions);
    const revised = await put({ backgroundQuestions: survey.backgroundQuestions.map((q, i) => i === 0 ? { ...q, label: 'New meaning' } : q) });
    const saved = await revised.json();
    assert.equal(saved.backgroundVersion, 1);
    assert.notEqual(saved.backgroundQuestions[0].id, survey.backgroundQuestions[0].id);
    assert.equal(saved.backgroundQuestions[1].id, survey.backgroundQuestions[1].id);
    const before = await snapshot();
    const stale = await post(payload());
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'STALE_QUESTIONS');
    assert.equal((await put({ backgroundQuestions: saved.backgroundQuestions, backgroundVersion: undefined })).status, 409);
    assert.deepEqual(await snapshot(), before);
    survey = saved;
    const added = await put({ backgroundQuestions: [...survey.backgroundQuestions, { label: 'New required', type: 'TEXT', required: true, options: [] }] });
    assert.equal(added.status, 200);
    assert.equal((await post(payload({ backgroundAnswers: validAnswers() }))).status, 409);
  });

  it('protects answered meanings/removal but permits required and order changes, staging all checks before mutations', async () => {
    assert.equal((await post(payload({ backgroundAnswers: validAnswers() }))).status, 200);
    const before = await snapshot();
    for (const backgroundQuestions of [[], survey.backgroundQuestions.slice(1),
      survey.backgroundQuestions.map((q, i) => i === 0 ? { ...q, label: 'Changed' } : q),
      survey.backgroundQuestions.map((q, i) => i === 0 ? { ...q, type: 'SELECT' } : q),
      survey.backgroundQuestions.map((q, i) => i === 0 ? { ...q, options: ['Alpha'] } : q),
    ]) {
      const result = await put({ title: 'Must not save', questions: [{ text: 'Also must not save' }], backgroundQuestions });
      assert.equal(result.status, 409);
      assert.deepEqual(await snapshot(), before);
      // Keep game questions unchanged to exercise background protection rather than the game guard.
      assert.equal((await put({ title: 'Must not save', backgroundQuestions })).status, 409);
      assert.deepEqual(await snapshot(), before);
    }
    const result = await put({ backgroundQuestions: [...survey.backgroundQuestions].reverse().map(q => ({ ...q, required: true })) });
    const changed = await result.json();
    assert.equal(changed.backgroundVersion, 1);
    assert.deepEqual(changed.backgroundQuestions.map((q: BackgroundQuestion) => q.id), survey.backgroundQuestions.map(q => q.id).reverse());
    assert.deepEqual((await snapshot()).responses, before.responses);
  });

  it('rotates unanswered type/option changes, preserves later no-ops and increments once per edit', async () => {
    for (const change of [{ type: 'SELECT' as const }, { options: ['Gamma', 'Delta'] }]) {
      const oldId = survey.backgroundQuestions[0].id;
      const version = survey.backgroundVersion;
      const result = await put({ backgroundQuestions: survey.backgroundQuestions.map((q, i) => i === 0 ? { ...q, ...change } : q) });
      assert.equal(result.status, 200);
      survey = await result.json();
      assert.notEqual(survey.backgroundQuestions[0].id, oldId);
      assert.equal(survey.backgroundVersion, version + 1);
      const before = await snapshot();
      assert.equal((await put({ backgroundQuestions: survey.backgroundQuestions })).status, 200);
      assert.deepEqual((await snapshot()).backgroundQuestions, before.backgroundQuestions);
      assert.equal((await snapshot()).backgroundVersion, version + 1);
    }
    const removed = await put({ backgroundQuestions: [] });
    assert.equal(removed.status, 200);
    const saved = await removed.json();
    assert.equal(saved.backgroundVersion, 3);
    assert.deepEqual(saved.backgroundQuestions, []);
  });

  it('serializes competing edits so only one can use a given background version', async () => {
    const backgroundQuestions = survey.backgroundQuestions.map(q => ({ ...q, required: true }));
    const results = await Promise.all([put({ backgroundQuestions }), put({ backgroundQuestions })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal((await snapshot()).backgroundVersion, 1);
    assert.equal((await put({ backgroundQuestions, backgroundVersion: 0 })).status, 409);
  });

  it('rejects unknown/duplicate config IDs and archived edits without touching survey metadata', async () => {
    const before = await snapshot();
    for (const backgroundQuestions of [[...survey.backgroundQuestions, { ...definitions[0], id: 'foreign' }],
      [survey.backgroundQuestions[0], survey.backgroundQuestions[0]],
    ]) {
      assert.equal((await put({ title: 'No changes', backgroundQuestions })).status, 400);
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal((await catalog.POST(request('POST', { title: 'Bad', questions: [{ text: 'Game' }], backgroundQuestions: survey.backgroundQuestions }))).status, 400);
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'ARCHIVED' } });
    assert.equal((await put({ backgroundQuestions: [] })).status, 409);
  });

  it('rolls back metadata, game edits, background deletions and version if a later config insert fails', async () => {
    const before = await snapshot();
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_background_config BEFORE INSERT ON BackgroundQuestion
      WHEN NEW.label='FORCE_ROLLBACK' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
    try {
      await assert.rejects(put({ title: 'Rollback', questions: [{ text: 'Replacement game question' }],
        backgroundQuestions: [{ label: 'FORCE_ROLLBACK', type: 'TEXT', required: false, options: [] }] }));
      assert.deepEqual(await snapshot(), before);
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_background_config'); }
  });

  it('rolls back the response and both answer families on a background insert failure', async () => {
    const before = await snapshot();
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_background_answer BEFORE INSERT ON BackgroundAnswer
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
    try {
      await assert.rejects(post(payload({ backgroundAnswers: validAnswers() })));
      assert.deepEqual(await snapshot(), before);
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_background_answer'); }
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_game_answer BEFORE INSERT ON Answer
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
    try {
      await assert.rejects(post(payload({ backgroundAnswers: validAnswers() })));
      assert.deepEqual(await snapshot(), before);
    } finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_game_answer'); }
  });

  it('compares game and background answers independent of field/choice ordering before version or closed status', async () => {
    const body = payload({ backgroundAnswers: validAnswers() });
    assert.equal((await post(body)).status, 200);
    const reordered = { ...body, answers: [...body.answers].reverse(),
      backgroundAnswers: validAnswers().reverse().map(a => ({ ...a, values: [...a.values].reverse().map(v => v.trim()) })) };
    assert.equal((await (await post(reordered)).json()).duplicate, true);
    const changed = await put({ backgroundQuestions: [...survey.backgroundQuestions, { label: 'Now required', type: 'TEXT', required: true, options: [] }] });
    assert.equal(changed.status, 200);
    assert.equal((await lifecycle.POST(request('POST', { status: 'CLOSED', expectedStatus: 'OPEN' }), context())).status, 200);
    assert.equal((await (await post(reordered)).json()).duplicate, true);
    for (const overrides of [{ backgroundAnswers: [] }, { answers: [body.answers[0]] }, { respondentToken: 'different' }]) {
      const conflict = await post({ ...body, ...overrides });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');
    }
    assert.equal(await prisma.response.count(), 1);
  });

  it('confirms old accepted pending payloads with no background fields after config changes and closure', async () => {
    const legacy = payload({ backgroundVersion: undefined });
    assert.equal((await post(legacy)).status, 200);
    assert.equal((await put({ backgroundQuestions: survey.backgroundQuestions.map(q => ({ ...q, required: true })) })).status, 200);
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'CLOSED' } });
    assert.equal((await (await post(legacy)).json()).duplicate, true);
    assert.equal(await prisma.backgroundAnswer.count(), 0);
  });

  it('requires admin for reports, validates pagination and includes legacy blank rows with whole-survey counts', async () => {
    assert.equal((await reporting.GET(request('GET', undefined, false), context())).status, 401);
    for (const query of ['?page=0', '?page=-1', '?page=1.5', '?page=abc', '?page=', '?pageSize=0', '?pageSize=101', '?pageSize=1e2', '?page=9007199254740992']) {
      assert.equal((await reporting.GET(request('GET', undefined, true, query), context())).status, 400);
    }
    assert.equal((await reporting.GET(request(), { params: Promise.resolve({ id: 'missing' }) })).status, 404);
    assert.equal((await post(payload({ backgroundAnswers: validAnswers() }))).status, 200);
    await prisma.response.create({ data: { surveyId: survey.id, respondentToken: 'legacy-private-token', submittedAt: new Date('2000-01-01') } });
    const report = await (await reporting.GET(request(), context())).json();
    assert.deepEqual([report.page, report.pageSize, report.pageCount, report.totalResponses], [1, 25, 1, 2]);
    assert.ok(report.questions.every((q: { answeredCount: number }) => q.answeredCount === 1));
    assert.deepEqual(report.questions[1].choices, [{ value: 'Alpha', count: 1 }, { value: 'Beta', count: 1 }]);
    assert.deepEqual(report.questions[3].choices, []);
    assert.ok(report.responses.some((r: { answers: unknown[] }) => r.answers.length === 0));
    assert.ok(JSON.stringify(report).includes('Private background note'));
    for (const forbidden of ['respondentToken', 'private-browser-token', 'legacy-private-token', 'Game answer', 'optionsJson', 'valuesJson']) assert.ok(!JSON.stringify(report).includes(forbidden));
    const second = await (await reporting.GET(request('GET', undefined, true, '?page=2&pageSize=1'), context())).json();
    assert.equal(second.pageCount, 2);
    assert.deepEqual(second.responses[0].answers, []);
    assert.deepEqual(second.questions, report.questions);
    const beyond = await (await reporting.GET(request('GET', undefined, true, '?page=9007199254740991&pageSize=1'), context())).json();
    assert.deepEqual(beyond.responses, []);
  });

  it('keeps background metadata out of review evaluator inputs, game counts and exported rounds', async () => {
    assert.equal((await post(payload({ backgroundAnswers: validAnswers() }))).status, 200);
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'anthropic';
    process.env.AI_MODEL = 'test-model';
    process.env.AI_BASE_URL = 'https://provider.invalid';
    process.env.ANTHROPIC_API_KEY = 'fake-key-no-network';
    const { reviewSurvey } = await import('@/lib/review');
    let calls = 0;
    const result = await reviewSurvey(survey.id, {}, async (question, answers) => {
      calls++;
      assert.ok(question.startsWith('Game question'));
      assert.equal(answers.length, 1);
      assert.equal(answers[0].text, 'Game answer');
      assert.deepEqual(Object.keys(answers[0]).sort(), ['id', 'text']);
      return { assignments: answers.map(a => ({ answerId: a.id, group: 'Game group', reason: null })), questionScore: 90, summary: 'Game only', issues: [] };
    });
    assert.equal(calls, 2);
    assert.equal(result.reviewed, 2);
    const { GET } = await import('@/app/api/surveys/[id]/export/route');
    const exported = await (await GET(request(), context())).json();
    assert.equal(exported.rounds.length, 2);
    assert.ok(!JSON.stringify(exported).includes('Private background note'));
    assert.deepEqual(exported.rounds[0].answers, [{ text: 'Game group', points: 100 }]);
    assert.equal(await prisma.answer.count(), 2);
    assert.equal(await prisma.backgroundAnswer.count(), 4);
  });
});
