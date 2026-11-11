import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getQuestionPage, restoreDraft } from '../src/lib/pagination';
import { getBackgroundErrors, type BackgroundQuestion } from '../src/lib/background';

const questions = Array.from({ length: 12 }, (_, i) => ({ id: `q${i + 1}` }));

describe('public survey pagination', () => {
  it('slices into five-question pages without mutating or losing questions', () => {
    const pages = [0, 1, 2].map(page => getQuestionPage(questions, page));
    assert.deepEqual(pages.map(p => p.questions.length), [5, 5, 2]);
    assert.deepEqual(pages.map(p => p.start), [0, 5, 10]);
    assert.deepEqual(pages.flatMap(p => p.questions), questions);
    assert.ok(pages.every(p => p.pageCount === 3));
  });

  it('keeps zero through five questions on a single page', () => {
    for (let count = 0; count <= 5; count++) {
      const result = getQuestionPage(questions.slice(0, count), 9);
      assert.equal(result.page, 0);
      assert.equal(result.pageCount, 1);
      assert.equal(result.questions.length, count);
    }
    assert.equal(getQuestionPage(questions.slice(0, 6), 0).pageCount, 2);
    assert.equal(getQuestionPage(questions.slice(0, 10), 0).pageCount, 2);
  });

  it('clamps page bounds and normalizes non-integer and non-finite pages', () => {
    for (const page of [-20, NaN, Infinity, -Infinity]) {
      assert.equal(getQuestionPage(questions, page).page, 0);
    }
    assert.equal(getQuestionPage(questions, 1.8).page, 1);
    assert.equal(getQuestionPage(questions, 100).page, 2);
  });
});

const background: BackgroundQuestion[] = [
  { id: 'radio', label: 'Radio', type: 'RADIO', required: false, options: ['A', 'B'] },
  { id: 'checks', label: 'Checks', type: 'CHECKBOX', required: true, options: ['A', 'B'] },
  { id: 'select', label: 'Select', type: 'SELECT', required: false, options: ['A', 'B'] },
  { id: 'text', label: 'Text', type: 'TEXT', required: false, options: [] },
];

