import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it, type TestContext } from 'node:test';

const initialMigration = readFileSync(new URL('../prisma/migrations/20240101000000_init/migration.sql', import.meta.url), 'utf8');
const lifecycleMigration = readFileSync(new URL('../prisma/migrations/20261111000000_survey_lifecycle/migration.sql', import.meta.url), 'utf8');
const tables = ['Survey', 'Question', 'Response', 'Answer', 'Tabulation'] as const;

async function legacyDatabase(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'feud-migration-test-'));
  let db: DatabaseSync | undefined;
  t.after(async () => {
    try {
      db?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  db = new DatabaseSync(path.join(directory, 'migration.db'));
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(initialMigration);
  db.exec(`
    INSERT INTO Survey (id, title, description, source, createdAt, updatedAt, lockedAt, token) VALUES
      ('open', 'Legacy open', 'Keep this description', 'Imported source', '2024-01-02T03:04:05.123Z', '2025-06-07T08:09:10.456Z', NULL, 'open-survey-token'),
      ('closed', 'Legacy closed', NULL, NULL, '2024-02-03T04:05:06.789Z', '2025-07-08T09:10:11.012Z', '2025-07-08T09:10:11.012Z', 'closed-survey-token');
    INSERT INTO Question (id, surveyId, text, sortOrder) VALUES
      ('q-open-1', 'open', 'Name a fruit', 1),
      ('q-open-2', 'open', 'Name a pet', 0),
      ('q-closed', 'closed', 'Name a color', 0);
    INSERT INTO Response (id, surveyId, respondentToken, submittedAt) VALUES
      ('r-open-1', 'open', 'repeat-browser-token', '2024-03-04T05:06:07.123Z'),
      ('r-open-2', 'open', 'repeat-browser-token', '2024-03-05T06:07:08.456Z'),
      ('r-open-3', 'open', 'another-browser-token', '2024-03-06T07:08:09.789Z'),
      ('r-closed', 'closed', 'repeat-browser-token', '2024-04-05T06:07:08.012Z');
    INSERT INTO Answer (id, responseId, questionId, text) VALUES
      ('a-1', 'r-open-1', 'q-open-1', ' Apple '),
      ('a-2', 'r-open-1', 'q-open-2', 'Cat'),
      ('a-3', 'r-open-2', 'q-open-1', 'apple'),
      ('a-4', 'r-open-2', 'q-open-2', 'Dog'),
      ('a-5', 'r-open-3', 'q-open-1', 'Pear'),
      ('a-6', 'r-closed', 'q-closed', 'Blue');
    INSERT INTO Tabulation (id, questionId, answerText, count, qualityScore, tabulatedAt) VALUES
      ('t-1', 'q-open-1', 'Apple', 2, 0.875, '2025-01-02T03:04:05.123Z'),
      ('t-2', 'q-open-1', 'Pear', 1, NULL, '2025-01-02T03:04:05.456Z'),
      ('t-3', 'q-open-2', 'Cat', 1, 0, '2025-02-03T04:05:06.789Z'),
      ('t-4', 'q-closed', 'Blue', 1, 1, '2025-07-08T09:10:11.012Z');
  `);
  return db;
}

function snapshot(db: DatabaseSync) {
  return Object.fromEntries(tables.map(table => [
    table, db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all().map(row => ({ ...row })),
  ]));
}

it('maps legacy lifecycle state without changing IDs, tokens, dates, or related data', async t => {
  const db = await legacyDatabase(t);
  const before = snapshot(db);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  db.exec(lifecycleMigration);

  const after = snapshot(db);
  assert.deepEqual(after.Survey, before.Survey.map(({ lockedAt, ...survey }) => ({
    ...survey,
    audience: null,
    status: lockedAt === null ? 'OPEN' : 'CLOSED',
    openedAt: null,
    closedAt: lockedAt,
    archivedAt: null,
  })));
  assert.deepEqual(after.Response, before.Response.map(response => ({ ...response, submissionId: null })));
  for (const table of ['Question', 'Answer', 'Tabulation']) {
    assert.deepEqual(after[table], before[table], `${table} data must be unchanged`);
  }
  assert.deepEqual(tables.map(table => after[table].length), [2, 3, 4, 6, 4]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
  for (const name of [
    'Survey_token_key', 'Survey_status_idx', 'Question_surveyId_idx', 'Response_surveyId_idx',
    'Response_surveyId_submissionId_key', 'Answer_questionId_idx',
    'Answer_responseId_questionId_key', 'Tabulation_questionId_idx',
  ]) {
    assert.ok(indexes.includes(name), `Missing index: ${name}`);
  }
});

it('enforces submission identity per survey while allowing repeated respondents and multiple NULL identities', async t => {
  const db = await legacyDatabase(t);
  db.exec(lifecycleMigration);
  const insert = db.prepare('INSERT INTO Response (id, surveyId, respondentToken, submissionId) VALUES (?, ?, ?, ?)');
  insert.run('new-1', 'open', 'repeat-browser-token', 'submission-1');
  insert.run('new-2', 'open', 'repeat-browser-token', 'submission-2');
  insert.run('new-3', 'closed', 'repeat-browser-token', 'submission-1');
  insert.run('null-1', 'open', 'repeat-browser-token', null);
  insert.run('null-2', 'open', 'repeat-browser-token', null);
  assert.throws(() => insert.run('duplicate', 'open', 'different-browser', 'submission-1'),
    /UNIQUE constraint failed: Response\.surveyId, Response\.submissionId/);
  assert.throws(() => db.prepare('UPDATE Response SET submissionId = ? WHERE id = ?').run('submission-1', 'new-2'),
    /UNIQUE constraint failed: Response\.surveyId, Response\.submissionId/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Response WHERE submissionId IS NULL').get()?.count, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Response').get()?.count, 9);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

it('enforces answer uniqueness on the response/question pair, not either column alone', async t => {
  const db = await legacyDatabase(t);
  db.exec(lifecycleMigration);
  const before = snapshot(db).Answer;
  const insert = db.prepare('INSERT INTO Answer (id, responseId, questionId, text) VALUES (?, ?, ?, ?)');
  assert.throws(() => insert.run('duplicate-answer', 'r-open-1', 'q-open-1', 'Different text'),
    /UNIQUE constraint failed: Answer\.responseId, Answer\.questionId/);
  assert.throws(() => db.prepare('UPDATE Answer SET questionId = ? WHERE id = ?').run('q-open-1', 'a-2'),
    /UNIQUE constraint failed: Answer\.responseId, Answer\.questionId/);
  assert.deepEqual(snapshot(db).Answer, before);
  insert.run('new-answer', 'r-open-3', 'q-open-2', 'Cat');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Answer').get()?.count, 7);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

it('defaults new surveys to DRAFT and accepts only the four lifecycle statuses', async t => {
  const db = await legacyDatabase(t);
  db.exec(lifecycleMigration);
  db.prepare('INSERT INTO Survey (id, title, updatedAt, token) VALUES (?, ?, ?, ?)')
    .run('draft', 'New survey', '2026-11-11T12:13:14.123Z', 'draft-survey-token');
  assert.deepEqual({ ...db.prepare('SELECT status, audience, openedAt, closedAt, archivedAt FROM Survey WHERE id = ?').get('draft') }, {
    status: 'DRAFT', audience: null, openedAt: null, closedAt: null, archivedAt: null,
  });
  const insert = db.prepare('INSERT INTO Survey (id, title, updatedAt, token, status) VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE Survey SET status = ? WHERE id = ?');
  for (const status of ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED']) {
    insert.run(`status-${status}`, 'Valid status', '2026-11-11T12:13:14.123Z', `token-${status}`, status);
    update.run(status, 'draft');
    assert.equal(db.prepare('SELECT status FROM Survey WHERE id = ?').get('draft')?.status, status);
  }
  for (const status of ['INVALID', 'open', '']) {
    assert.throws(() => insert.run('invalid', 'Invalid', '2026-11-11T12:13:14.123Z', 'invalid-token', status), /CHECK constraint failed/);
    assert.throws(() => update.run(status, 'draft'), /CHECK constraint failed/);
  }
  assert.throws(() => update.run(null, 'draft'), /NOT NULL constraint failed: Survey\.status/);
  assert.equal(db.prepare('SELECT status FROM Survey WHERE id = ?').get('draft')?.status, 'ARCHIVED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Survey').get()?.count, 7);
});

it('rejects duplicate legacy answers and rolls back all schema and data changes without deleting them', async t => {
  const db = await legacyDatabase(t);
  db.prepare('INSERT INTO Answer (id, responseId, questionId, text) VALUES (?, ?, ?, ?)')
    .run('legacy-duplicate', 'r-open-1', 'q-open-1', 'Keep this conflicting answer too');
  const before = snapshot(db);
  const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const originalSchema = schema.all();

  assert.throws(() => db.exec(lifecycleMigration),
    /UNIQUE constraint failed: Answer\.responseId, Answer\.questionId/);
  // SQLite leaves the failed migration transaction open; the caller must roll it back.
  db.exec('ROLLBACK; PRAGMA foreign_keys=ON;');

  assert.deepEqual(schema.all(), originalSchema);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(tables.map(table => snapshot(db)[table].length), [2, 3, 4, 7, 4]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Answer WHERE responseId = ? AND questionId = ?')
    .get('r-open-1', 'q-open-1')?.count, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
});
