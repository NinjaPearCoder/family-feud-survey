import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--replace-local-samples'), 'Only --replace-local-samples is supported');
const replaceSamples = args.includes('--replace-local-samples');
const base = new URL(process.env.SURVEY_IMPORT_URL || 'http://127.0.0.1:3000');
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'Use the application origin, without credentials or a path');
assert.ok(base.protocol === 'https:' || (base.protocol === 'http:' && local), 'HTTPS is required except on loopback');
assert.ok(!replaceSamples || local, 'Sample deletion is allowed only on a loopback preview');
assert.ok(process.env.ADMIN_PASSWORD, 'Set ADMIN_PASSWORD for the target application');
const catalog = JSON.parse(await readFile(new URL('../surveys/livit.json', import.meta.url), 'utf8'));
assert.equal(catalog.length, 5);
assert.equal(new Set(catalog.map(s => s.title)).size, 5);
for (const survey of catalog) {
  assert.equal(survey.audience, 'LivIT');
  assert.equal(survey.questions.length, 10);
  assert.ok(survey.questions.every(q => typeof q === 'string' && q.trim()));
}

let cookie = '';
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}); existing surveys were not overwritten`);
  return response;
}
const login = await request('/api/auth/login', 'POST', { password: process.env.ADMIN_PASSWORD });
cookie = login.headers.getSetCookie().find(value => value.startsWith('admin-session='))?.split(';')[0] || '';
assert.ok(cookie, 'Login returned no admin session');
const existing = await (await request('/api/surveys')).json();
const matched = new Map();
// Preflight existing titles first; never silently overwrite a survey or its collected data.
for (const entry of catalog) {
  const matches = existing.filter(s => s.title === entry.title);
  assert.ok(matches.length <= 1, `Multiple surveys named ${entry.title}; resolve the ambiguity before importing`);
  if (matches.length) {
    const survey = await (await request(`/api/surveys/${matches[0].id}`)).json();
    assert.equal(survey.audience, entry.audience, `Audience mismatch: ${entry.title}`);
    assert.deepEqual(survey.questions.map(q => q.text), entry.questions, `Question mismatch: ${entry.title}`);
    matched.set(entry.title, survey);
  }
}
for (const entry of catalog) {
  const survey = matched.get(entry.title) || await (await request('/api/surveys', 'POST', {
    title: entry.title, source: entry.source, audience: entry.audience,
    questions: entry.questions.map(text => ({ text })),
  })).json();
  const verified = await (await request(`/api/surveys/${survey.id}`)).json();
  assert.equal(verified.audience, 'LivIT');
  assert.deepEqual(verified.questions.map(q => q.text), entry.questions);
  console.log(`${entry.title}: ${verified.status}, 10 questions (${new URL(`/admin/surveys/${survey.id}`, base)})`);
}
// Only remove the explicitly named local samples after every replacement is verified.
if (replaceSamples) {
  for (const sample of existing.filter(s => ['Local Preview - Team Building', 'Test party'].includes(s.title))) {
    await request(`/api/surveys/${sample.id}`, 'DELETE');
    console.log(`Removed sample: ${sample.title}`);
  }
}
console.log('Import verified. New surveys are drafts; review and open them in the admin console.');