describe('background page and draft reconciliation', () => {
  it('keeps 13 game questions on three pages, or four including the intro', () => {
    const thirteen = [...questions, { id: 'q13' }];
    assert.deepEqual([0, 1, 2].map(page => getQuestionPage(thirteen, page).questions.length), [5, 5, 3]);
    const pages = [0, 1, 2, 3].map(page => getQuestionPage(thirteen, page, true));
    assert.deepEqual(pages.map(p => p.questions.length), [0, 5, 5, 3]);
    assert.deepEqual(pages.map(p => p.start), [0, 0, 5, 10]);
    assert.deepEqual(pages.flatMap(p => p.questions), thirteen);
    assert.ok(pages.every(p => p.pageCount === 4));
    for (const page of [-5, NaN, Infinity, -Infinity]) {
      assert.equal(getQuestionPage(thirteen, page, true).page, 0);
      assert.deepEqual(getQuestionPage(thirteen, page, true).questions, []);
    }
    assert.equal(getQuestionPage(thirteen, 100, true).page, 3);
    assert.equal(getQuestionPage(thirteen, 2.8, true).start, 5);
    assert.deepEqual(getQuestionPage([], 0, true).questions, []);
    assert.deepEqual(getQuestionPage([], 1, true).questions, []);
  });

  it('opens old drafts at the intro without losing game answers', () => {
    const old = { answers: { q1: '  kept  ', gone: 'discard' }, page: 2 };
    const recovered = restoreDraft(old, questions, background, 1);
    assert.equal(recovered?.page, 0);
    assert.deepEqual(recovered?.answers, { q1: '  kept  ' });
    assert.deepEqual(recovered?.backgroundValues, { radio: [], checks: [], select: [], text: [] });
    assert.equal(recovered?.backgroundVersion, 1);
    assert.equal(restoreDraft(old, questions, [], 1)?.page, 2);
    assert.equal(old.page, 2);
  });

  it('retains current values and page, removes unknown options, and enforces cardinality', () => {
    const saved = { answers: { q1: 'game' }, page: 3, backgroundVersion: 4,
      backgroundValues: { radio: ['stale', 'A', 'B'], checks: ['A', 'A', 'stale', 'B'], select: ['B', 'A'], text: ['  raw text  ', 'extra'], removed: ['secret'] } };
    const recovered = restoreDraft(saved, questions, background, 4);
    assert.equal(recovered?.page, 3);
    assert.deepEqual(recovered?.backgroundValues, { radio: ['A'], checks: ['A', 'B'], select: ['B'], text: ['  raw text  '] });
    assert.equal(restoreDraft(saved, questions.slice(0, 6), background, 4)?.page, 2);
    assert.deepEqual(saved.backgroundValues.checks, ['A', 'A', 'stale', 'B']);
  });

  it('resets revised definitions to the intro, preserving compatible values but not changed types', () => {
    const saved = { answers: { q1: 'game', removed: 'old' }, page: 3, backgroundVersion: 4,
      backgroundTypes: { radio: 'TEXT', checks: 'CHECKBOX', select: 'SELECT', text: 'TEXT' },
      backgroundValues: { radio: ['A'], checks: ['A', 'removed'], select: ['removed'], text: ['  kept  '], gone: ['old'] } };
    const recovered = restoreDraft(saved, questions, background, 5);
    assert.equal(recovered?.page, 0);
    assert.equal(recovered?.backgroundVersion, 5);
    assert.deepEqual(recovered?.answers, { q1: 'game' });
    assert.deepEqual(recovered?.backgroundValues, { radio: [], checks: ['A'], select: [], text: ['  kept  '] });
    assert.deepEqual(recovered?.backgroundTypes, { radio: 'RADIO', checks: 'CHECKBOX', select: 'SELECT', text: 'TEXT' });
    assert.deepEqual(restoreDraft(saved, questions.slice(0, 6), [], 5)?.backgroundValues, {});
    assert.equal(restoreDraft(saved, questions.slice(0, 6), [], 5)?.page, 1);
  });

  it('discards malformed background values without sacrificing the game draft', () => {
    const saved = { answers: { q1: 'kept' }, page: 1, backgroundVersion: 1,
      backgroundValues: { radio: 'A', checks: [42, 'A'], select: null, text: [false, 'text'] } };
    const recovered = restoreDraft(saved, questions, background, 1);
    assert.deepEqual(recovered?.answers, { q1: 'kept' });
    assert.deepEqual(recovered?.backgroundValues, { radio: [], checks: ['A'], select: [], text: ['text'] });
    assert.deepEqual(restoreDraft({ ...saved, backgroundValues: null }, questions, background, 1)?.backgroundValues,
      { radio: [], checks: [], select: [], text: [] });
    assert.deepEqual(restoreDraft(saved, questions, background, 2)?.backgroundValues,
      { radio: [], checks: ['A'], select: [], text: ['text'] });
  });

  it('recovers frozen pending values after only order or requiredness changes, without separate type metadata', () => {
    const pendingDraft = { answers: { q1: 'game' }, page: 3, backgroundVersion: 1,
      backgroundValues: { radio: ['B'], checks: ['A', 'B'], select: ['A'], text: ['kept note'] } };
    const reordered = [...background].reverse().map(q => ({ ...q, required: true }));
    const recovered = restoreDraft(pendingDraft, questions, reordered, 2);
    assert.equal(recovered?.page, 0);
    assert.deepEqual(recovered?.backgroundValues, pendingDraft.backgroundValues);
    assert.deepEqual(restoreDraft(JSON.parse(JSON.stringify(recovered)), questions, reordered, 2), recovered);
  });

  it('treats prototype-like background IDs as own keys only', () => {
    const fields: BackgroundQuestion[] = ['__proto__', 'constructor'].map(id => ({ id, label: id, type: 'TEXT', required: false, options: [] }));
    const saved = JSON.parse('{"answers":{},"page":0,"backgroundVersion":1,"backgroundValues":{"__proto__":["raw"],"constructor":["text"]}}');
    const recovered = restoreDraft(saved, questions, fields, 1);
    assert.deepEqual(Object.entries(recovered!.backgroundValues!), [['__proto__', ['raw']], ['constructor', ['text']]]);
    assert.deepEqual(restoreDraft({ ...saved, backgroundValues: {} }, questions, fields, 1)?.backgroundValues,
      Object.fromEntries(fields.map(q => [q.id, []])));
  });

  it('requires at least one checkbox choice, allows optional blanks, and validates every field type', () => {
    assert.deepEqual(getBackgroundErrors(background, { checks: ['A'] }), {});
    assert.deepEqual(Object.keys(getBackgroundErrors(background, {})), ['checks']);
    assert.deepEqual(getBackgroundErrors(background.map(q => ({ ...q, required: false })), {}), {});
    assert.deepEqual(Object.keys(getBackgroundErrors(background, { radio: ['A', 'B'], checks: ['gone'], select: ['gone'], text: ['one', 'two'] })),
      ['radio', 'checks', 'select', 'text']);
    assert.deepEqual(Object.keys(getBackgroundErrors(background.map(q => ({ ...q, required: true })), { text: ['   '] })),
      ['radio', 'checks', 'select', 'text']);
  });
});

