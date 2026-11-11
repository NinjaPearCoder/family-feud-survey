import type { BackgroundQuestion } from './background';

export interface SurveyDraft {
  answers: Record<string, string>;
  page: number;
  backgroundValues?: Record<string, string[]>;
  backgroundVersion?: number;
  // Do not reinterpret saved values when a revision changes a field's type.
  backgroundTypes?: Record<string, BackgroundQuestion['type']>;
}

export function getQuestionPage<T>(questions: readonly T[], requestedPage: number, hasBackground = false) {
  const offset = hasBackground ? 1 : 0;
  const pageCount = Math.max(1, Math.ceil(questions.length / 5)) + offset;
  const page = Math.min(pageCount - 1, Math.max(0, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0));
  const start = Math.max(0, page - offset) * 5;
  return { page, pageCount, start, questions: hasBackground && page === 0 ? [] : questions.slice(start, start + 5) };
}

export function restoreDraft(value: unknown, questions: readonly { id: string }[], backgroundQuestions: readonly BackgroundQuestion[] = [], backgroundVersion?: number): SurveyDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { answers, page } = value as SurveyDraft;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || !Number.isSafeInteger(page)) return null;
  const entries = Object.entries(answers);
  if (entries.some(([, text]) => typeof text !== 'string')) return null;
  const ids = new Set(questions.map(q => q.id));
  const saved = value as SurveyDraft;
  const revised = saved.backgroundVersion !== backgroundVersion;
  const backgroundValues = saved.backgroundValues;
  const backgroundTypes = saved.backgroundTypes;
  const values = Object.fromEntries(backgroundQuestions.map(q => {
    const raw = backgroundValues && Object.hasOwn(backgroundValues, q.id) ? backgroundValues[q.id] : undefined;
    const type = backgroundTypes && Object.hasOwn(backgroundTypes, q.id) ? backgroundTypes[q.id] : undefined;
    // Meaning/type changes rotate field IDs on the server. Stable IDs survive order/required changes,
    // including frozen pending payloads that have values but no separate draft type metadata.
    const compatible = type ? type === q.type : true;
    const valid = compatible && Array.isArray(raw) ? [...new Set(raw.filter((v): v is string =>
      typeof v === 'string' && (q.type === 'TEXT' || q.options.includes(v))))] : [];
    return [q.id, q.type === 'CHECKBOX' ? valid : valid.slice(0, 1)];
  }));
  return {
    answers: Object.fromEntries(entries.filter(([id]) => ids.has(id))),
    page: getQuestionPage(questions, revised && backgroundQuestions.length ? 0 : page, backgroundQuestions.length > 0).page,
    ...(backgroundVersion !== undefined || backgroundQuestions.length ? {
      backgroundValues: values,
      backgroundVersion,
      backgroundTypes: Object.fromEntries(backgroundQuestions.map(q => [q.id, q.type])),
    } : {}),
  };
}
