import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

it('contains the five LivIT survey sets with ten distinct questions each', async () => {
  const catalog = JSON.parse(await readFile(new URL('../surveys/livit.json', import.meta.url), 'utf8')) as { title: string; audience: string; source: string; questions: string[] }[];
  assert.deepEqual(catalog.map(s => s.title), ['LivIT and Workplace', 'Holiday Party', 'Technology', 'Just for Fun', 'Easy \u201cSurvey Says\u201d Questions']);
  for (const survey of catalog) {
    assert.equal(survey.audience, 'LivIT');
    assert.equal(survey.source, 'LivIT');
    assert.equal(survey.questions.length, 10);
    assert.equal(new Set(survey.questions).size, 10);
    assert.ok(survey.questions.every(q => q === q.trim() && q.length > 0));
  }
  assert.equal(catalog[0].questions[0], 'Name something people contact LivIT to fix.');
  assert.equal(catalog[4].questions[9], 'What is one word that describes LivIT?');
});

it('refuses sample deletion on remote destinations before making any requests', () => {
  const result = spawnSync(process.execPath, ['scripts/import-livit-surveys.mjs', '--replace-local-samples'], {
    env: { ...process.env, SURVEY_IMPORT_URL: 'https://example.invalid', ADMIN_PASSWORD: 'unused-test-password' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Sample deletion is allowed only on a loopback preview/);
});
