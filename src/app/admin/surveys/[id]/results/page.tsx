'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { type SurveyStatus } from '@/lib/survey';
import type { ReviewRun } from '@/lib/review';

const statusColors: Record<SurveyStatus, string> = {
  DRAFT: 'bg-gray-700 text-gray-200',
  OPEN: 'bg-green-900 text-green-300',
  CLOSED: 'bg-amber-900 text-amber-300',
  ARCHIVED: 'bg-purple-900 text-purple-300',
};

interface Tabulation { answerText: string; count: number; qualityScore?: number | null }
interface Question {
  id: string; text: string;
  _count: { answers: number };
  tabulations: Tabulation[];
}
interface Survey {
  id: string; title: string; status: SurveyStatus;
  questions: Question[];
  _count: { responses: number };
}
interface ReviewStatus {
  ai: {
    enabled: boolean; provider: string; model: string; targetResponses: number;
    intervalMinutes: number; schedulerConfigured: boolean;
  };
  job: { running: boolean; lastAttemptAt: string | null; lastError: string | null };
  totalPending: number;
  questions: {
    questionId: string; pendingCount: number; stale: boolean;
    review: {
      reviewedAt: string; responseCount: number; validCount: number; flaggedCount: number;
      qualityScore: number; sampleScore: number; questionScore: number; distributionScore: number;
      groupCount: number; topAnswerShare: number; topEightShare: number;
      recommendation: string; summary: string; issues: string[]; provider: string; model: string;
      flags: { answerId: string; text: string; reason: string }[];
    } | null;
  }[];
}

export default function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  return <Results key={id} id={id} />;
}

