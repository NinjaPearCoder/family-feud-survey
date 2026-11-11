'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import QRCode from 'qrcode';
import { STATUS_TRANSITIONS, type SurveyStatus } from '@/lib/survey';
import type { BackgroundQuestion } from '@/lib/background';
import BackgroundQuestionEditor, { validateBackgroundQuestions, type BackgroundQuestionDraft } from '@/components/BackgroundQuestionEditor';

const statusColors: Record<SurveyStatus, string> = {
  DRAFT: 'bg-gray-700 text-gray-200',
  OPEN: 'bg-green-900 text-green-300',
  CLOSED: 'bg-amber-900 text-amber-300',
  ARCHIVED: 'bg-purple-900 text-purple-300',
};

interface Question { id: string; text: string; _count: { answers: number }; tabulations?: unknown[] }
interface Survey {
  id: string; title: string; description?: string | null; source?: string | null;
  audience?: string | null; status: SurveyStatus; token: string;
  createdAt: string; openedAt?: string | null; closedAt?: string | null; archivedAt?: string | null;
  collection: { firstResponseAt: string | null; lastResponseAt: string | null };
  questions: Question[];
  backgroundQuestions: BackgroundQuestion[];
  backgroundVersion: number;
  _count: { responses: number };
}

export default function SurveyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [survey,    setSurvey]    = useState<Survey | null>(null);
  const [title,     setTitle]     = useState('');
  const [desc,      setDesc]      = useState('');
  const [source,    setSource]    = useState('');
  const [audience,  setAudience]  = useState('');
  const [questions, setQuestions] = useState<{ id?: string; text: string }[]>([]);
  const [backgroundQuestions, setBackgroundQuestions] = useState<BackgroundQuestionDraft[]>([]);
  const [error, setError] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [saving,    setSaving]    = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [toast,     setToast]     = useState('');

  const load = useCallback(async () => {
    const response = await fetch(`/api/surveys/${id}`);
    if (!response.ok) throw new Error('Unable to load survey. Try signing in again.');
    const data: Survey = await response.json();
    setSurvey(data);
    setTitle(data.title);
    setDesc(data.description ?? '');
    setSource(data.source ?? '');
    setAudience(data.audience ?? '');
    setQuestions(data.questions.map(q => ({ id: q.id, text: q.text })));
    setBackgroundQuestions(data.backgroundQuestions);
  }, [id]);

  useEffect(() => { load().catch(error => setError(error.message)); }, [load]);

  useEffect(() => {
    if (!survey?.token) return;
    let active = true;
    const url = `${window.location.origin}/survey/${survey.token}`;
    QRCode.toDataURL(url, { width: 300, margin: 2 }).then(dataUrl => {
      if (active) setQrDataUrl(dataUrl);
    }).catch(() => {
      if (active) setError('Unable to generate the QR code. You can still copy the survey link.');
    });
    return () => { active = false; };
  }, [survey?.token]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }

  async function save() {
    if (!survey || survey.status === 'ARCHIVED' || saving || changingStatus) return;
    const backgroundError = validateBackgroundQuestions(backgroundQuestions);
    if (backgroundError) { setError(backgroundError); return; }
    setSaving(true);
    setError('');
    try {
      const filled = questions.filter(q => q.id || q.text.trim());
      const response = await fetch(`/api/surveys/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: desc, source, audience, questions: filled,
          backgroundQuestions: backgroundQuestions.map(({ id, label, type, required, options }) => ({ id, label, type, required, options })),
          backgroundVersion: survey.backgroundVersion,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Unable to save survey.');
      setSurvey(result);
      setTitle(result.title);
      setDesc(result.description ?? '');
      setSource(result.source ?? '');
      setAudience(result.audience ?? '');
      setQuestions(result.questions.map((q: Question) => ({ id: q.id, text: q.text })));
      setBackgroundQuestions(result.backgroundQuestions);
      showToast('Saved!');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to save survey. Your draft has been kept.');
    } finally {
      setSaving(false);
    }
  }

  function updateLifecycle(result: Survey) {
    // Status changes must never replace the editable draft or its saved baseline.
    setSurvey(current => current ? {
      ...current,
      status: result.status,
      openedAt: result.openedAt,
      closedAt: result.closedAt,
      archivedAt: result.archivedAt,
    } : current);
  }

  async function changeStatus(status: SurveyStatus) {
    if (!survey || saving || changingStatus || !STATUS_TRANSITIONS[survey.status].includes(status)) return;
    if (dirty && (status === 'OPEN' || status === 'ARCHIVED')) return;
    setChangingStatus(true);
    setError('');
    try {
      const response = await fetch(`/api/surveys/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, expectedStatus: survey.status }),
      });
      const result = await response.json();
      if (response.status === 409) {
        const latest = await fetch(`/api/surveys/${id}`);
        if (latest.ok) updateLifecycle(await latest.json());
        throw new Error(result.error ?? 'Survey status changed elsewhere. Review the current status and retry.');
      }
      if (!response.ok) throw new Error(result.error ?? 'Unable to change survey status.');
      updateLifecycle(result);
      showToast(`Survey ${status.toLowerCase()}`);
    } catch (error) {
      setError(`${error instanceof Error ? error.message : 'Unable to change survey status.'} Your draft has been kept.`);
    } finally {
      setChangingStatus(false);
    }
  }

  function addQuestion() { setQuestions(q => [...q, { text: '' }]); }
  function removeQuestion(i: number) { setQuestions(q => q.filter((_, j) => j !== i)); }
  function updateQuestion(i: number, text: string) {
    setQuestions(q => q.map((item, j) => j === i ? { ...item, text } : item));
  }

  const surveyUrl = survey ? `${typeof window !== 'undefined' ? window.location.origin : ''}/survey/${survey.token}` : '';
  const isArchived = survey?.status === 'ARCHIVED';
  const editingDisabled = isArchived || saving || changingStatus;
  const dirty = !!survey && (title !== survey.title || desc !== (survey.description ?? '')
    || source !== (survey.source ?? '') || audience !== (survey.audience ?? '')
    || JSON.stringify(questions) !== JSON.stringify(survey.questions.map(q => ({ id: q.id, text: q.text })))
    || JSON.stringify(backgroundQuestions) !== JSON.stringify(survey.backgroundQuestions));

  if (!survey) return <p role={error ? 'alert' : undefined} className="text-gray-400">{error || 'Loading…'}</p>;

  return (
    <div>
      {error && <p role="alert" className="mb-4 rounded-xl border border-red-800 bg-red-950 p-4 text-red-200">{error}</p>}
      {toast && (
        <div role="status" className="fixed top-20 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-6 py-2 rounded-full text-sm font-bold z-50 max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      <div className="flex items-center gap-4 mb-8 flex-wrap">
        <Link href="/admin" className="text-gray-400 hover:text-white transition-colors">← Back</Link>
        <h1 className="text-2xl font-bold tracking-wide flex-1 min-w-0 [overflow-wrap:anywhere]">{survey.title}</h1>
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${statusColors[survey.status]}`}>{survey.status}</span>
        <span className="text-blue-400 font-bold">{survey._count.responses} responses</span>
        <Link href={`/admin/surveys/${id}/results`} className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-xl transition-colors">
          View Results
        </Link>
        <Link href={`/admin/surveys/${id}/background`} className="bg-gray-700 hover:bg-gray-600 text-white font-bold px-4 py-2 rounded-xl transition-colors">
          Background answers
        </Link>
      </div>

      <div className="space-y-6">
        <section aria-labelledby="collection-heading" className="bg-gray-800 border border-gray-700 rounded-2xl p-6">
          <h2 id="collection-heading" className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-4">Collection Status</h2>
          <p className="text-sm text-gray-300 mb-4">
            {survey.status === 'DRAFT' && 'This draft is not accepting responses. Save your changes, then open it when ready.'}
            {survey.status === 'OPEN' && 'This survey is open and accepting responses.'}
            {survey.status === 'CLOSED' && 'Collection is closed. Reopen to accept more responses, or archive to make this survey read-only.'}
            {isArchived && 'This survey is archived and read-only. Restore it to Closed to edit it again; restoring does not reopen collection.'}
          </p>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm mb-5">
            {[
              { label: 'Created', value: survey.createdAt, empty: 'Unknown' },
              { label: 'First opened', value: survey.openedAt, empty: survey.status === 'DRAFT' ? 'Not opened' : 'Not recorded (never opened or legacy unknown)' },
              { label: 'Current closed', value: survey.closedAt, empty: survey.status === 'OPEN' ? 'Not closed (open)' : 'Not recorded' },
              { label: 'Archived', value: survey.archivedAt, empty: 'Not recorded' },
              { label: 'First response', value: survey.collection.firstResponseAt, empty: 'No responses' },
              { label: 'Latest response', value: survey.collection.lastResponseAt, empty: 'No responses' },
            ].map(({ label, value, empty }) => (
              <div key={label} className="min-w-0">
                <dt className="text-gray-400 mb-1">{label}</dt>
                <dd className="break-words">{value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : empty}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-gray-400 mb-4">Response dates reflect actual submissions, not the survey's open and close dates.</p>
          {dirty && <p id="unsaved-warning" role="status" className="text-sm text-amber-300 mb-3">Unsaved changes. Save before opening or archiving. Closing keeps your draft intact.</p>}
          <div className="flex flex-wrap gap-3">
            {STATUS_TRANSITIONS[survey.status].map(target => (
              <button key={target} onClick={() => changeStatus(target)}
                disabled={saving || changingStatus || (dirty && (target === 'OPEN' || target === 'ARCHIVED'))}
                aria-describedby={dirty ? 'unsaved-warning' : undefined}
                className={`text-sm font-bold px-4 py-2 rounded-xl transition-colors hover:brightness-125 disabled:opacity-40 disabled:cursor-not-allowed ${statusColors[target]}`}>
                {target === 'OPEN' ? (survey.status === 'DRAFT' ? 'Open' : 'Reopen')
                  : target === 'ARCHIVED' ? 'Archive' : survey.status === 'ARCHIVED' ? 'Restore to Closed' : 'Close'}
              </button>
            ))}
            {changingStatus && <span role="status" className="text-sm text-gray-400 self-center">Updating status...</span>}
          </div>
        </section>

        {/* QR Code */}
        <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6">
          <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-4">Survey Link & QR Code</h2>
          <div className="flex flex-col sm:flex-row gap-6 items-center">
            {qrDataUrl && (
              <div className="bg-white p-3 rounded-xl flex-shrink-0">
                <img src={qrDataUrl} alt="QR Code" className="w-36 h-36" />
              </div>
            )}
            <div className="w-full flex-1 min-w-0">
              <p className="text-gray-400 text-sm mb-2">{survey.status === 'OPEN' ? 'Share this link or QR code with respondents:' : 'This link accepts responses only while the survey is Open.'}</p>
              <div className="bg-gray-700 rounded-xl px-4 py-3 text-blue-400 text-sm break-all font-mono mb-3">
                {surveyUrl}
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(surveyUrl);
                      showToast('Link copied!');
                    } catch {
                      setError('Unable to copy the link. Select the displayed link to copy it manually.');
                    }
                  }}
                  className="bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold px-3 py-2 rounded-lg transition-colors"
                >
                  Copy Link
                </button>
                {qrDataUrl && (
                  <a
                    href={qrDataUrl} download={`${survey.title}-qr.png`}
                    className="bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold px-3 py-2 rounded-lg transition-colors"
                  >
                    Download QR
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <fieldset disabled={editingDisabled} className="min-w-0 bg-gray-800 border border-gray-700 rounded-2xl p-6 space-y-4 disabled:opacity-60">
          <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase">Details</h2>
          <label htmlFor="title" className="block text-sm font-bold text-gray-400">Title</label>
          <input id="title" required value={title} onChange={e => setTitle(e.target.value)} placeholder="Title"
            className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
          <label htmlFor="description" className="block text-sm font-bold text-gray-400">Description</label>
          <input id="description" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description"
            className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
          <label htmlFor="source" className="block text-sm font-bold text-gray-400">Source</label>
          <input id="source" value={source} onChange={e => setSource(e.target.value)} placeholder="Source"
            className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
          <label htmlFor="audience" className="block text-sm font-bold text-gray-400">Audience</label>
          <input id="audience" value={audience} onChange={e => setAudience(e.target.value)} placeholder="e.g. Coworkers, Extended family"
            className="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
        </fieldset>

        {/* Questions */}
        <fieldset disabled={editingDisabled} className="min-w-0 bg-gray-800 border border-gray-700 rounded-2xl p-6 disabled:opacity-60">
          <h2 className="text-xs font-bold tracking-widest text-gray-400 uppercase mb-4">Questions</h2>
          <p className="text-sm text-gray-400 mb-4">Questions with answers or tabulations are protected from changes and deletion. {isArchived ? 'Restore this survey to edit details or add questions.' : 'You can still edit survey details or add questions.'}</p>
          <div className="space-y-3 mb-4">
            {questions.map((q, i) => {
              const original = survey.questions.find(original => original.id === q.id);
              const protectedQuestion = !!original && (original._count.answers > 0 || !!original.tabulations?.length);
              return (
                <div key={q.id ?? `new-${i}`} className="flex flex-wrap sm:flex-nowrap gap-3 items-center">
                  <span className="text-gray-500 text-sm w-6 text-right flex-shrink-0">{i + 1}</span>
                  <input value={q.text} onChange={e => updateQuestion(i, e.target.value)} disabled={protectedQuestion || saving}
                    aria-label={`Question ${i + 1}`}
                    placeholder="Survey question…"
                    className="min-w-0 flex-1 bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-60"
                  />
                  {original && (
                    <span className="text-xs text-blue-400 flex-shrink-0">{original._count.answers} answers</span>
                  )}
                  <button onClick={() => removeQuestion(i)} disabled={protectedQuestion || saving} aria-label={`Remove question ${i + 1}`} className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-30">✕</button>
                </div>
              );
            })}
          </div>
          <button onClick={addQuestion} className="text-blue-400 hover:text-blue-300 text-sm font-bold transition-colors">
            + Add Question
          </button>
        </fieldset>

        <BackgroundQuestionEditor questions={backgroundQuestions} onChange={setBackgroundQuestions} disabled={editingDisabled} />

        <button onClick={save} disabled={editingDisabled}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-colors"
        >
          {saving ? 'Saving…' : '💾 Save Changes'}
        </button>
      </div>
    </div>
  );
}
