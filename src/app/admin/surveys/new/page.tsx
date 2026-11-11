'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import BackgroundQuestionEditor, { validateBackgroundQuestions, type BackgroundQuestionDraft } from '@/components/BackgroundQuestionEditor';

interface Question { text: string }

export default function NewSurveyPage() {
  const router = useRouter();
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [source,      setSource]      = useState('');
  const [audience,    setAudience]    = useState('');
  const [questions,   setQuestions]   = useState<Question[]>([{ text: '' }]);
  const [backgroundQuestions, setBackgroundQuestions] = useState<BackgroundQuestionDraft[]>([]);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState('');

  function addQuestion() { setQuestions(q => [...q, { text: '' }]); }
  function removeQuestion(i: number) { setQuestions(q => q.filter((_, j) => j !== i)); }
  function updateQuestion(i: number, text: string) {
    setQuestions(q => q.map((item, j) => j === i ? { text } : item));
  }

  async function save() {
    if (saving) return;
    if (!title.trim()) { setError('Title is required'); return; }
    const filled = questions.filter(q => q.text.trim());
    if (!filled.length) { setError('Add at least one question'); return; }
    const backgroundError = validateBackgroundQuestions(backgroundQuestions);
    if (backgroundError) { setError(backgroundError); return; }

    setSaving(true);
    setError('');

    try {
      const response = await fetch('/api/surveys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, source, audience, questions: filled,
          backgroundQuestions: backgroundQuestions.map(({ label, type, required, options }) => ({ label, type, required, options })),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Unable to create draft.');
      if (!result.id) throw new Error('The server did not return a survey ID. Check the survey list before retrying.');
      router.push(`/admin/surveys/${encodeURIComponent(result.id)}`);
    } catch (error) {
      setError(`${error instanceof Error ? error.message : 'Unable to create draft.'} Your draft has been kept.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-8">
        <Link href="/admin" className="text-gray-400 hover:text-white transition-colors">← Back</Link>
        <h1 className="text-2xl font-bold tracking-wide">NEW SURVEY</h1>
      </div>
      <p className="text-gray-400 text-sm mb-6">New surveys are created as drafts. Save your questions, then open the survey to accept responses.</p>

      <fieldset disabled={saving} className="space-y-6 min-w-0">
        {/* Metadata */}
        <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase">Details</h2>
          <div>
            <label htmlFor="title" className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              id="title" required
              value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Holiday Party 2024"
              className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor="description" className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Description</label>
            <input
              id="description"
              value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes"
              className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor="source" className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Source</label>
            <input
              id="source"
              value={source} onChange={e => setSource(e.target.value)}
              placeholder="e.g. Office party, Family reunion"
              className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor="audience" className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Audience</label>
            <input id="audience" value={audience} onChange={e => setAudience(e.target.value)}
              placeholder="e.g. Coworkers, Extended family"
              className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
          </div>
        </div>

        {/* Questions */}
        <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6">
          <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-4">Questions</h2>
          <div className="space-y-3">
            {questions.map((q, i) => (
              <div key={i} className="flex gap-3 items-center">
                <span className="text-gray-500 text-sm w-6 text-right flex-shrink-0">{i + 1}</span>
                <input
                  aria-label={`Question ${i + 1}`}
                  value={q.text} onChange={e => updateQuestion(i, e.target.value)}
                  placeholder={`Name something you find in a kitchen…`}
                  className="min-w-0 flex-1 bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                {questions.length > 1 && (
                  <button
                    onClick={() => removeQuestion(i)}
                    aria-label={`Remove question ${i + 1}`}
                    className="text-gray-500 hover:text-red-400 transition-colors flex-shrink-0"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={addQuestion}
            className="mt-4 text-blue-400 hover:text-blue-300 text-sm font-bold transition-colors"
          >
            + Add Question
          </button>
        </div>

        <BackgroundQuestionEditor questions={backgroundQuestions} onChange={setBackgroundQuestions} disabled={saving} />

        {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}

        <div className="flex gap-3">
          <Link href="/admin" className="flex-1 text-center bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 rounded-xl transition-colors">
            Cancel
          </Link>
          <button
            onClick={save} disabled={saving}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-colors"
          >
            {saving ? 'Creating…' : 'Create Draft'}
          </button>
        </div>
      </fieldset>
    </div>
  );
}