function Results({ id }: { id: string }) {
  const [data, setData] = useState<{ survey: Survey; review: ReviewStatus } | null>(null);
  const [tabulating, setTabulating] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const loading = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);

  const load = useCallback(async (replace = false) => {
    if (loading.current && !replace) return;
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    try {
      // Grouped counts and their assessment come from one database snapshot.
      const response = await fetch(`/api/surveys/${id}/review`, { signal: controller.signal, cache: 'no-store' });
      const review = await response.json();
      if (!response.ok) throw new Error(review.error ?? 'Unable to load results or review status.');
      if (!controller.signal.aborted) {
        setData({ survey: review.survey, review });
        setLoadError('');
      }
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Unable to load results or review status.');
    } finally {
      controller.abort();
      if (loading.current === controller) loading.current = null;
    }
  }, [id]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => { void load(); }, 10_000);
    return () => {
      clearInterval(interval);
      loading.current?.abort();
      loading.current = null;
      mutation.current?.abort();
    };
  }, [load]);

  const canReview = !!data && data.review.ai.enabled && !data.review.job.running && !tabulating && !loadError
    && (data.survey.status === 'OPEN' || data.survey.status === 'CLOSED');

  async function runTabulation(force = false) {
    if (!canReview || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    loading.current?.abort();
    loading.current = null;
    setTabulating(true);
    setError('');
    setRunMessage('Reviewing up to 5 questions. This may take a moment.');
    try {
      const response = await fetch(`/api/surveys/${id}/tabulate${force ? '?force=true' : ''}`, {
        method: 'POST', signal: controller.signal,
      });
      const result: { ok?: boolean; run?: ReviewRun; error?: string } = await response.json();
      if (controller.signal.aborted) return;
      if (result.run) {
        const run = result.run;
        setRunMessage(`Batch ${run.status}: ${run.reviewed} reviewed, ${run.unchanged} unchanged, ${run.failed} failed, ${run.stale} stale (not saved), ${run.remaining} remaining.${run.remaining > 0 ? ' More batches are needed.' : ''}`);
      } else {
        setRunMessage('No batch counts returned; completion could not be confirmed.');
      }
      if (!response.ok || !result.ok) {
        setError(result.error ?? 'The batch was not fully successful. Successful reviews were retained; see counts and job details below.');
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setRunMessage('Batch completion could not be confirmed. Refreshing saved results.');
        setError(error instanceof Error ? error.message : 'Unable to run review.');
      }
    } finally {
      // Even a failed/partial run may have saved reviews. Supersede in-flight polls.
      if (!controller.signal.aborted) {
        await load(true);
        if (!controller.signal.aborted) setTabulating(false);
      }
      if (mutation.current === controller) mutation.current = null;
    }
  }

  function exportJson() {
    window.open(`/api/surveys/${id}/export`, '_blank');
  }

  if (!data) return <p role={loadError ? 'alert' : 'status'} className="text-gray-400">{loadError ? `${loadError} Retrying automatically every 10 seconds.` : 'Loading results and review status...'}</p>;

  const { survey, review } = data;
  const totalResponses = survey._count.responses;
  const hasTabulations = survey.questions.some(q => q.tabulations.length > 0);

  return (
    <div>
      {error && <p role="alert" className="mb-4 rounded-xl border border-red-800 bg-red-950 p-4 text-red-200">{error}</p>}
      {loadError && <p role="alert" className="mb-4 rounded-xl border border-amber-800 bg-amber-950 p-4 text-amber-200">{loadError} Showing the last successfully loaded results; status may be out of date. Retrying automatically every 10 seconds.</p>}
      {runMessage && <p role="status" className="mb-4 rounded-xl border border-blue-800 bg-blue-950 p-4 text-blue-200">{runMessage}</p>}

      <div className="flex items-center gap-4 mb-8 flex-wrap">
        <Link href={`/admin/surveys/${id}`} className="text-gray-400 hover:text-white transition-colors">← Details</Link>
        <h1 className="text-2xl font-bold tracking-wide flex-1 min-w-0 [overflow-wrap:anywhere]">{survey.title}</h1>
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${statusColors[survey.status]}`}>{survey.status}</span>
        <span className="text-blue-400 font-bold">{totalResponses} responses</span>
      </div>

      <section aria-labelledby="review-heading" className="bg-gray-800 border border-gray-700 rounded-2xl p-5 mb-6">
        <h2 id="review-heading" className="text-lg font-bold mb-3">AI Review</h2>
        <p className="rounded-xl border border-amber-700 bg-amber-950 p-4 text-amber-200 mb-4">
          Advisory only. AI recommendations do not mark a survey Ready, change its status, or publish a game. Review the answers and make publication decisions yourself.
        </p>
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm [overflow-wrap:anywhere]">
          <div><dt className="text-gray-400">AI configuration</dt><dd className="font-semibold">{review.ai.enabled ? 'Enabled' : 'Disabled or configuration incomplete'}</dd></div>
          <div><dt className="text-gray-400">Provider / model</dt><dd>{review.ai.provider || 'Not configured'} / {review.ai.model || 'Not configured'}</dd></div>
          <div><dt className="text-gray-400">Usable response target</dt><dd>{review.ai.targetResponses} per question</dd></div>
          <div><dt className="text-gray-400">Configured review interval</dt><dd>{review.ai.intervalMinutes} minutes</dd></div>
          <div><dt className="text-gray-400">Scheduler credential</dt><dd>{review.ai.schedulerConfigured ? 'Configured' : 'Not configured'}</dd></div>
          <div><dt className="text-gray-400">Job (last fetched status)</dt><dd>{review.job.running ? 'Running' : 'Not running'}</dd></div>
          <div><dt className="text-gray-400">Last attempt</dt><dd>{review.job.lastAttemptAt ? <time dateTime={review.job.lastAttemptAt}>{new Date(review.job.lastAttemptAt).toLocaleString()}</time> : 'No attempts recorded'}</dd></div>
          <div><dt className="text-gray-400">Pending answers</dt><dd>{review.totalPending} (changed questions require full regrouping)</dd></div>
        </dl>
        <p className="text-sm text-gray-400 mt-4">A configured scheduler credential does not prove a worker is scheduled or running. This page checks results every 10 seconds using read-only requests; it never starts reviews automatically.</p>
        {review.job.lastError && <p className="mt-4 text-sm text-red-300 [overflow-wrap:anywhere]">Last job error: {review.job.lastError}</p>}
      </section>

      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 mb-6 flex flex-wrap gap-3 items-center">
        <div className="flex-1 min-w-0 basis-full sm:basis-auto">
          <p className="text-sm text-gray-400">
            {totalResponses === 0
              ? (survey.status === 'OPEN' ? 'No responses yet. Share the survey link to start collecting.' : 'No responses yet. The survey must be Open to collect responses.')
              : `${totalResponses} response${totalResponses !== 1 ? 's' : ''} collected across ${survey.questions.length} questions.`}
          </p>
          <p id="review-action-notice" className="text-sm text-gray-400 mt-2">
            Each run processes up to 5 questions. Review new answers skips unchanged snapshots; Reassess all includes unchanged questions, still at most 5 per run.
            {!review.ai.enabled && ' AI must be enabled with valid configuration.'}
            {survey.status !== 'OPEN' && survey.status !== 'CLOSED' && ' Reviews are available only for Open or Closed surveys.'}
            {review.job.running && ' A review job is already running.'}
            {loadError && ' Actions are paused until results refresh successfully.'}
          </p>
        </div>
        <button
          onClick={() => void runTabulation()} disabled={!canReview}
          aria-describedby="review-action-notice"
          className="bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white font-bold px-4 py-2 rounded-xl transition-colors text-sm"
        >
          Review new answers
        </button>
        <button
          onClick={() => void runTabulation(true)} disabled={!canReview}
          aria-describedby="review-action-notice"
          className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white font-bold px-4 py-2 rounded-xl transition-colors text-sm"
        >
          Reassess all
        </button>
        {hasTabulations && (
          <button
            onClick={exportJson}
            className="bg-green-700 hover:bg-green-600 text-white font-bold px-4 py-2 rounded-xl transition-colors text-sm"
          >
            ⬇ Export JSON
          </button>
        )}
      </div>

      {/* Per-question results */}
      <div className="space-y-6">
        {survey.questions.map((q, qi) => {
          const questionStatus = review.questions.find(item => item.questionId === q.id);
          const snapshot = questionStatus?.review;
          return (
          <div key={q.id} className="bg-gray-800 border border-gray-700 rounded-2xl p-6">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-500 uppercase tracking-widest font-bold mb-1">Question {qi + 1}</p>
                <h2 className="text-lg font-bold [overflow-wrap:anywhere]">{q.text}</h2>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-2xl font-bold text-blue-400">
                  {q._count.answers}
                </div>
                <div className="text-xs text-gray-400">answers collected</div>
              </div>
            </div>

            <p className={`text-sm font-semibold mb-3 ${!snapshot || questionStatus?.stale ? 'text-amber-300' : 'text-blue-300'}`}>
              {!questionStatus ? 'Review status unavailable for this question.' : !snapshot ? 'No review yet. Collected answers have not been assessed.' : questionStatus.stale
                ? 'Stale review: last good results remain visible below. Inputs or configuration have changed; reassessment is needed.'
                : 'Current review: matches inputs and configuration at the last status check.'}
            </p>
            {questionStatus && <p className="text-xs text-gray-400 mb-4">{questionStatus.pendingCount} answers pending review</p>}

            {snapshot && (
              <div className="mb-6 space-y-4">
                <p className="text-xs text-gray-400 [overflow-wrap:anywhere]">
                  Reviewed <time dateTime={snapshot.reviewedAt}>{new Date(snapshot.reviewedAt).toLocaleString()}</time> using {snapshot.provider} / {snapshot.model}. Snapshot: {snapshot.responseCount} answers.
                </p>
                <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                  <div><dt className="text-gray-400">Sample (usable / target)</dt><dd className="font-bold">{snapshot.validCount} / {review.ai.targetResponses}</dd></div>
                  <div><dt className="text-gray-400">Flagged answers</dt><dd className="font-bold">{snapshot.flaggedCount}</dd></div>
                  <div><dt className="text-gray-400">Quality (usable answers)</dt><dd className="font-bold">{snapshot.qualityScore.toFixed(1)}%</dd></div>
                  <div><dt className="text-gray-400">AI question score</dt><dd className="font-bold">{snapshot.questionScore.toFixed(1)} / 100</dd></div>
                  <div><dt className="text-gray-400">Distribution score</dt><dd className="font-bold">{snapshot.distributionScore.toFixed(1)} / 100</dd></div>
                  <div><dt className="text-gray-400">Distinct groups</dt><dd className="font-bold">{snapshot.groupCount}</dd></div>
                  <div><dt className="text-gray-400">Top answer share</dt><dd className="font-bold">{(snapshot.topAnswerShare * 100).toFixed(1)}%</dd></div>
                  <div><dt className="text-gray-400">Top 8 share</dt><dd className="font-bold">{(snapshot.topEightShare * 100).toFixed(1)}%</dd></div>
                </dl>
                <progress aria-label={`Question ${qi + 1} usable answers toward configured target`} className="block w-full h-2 accent-blue-500" value={Math.min(snapshot.validCount, review.ai.targetResponses)} max={review.ai.targetResponses} />
                <p className="text-xs text-gray-400">Shares are percentages of usable answers. Scores and recommendation describe the saved snapshot; the sample target shown is the current configuration.</p>
                <p className="text-sm font-semibold text-amber-200 [overflow-wrap:anywhere]">Advisory recommendation: {snapshot.recommendation === 'NEEDS_MORE_RESPONSES' ? 'NEEDS_MORE_RESPONSES' : snapshot.recommendation === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION' : snapshot.recommendation === 'PROMISING' ? 'PROMISING' : 'Unavailable'}</p>
                <p className="text-sm text-gray-200 whitespace-pre-wrap [overflow-wrap:anywhere]">{snapshot.summary}</p>
                {snapshot.issues.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-semibold mb-2">Issues</h3>
                    <ul className="list-disc pl-5 space-y-1 text-sm text-amber-200 [overflow-wrap:anywhere]">
                      {snapshot.issues.map((issue, index) => <li key={index}>{issue}</li>)}
                    </ul>
                  </div>
                ) : <p className="text-sm text-gray-400">No issues reported in this snapshot.</p>}
                {snapshot.flaggedCount > 0 && (
                  <details className="rounded-xl border border-gray-700 p-3">
                    <summary className="cursor-pointer text-sm font-semibold">Flagged answers ({snapshot.flaggedCount})</summary>
                    <p className="text-xs text-gray-400 mt-3">{snapshot.flags.length} matching answer details available. Changed or removed answers are omitted.</p>
                    <ul className="mt-3 space-y-3 text-sm">
                      {snapshot.flags.map(flag => (
                        <li key={flag.answerId} className="border-t border-gray-700 pt-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
                          <p className="text-amber-200">Reason: {flag.reason}</p>
                          <p className="text-gray-300 mt-1">Answer: {flag.text}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <h3 className="text-sm font-semibold mb-3">Grouped answers{snapshot && questionStatus?.stale ? ' (last good tabulation)' : ''}</h3>
            {q.tabulations.length > 0 ? (
              <div className="space-y-2">
                {q.tabulations.map((t, ti) => (
                  <div key={ti} className="flex items-center gap-3">
                    <span className="text-gray-500 text-sm w-5 text-right">{ti + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap gap-2 items-center justify-between mb-0.5">
                        <span className="min-w-0 font-semibold text-sm [overflow-wrap:anywhere]">{t.answerText}</span>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          {t.qualityScore != null && (
                            <span className="text-xs text-gray-500">Q:{Math.round(t.qualityScore)}</span>
                          )}
                          <span className="text-blue-400 font-bold text-sm">{t.count}</span>
                        </div>
                      </div>
                      <div className="w-full bg-gray-700 rounded-full h-1.5">
                        <div
                          className="bg-blue-500 h-1.5 rounded-full"
                          style={{ width: `${Math.min(100, (t.count / Math.max(1, q._count.answers)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-500 text-sm">
                {q._count.answers > 0
                  ? (snapshot ? 'No usable groups in the saved tabulation.' : 'Review answers to group and rank them.')
                  : 'No answers yet'}
              </p>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
