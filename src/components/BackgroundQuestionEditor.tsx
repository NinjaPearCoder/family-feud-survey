'use client';

import { BACKGROUND_TYPES, type BackgroundQuestionInput, type BackgroundType } from '@/lib/background';

export type BackgroundQuestionDraft = BackgroundQuestionInput & { _count?: { answers: number } };

const typeLabels: Record<BackgroundType, string> = {
  RADIO: 'Radio buttons',
  CHECKBOX: 'Checkboxes',
  SELECT: 'Dropdown',
  TEXT: 'Textbox',
};

export function validateBackgroundQuestions(questions: BackgroundQuestionInput[]): string | null {
  if (questions.length > 20) return 'Add no more than 20 background questions.';
  for (const [index, question] of questions.entries()) {
    const name = `Background question ${index + 1}`;
    if (!question.label.trim() || question.label.trim().length > 300) {
      return `${name}: enter a label of 1 to 300 characters.`;
    }
    if (!BACKGROUND_TYPES.includes(question.type)) return `${name}: choose a valid type.`;
    if (question.type === 'TEXT') {
      if (question.options.length) return `${name}: textboxes cannot have choices.`;
      continue;
    }
    if (!question.options.length || question.options.length > 50) {
      return `${name}: enter 1 to 50 choices, one per line.`;
    }
    const choices = question.options.map(option => option.trim());
    if (choices.some(option => !option || option.length > 100)) {
      return `${name}: every choice must have 1 to 100 characters. Remove empty lines.`;
    }
    if (new Set(choices).size !== choices.length) return `${name}: choices must be unique.`;
  }
  return null;
}

export default function BackgroundQuestionEditor({ questions, onChange, disabled = false }: {
  questions: BackgroundQuestionDraft[];
  onChange: (questions: BackgroundQuestionDraft[]) => void;
  disabled?: boolean;
}) {
  function update(index: number, changes: Partial<BackgroundQuestionInput>) {
    onChange(questions.map((question, i) => i === index ? { ...question, ...changes } : question));
  }

  function move(index: number, direction: number) {
    const reordered = [...questions];
    [reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]];
    onChange(reordered);
  }

  const inputClass = 'w-full min-w-0 bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 disabled:opacity-60';
  const buttonClass = 'rounded-lg bg-gray-700 px-3 py-2 text-sm font-bold hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <fieldset disabled={disabled} className="min-w-0 bg-gray-800 border border-gray-700 rounded-2xl p-6 space-y-4 disabled:opacity-60">
      <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase">Background Questions (Optional)</h2>
      <p className="text-sm text-gray-300">
        Background questions appear on a separate first page, stay out of game/AI results, and may identify respondents.
      </p>
      <p className="text-sm text-gray-400">
        Leave this section empty to keep the survey unchanged. Add up to 20 questions; each is optional unless marked Required.
        Answered questions cannot be relabeled, change type or choices, or be removed. Required and order can still change without losing answers.
      </p>
      {!questions.length && <p className="text-sm text-gray-400">No background questions configured.</p>}
      <div className="space-y-4">
        {questions.map((question, index) => {
          const name = `Background question ${index + 1}`;
          const prefix = `background-question-${index}`;
          const protectedQuestion = (question._count?.answers ?? 0) > 0;
          return (
            <div key={question.id ?? `new-${index}`} className="min-w-0 rounded-xl border border-gray-600 p-4 space-y-4">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-bold">{name}</h3>
                {protectedQuestion && <span className="text-sm text-blue-300">{question._count?.answers} answers; definition protected</span>}
              </div>
              <div>
                <label htmlFor={`${prefix}-label`} className="block text-sm text-gray-300 mb-2">{name} label</label>
                <input id={`${prefix}-label`} value={question.label} maxLength={300} disabled={protectedQuestion}
                  onChange={event => update(index, { label: event.target.value })} className={inputClass} />
              </div>
              <div>
                <label htmlFor={`${prefix}-type`} className="block text-sm text-gray-300 mb-2">{name} type</label>
                <select id={`${prefix}-type`} value={question.type} disabled={protectedQuestion}
                  onChange={event => {
                    const type = event.target.value as BackgroundType;
                    update(index, { type, options: type === 'TEXT' ? [] : question.options });
                  }} className={inputClass}>
                  {BACKGROUND_TYPES.map(type => <option key={type} value={type}>{typeLabels[type]}</option>)}
                </select>
              </div>
              {question.type !== 'TEXT' ? (
                <div>
                  <label htmlFor={`${prefix}-choices`} className="block text-sm text-gray-300 mb-2">{name} choices</label>
                  <textarea id={`${prefix}-choices`} rows={4} value={question.options.join('\n')} disabled={protectedQuestion}
                    onChange={event => update(index, { options: event.target.value.split('\n') })}
                    aria-describedby={`${prefix}-choices-help`} className={inputClass} />
                  <p id={`${prefix}-choices-help`} className="text-xs text-gray-400 mt-2">One choice per line, up to 50 choices and 100 characters per choice. No blank or duplicate choices.</p>
                </div>
              ) : <p className="text-xs text-gray-400">Textbox responses allow up to 2,000 characters.</p>}
              <label htmlFor={`${prefix}-required`} className="flex items-center gap-3 text-sm">
                <input id={`${prefix}-required`} type="checkbox" checked={question.required}
                  onChange={event => update(index, { required: event.target.checked })} className="h-4 w-4 accent-blue-500" />
                {name} required
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0}
                  aria-label={`Move background question ${index + 1} up`} className={buttonClass}>Move up</button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === questions.length - 1}
                  aria-label={`Move background question ${index + 1} down`} className={buttonClass}>Move down</button>
                <button type="button" onClick={() => onChange(questions.filter((_, i) => i !== index))} disabled={protectedQuestion}
                  aria-label={`Remove background question ${index + 1}`} className={`${buttonClass} text-red-300`}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" disabled={questions.length >= 20}
        onClick={() => onChange([...questions, { label: '', type: 'RADIO', required: false, options: [] }])}
        className="text-blue-400 hover:text-blue-300 text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed">
        + Add background question
      </button>
    </fieldset>
  );
}
