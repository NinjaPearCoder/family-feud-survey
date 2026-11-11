import { normalizeBackgroundQuestions, type BackgroundQuestionInput } from './background';

export const SURVEY_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'] as const;
export type SurveyStatus = typeof SURVEY_STATUSES[number];

export function surveyForAdmin<T extends { reviewLeaseId?: unknown; reviewLeaseUntil?: unknown }>(survey: T) {
  const { reviewLeaseId, reviewLeaseUntil, ...data } = survey;
  return data;
}

export const STATUS_TRANSITIONS: Record<SurveyStatus, readonly SurveyStatus[]> = {
  DRAFT: ['OPEN', 'ARCHIVED'],
  OPEN: ['CLOSED'],
  CLOSED: ['OPEN', 'ARCHIVED'],
  ARCHIVED: ['CLOSED'],
};

export function isSurveyStatus(value: unknown): value is SurveyStatus {
  return typeof value === 'string' && SURVEY_STATUSES.some(status => status === value);
}

export interface SurveyInput {
  title: string;
  description?: string | null;
  source?: string | null;
  audience?: string | null;
  questions?: { id?: string; text: string }[];
  backgroundQuestions?: BackgroundQuestionInput[];
  backgroundVersion?: number;
}

export function isSurveyInput(value: unknown): value is SurveyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== 'string' || !body.title.trim() || 'status' in body) return false;
  for (const field of ['description', 'source', 'audience']) {
    if (body[field] != null && typeof body[field] !== 'string') return false;
  }
  if (body.backgroundVersion !== undefined && (!Number.isSafeInteger(body.backgroundVersion) || (body.backgroundVersion as number) < 0)) return false;
  if (body.backgroundQuestions !== undefined) {
    try { normalizeBackgroundQuestions(body.backgroundQuestions); } catch { return false; }
  }
  if (body.questions === undefined) return true;
  if (!Array.isArray(body.questions) || body.questions.length === 0) return false;
  const ids = new Set<string>();
  return body.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return false;
    const question = q as Record<string, unknown>;
    if (typeof question.text !== 'string' || !question.text.trim()) return false;
    if (question.id !== undefined) {
      if (typeof question.id !== 'string' || !question.id || ids.has(question.id)) return false;
      ids.add(question.id);
    }
    return true;
  });
}
