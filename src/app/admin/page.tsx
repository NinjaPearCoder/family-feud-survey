'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { SURVEY_STATUSES, type SurveyStatus } from '@/lib/survey';

const statusColors: Record<SurveyStatus, string> = {
  DRAFT: 'bg-gray-700 text-gray-200',
  OPEN: 'bg-green-900 text-green-300',
  CLOSED: 'bg-amber-900 text-amber-300',
  ARCHIVED: 'bg-purple-900 text-purple-300',
};

interface Survey {
  id: string;
  title: string;
  description?: string | null;
  source?: string | null;
  audience?: string | null;
  status: SurveyStatus;
  createdAt: string;
  _count: { responses: number; questions: number };
}

export default function AdminPage() {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [audience, setAudience] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/surveys');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to load surveys.');
      if (!Array.isArray(data)) throw new Error('Unable to load surveys.');
      setSurveys(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to load surveys.');
    } finally {
      setLoading(false);
    }
  }

  async function deleteSurvey(id: string, title: string) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setDeleting(id);
    setError('');
    try {
      const response = await fetch(`/api/surveys/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? 'Unable to delete survey.');
      }
      setSurveys(current => current.filter(s => s.id !== id));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to delete survey.');
    } finally {
      setDeleting(null);
    }
  }

  const filtered = surveys.filter(s => (!status || s.status === status)
    && (s.audience ?? '').toLowerCase().includes(audience.trim().toLowerCase()));

  return (
    <div>
      <div className="flex flex-wrap gap-4 items-center justify-between mb-8">
        <h1 className="text-2xl font-bold tracking-wide">SURVEYS</h1>
        <Link
          href="/admin/surveys/new"
          className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-xl transition-colors"
        >
          + New Survey
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        <div>
          <label htmlFor="status-filter" className="block text-sm font-bold text-gray-400 mb-2">Status</label>
          <select id="status-filter" value={status} onChange={e => setStatus(e.target.value)}
            className="w-full bg-gray-800 border border-gray-600 rounded-xl px-4 py-3">
            <option value="">All statuses</option>
            {SURVEY_STATUSES.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="audience-filter" className="block text-sm font-bold text-gray-400 mb-2">Audience</label>
          <input id="audience-filter" value={audience} onChange={e => setAudience(e.target.value)}
            placeholder="Filter by audience" type="search"
            className="w-full min-w-0 bg-gray-800 border border-gray-600 rounded-xl px-4 py-3" />
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-xl border border-red-800 bg-red-950 p-4 text-red-200">
        <p>{error}</p>
        <button onClick={load} disabled={loading} className="mt-2 underline disabled:opacity-50">Retry loading surveys</button>
      </div>}
      {loading && <p className="mb-4 text-gray-400" role="status">Loading...</p>}

      {!loading && !error && !surveys.length && (
        <div className="text-center py-20 text-gray-500 border border-dashed border-gray-700 rounded-2xl">
          <p className="text-lg mb-2">No surveys yet</p>
          <p className="text-sm">Create your first survey to get started</p>
        </div>
      )}
      {!loading && surveys.length > 0 && !filtered.length && (
        <p className="py-10 text-center text-gray-400">No surveys match these filters.</p>
      )}

      <div className="space-y-4">
        {filtered.map(s => (
          <div key={s.id} className="bg-gray-800 border border-gray-700 rounded-2xl p-5">
            <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold break-words [overflow-wrap:anywhere]">{s.title}</h2>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${statusColors[s.status]}`}>{s.status}</span>
                </div>
                {s.description && (
                  <p className="text-gray-400 text-sm mb-2 break-words [overflow-wrap:anywhere]">{s.description}</p>
                )}
                <p className="text-sm text-gray-400 mb-2 break-words [overflow-wrap:anywhere]">Audience: {s.audience || 'Not specified'}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400 [overflow-wrap:anywhere]">
                  <span>{s._count.questions} questions</span>
                  <span>·</span>
                  <span className="font-bold text-blue-400">{s._count.responses} responses</span>
                  {s.source && <><span>·</span><span>{s.source}</span></>}
                  <span>·</span>
                  <span>Created <time dateTime={s.createdAt}>{new Date(s.createdAt).toLocaleDateString()}</time></span>
                </div>
              </div>
              <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
                <Link
                  href={`/admin/surveys/${s.id}`}
                  className="bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold px-3 py-1.5 rounded-lg transition-colors"
                >
                  {s.status === 'ARCHIVED' ? 'View' : 'Edit'}
                </Link>
                <Link
                  href={`/admin/surveys/${s.id}/results`}
                  className="bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold px-3 py-1.5 rounded-lg transition-colors"
                >
                  Results
                </Link>
                <button
                  onClick={() => deleteSurvey(s.id, s.title)}
                  disabled={deleting !== null}
                  aria-label={`Delete ${s.title}`}
                  className="bg-gray-700 hover:bg-red-900 text-gray-400 hover:text-red-300 text-sm font-bold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {deleting === s.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