describe('editable draft recovery', () => {
  it('retains only current IDs and preserves raw text, including blanks', () => {
    const saved = { answers: { q1: '  Original Text  ', q2: '', q3: '   ', removed: 'old' }, page: 2 };
    assert.deepEqual(restoreDraft(saved, questions), {
      answers: { q1: '  Original Text  ', q2: '', q3: '   ' }, page: 2,
    });
    assert.equal(saved.answers.removed, 'old');
  });

  it('clamps the saved page when questions shrink, including an empty survey', () => {
    const saved = { answers: { q1: 'kept', q12: 'removed' }, page: 2 };
    assert.deepEqual(restoreDraft(saved, questions.slice(0, 6)), { answers: { q1: 'kept' }, page: 1 });
    assert.deepEqual(restoreDraft(saved, []), { answers: {}, page: 0 });
    assert.equal(restoreDraft({ answers: {}, page: -5 }, questions)?.page, 0);
  });

  it('does not recover answers from another set of question IDs', () => {
    assert.deepEqual(restoreDraft({ answers: { other: 'private draft' }, page: 0 }, questions), { answers: {}, page: 0 });
  });

  it('rejects malformed drafts instead of coercing data', () => {
    for (const value of [null, [], 'draft', {}, { answers: {}, page: '1' },
      { answers: [], page: 0 }, { answers: null, page: 0 }, { answers: { q1: 42 }, page: 0 },
      { answers: { removed: false }, page: 0 }, { answers: {}, page: 0.5 },
      { answers: {}, page: NaN }, { answers: {}, page: Infinity }, { answers: {}, page: Number.MAX_VALUE }]) {
      assert.equal(restoreDraft(value, questions), null);
    }
  });

  it('handles prototype-like IDs as literal keys, not inherited answers', () => {
    const saved = JSON.parse('{"answers":{"__proto__":"raw","constructor":"text"},"page":0}');
    const recovered = restoreDraft(saved, [{ id: '__proto__' }, { id: 'constructor' }]);
    assert.ok(recovered);
    assert.deepEqual(Object.entries(recovered.answers), [['__proto__', 'raw'], ['constructor', 'text']]);
    assert.equal(Object.getPrototypeOf(recovered.answers), Object.prototype);
  });
});
