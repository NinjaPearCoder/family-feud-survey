export const BACKGROUND_TYPES = ['RADIO', 'CHECKBOX', 'SELECT', 'TEXT'] as const;
export type BackgroundType = typeof BACKGROUND_TYPES[number];

export interface BackgroundQuestionInput {
  id?: string;
  label: string;
  type: BackgroundType;
  required: boolean;
  options: string[];
}

export interface BackgroundQuestion extends BackgroundQuestionInput {
  id: string;
  _count?: { answers: number };
}

export interface BackgroundAnswerInput {
  questionId: string;
  values: string[];
}

export class BackgroundValidationError extends Error {
  constructor(message: string, public fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'BackgroundValidationError';
  }
}

export function normalizeBackgroundQuestions(value: unknown): BackgroundQuestionInput[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new BackgroundValidationError('Provide at most 20 background fields.');
  }
  const ids = new Set<string>();
  return value.map((q: unknown) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new BackgroundValidationError('Invalid background field.');
    const field = q as Record<string, unknown>;
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.trim().length > 300 ||
        !BACKGROUND_TYPES.includes(field.type as BackgroundType) || typeof field.required !== 'boolean' ||
        !Array.isArray(field.options) || field.options.some(option => typeof option !== 'string')) {
      throw new BackgroundValidationError('Provide a label, valid type, required boolean, and options for every background field.');
    }
    const options = (field.options as string[]).map(option => option.trim());
    if (field.type === 'TEXT' ? options.length !== 0 :
      options.length < 1 || options.length > 50 || new Set(options).size !== options.length || options.some(option => !option || option.length > 100)) {
      throw new BackgroundValidationError('Choice fields need 1-50 unique, nonblank options of at most 100 characters; text fields need no options.');
    }
    let id: string | undefined;
    if (field.id !== undefined) {
      if (typeof field.id !== 'string' || !field.id.trim() || ids.has(field.id.trim())) {
        throw new BackgroundValidationError('Background field IDs must be nonblank and unique.');
      }
      id = field.id.trim();
      ids.add(id);
    }
    return { ...(id === undefined ? {} : { id }), label: field.label.trim(), type: field.type as BackgroundType, required: field.required, options };
  });
}

// Shape checks must not depend on the current definitions: accepted retries can outlive them.
export function normalizeBackgroundAnswers(value: unknown = []): BackgroundAnswerInput[] {
  if (!Array.isArray(value) || value.length > 20) throw new BackgroundValidationError('Provide at most 20 background answers.');
  const ids = new Set<string>();
  return value.map((answer: unknown) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new BackgroundValidationError('Invalid background answer.');
    const a = answer as Record<string, unknown>;
    const id = typeof a.questionId === 'string' ? a.questionId.trim() : '';
    const invalid = (message: string): never => { throw new BackgroundValidationError(message, id ? { [id]: message } : {}); };
    if (!id || ids.has(id)) invalid('Background field IDs must be nonblank and unique.');
    ids.add(id);
    if (!Array.isArray(a.values) || a.values.length > 50 || a.values.some(v => typeof v !== 'string')) {
      invalid('Provide an array of string values.');
    }
    const values = (a.values as string[]).map(v => v.trim());
    if (values.some(v => v.length > 2000)) invalid('Background values must be at most 2000 characters.');
    if (new Set(values).size !== values.length) invalid('Do not repeat a selected value.');
    return { questionId: id, values };
  });
}

export function getBackgroundErrors(questions: readonly BackgroundQuestion[], valuesRecord: Record<string, string[]>): Record<string, string> {
  const errors: Record<string, string> = {};
  const ids = new Set(questions.map(q => q.id));
  for (const id of Object.keys(valuesRecord)) {
    if (!ids.has(id)) Object.defineProperty(errors, id, { value: 'This background field does not belong to the survey.', enumerable: true });
  }
  for (const q of questions) {
    const values = Object.hasOwn(valuesRecord, q.id) ? valuesRecord[q.id].map(v => v.trim()) : [];
    let error: string | undefined;
    if (q.type !== 'CHECKBOX' && values.length > 1) error = 'Provide only one value.';
    else if (new Set(values).size !== values.length) error = 'Do not repeat a selected value.';
    else if (!values.some(Boolean)) {
      if (q.required) error = 'This field is required.';
    } else if (q.type === 'TEXT') {
      if (values[0].length > 2000) error = 'Use at most 2000 characters.';
    } else if (values.some(v => !q.options.includes(v))) error = 'Choose only the listed options.';
    if (error) Object.defineProperty(errors, q.id, { value: error, enumerable: true });
  }
  return errors;
}

export function canonicalBackgroundAnswers(answers: readonly BackgroundAnswerInput[]): BackgroundAnswerInput[] {
  return answers.map(a => ({ questionId: a.questionId, values: a.values.map(v => v.trim()).filter(Boolean).sort() }))
    .filter(a => a.values.length > 0).sort((a, b) => a.questionId.localeCompare(b.questionId));
}

export function decodeBackgroundQuestion(q: {
  id: string; label: string; type: string; required: boolean; optionsJson: string; _count?: { answers: number };
}): BackgroundQuestion {
  return { id: q.id, label: q.label, type: q.type as BackgroundType, required: q.required,
    options: JSON.parse(q.optionsJson) as string[], ...(q._count ? { _count: q._count } : {}) };
}

export function sameBackgroundMeaning(a: BackgroundQuestionInput, b: BackgroundQuestionInput): boolean {
  return a.label === b.label && a.type === b.type && JSON.stringify(a.options) === JSON.stringify(b.options);
}
