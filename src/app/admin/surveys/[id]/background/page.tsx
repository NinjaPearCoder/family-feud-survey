'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { BackgroundQuestionInput } from '@/lib/background';

interface BackgroundResults {
  questions: (BackgroundQuestionInput & {
    id: string;
    answeredCount: number;
    choices: { value: string; count: number }[];
  })[];
  responses: {
    id: string;
    submittedAt: string;
    answers: { questionId: string; values: string[] }[];
  }[];
  totalResponses: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export default function BackgroundAnswersPage() {
  const { id } = useParams<{ id: string }>();
  return <BackgroundAnswers key={id} id={id} />;
}

function BackgroundAnswers({ id }: { id: string }) {
  const [data, setData] = useState<BackgroundResults | null>(null);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData(null);
    async function load() {
      try {
        const response = await fetch(`/api/surveys/${encodeURIComponent(id)}/background-results?page=${page}&pageSize=20`, {
          signal: controller.signal, cache: 'no-store',
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Unable to load background answers. Try signing in again.');
        if (!controller.signal.aborted) setData(result);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to load background answers.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [id, page, attempt]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Link href={`/admin/surveys/${id}`} className="text-gray-400 hover:text-white">Back to survey details</Link>
        <h1 className="text-2xl font-bold tracking-wide">BACKGROUND ANSWERS</h1>
      </div>
      <p className="text-sm text-gray-300">Background answers may identify respondents. They are separate from game results and are not sent to AI review or included in game exports.</p>
      {loading && <p role="status" className="text-gray-400">Loading background answers...</p>}
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950 p-4 space-y-3">
          <p role="alert" className="text-red-200">{error}</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)} className="rounded-lg bg-gray-700 px-4 py-2 font-bold hover:bg-gray-600">Retry</button>
        </div>
      )}
      {!loading && data && (!data.questions.length ? (
        <section className="rounded-2xl border border-gray-700 bg-gray-800 p-6 space-y-3">
          <h2 className="font-bold">No background questions configured</h2>
          <p className="text-sm text-gray-400">This survey does not collect background information.</p>
          <Link href={`/admin/surveys/${id}`} className="inline-block text-blue-400 hover:text-blue-300">Manage background questions in survey details</Link>
        </section>
      ) : (
        <>
          <section aria-labelledby="background-summary" className="space-y-4">
            <h2 id="background-summary" className="text-lg font-bold">Summary across {data.totalResponses} responses</h2>
            <p className="text-sm text-gray-400">Checkbox questions allow multiple choices, so choice counts may exceed the number of respondents. Older responses may predate these questions and appear as Not answered.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {data.questions.map(question => (
                <article key={question.id} className="min-w-0 rounded-2xl border border-gray-700 bg-gray-800 p-5 space-y-3">
                  <h3 className="font-bold [overflow-wrap:anywhere]">{question.label}</h3>
                  <p className="text-sm text-gray-400">{question.answeredCount} answered / {data.totalResponses} responses{question.required ? ' - Currently required' : ' - Optional'}</p>
                  {question.type === 'TEXT' ? <p className="text-sm text-gray-400">Textbox answers are shown in the response cards below.</p> : (
                    <dl className="space-y-2">
                      {question.choices.map(choice => (
                        <div key={choice.value} className="flex justify-between gap-4 text-sm">
                          <dt className="min-w-0 [overflow-wrap:anywhere]">{choice.value}</dt>
                          <dd className="shrink-0 font-bold text-blue-300">{choice.count}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </article>
              ))}
            </div>
          </section>
          <section aria-labelledby="background-responses" className="space-y-4">
            <h2 id="background-responses" className="text-lg font-bold">Individual Responses</h2>
            {!data.responses.length && <p className="text-gray-400">No responses to show.</p>}
            {data.responses.map((response, index) => (
              <article key={response.id} className="rounded-2xl border border-gray-700 bg-gray-800 p-5 space-y-4">
                <h3 className="font-bold">Response {(data.page - 1) * data.pageSize + index + 1}</h3>
                <details className="text-sm text-gray-400">
                  <summary className="cursor-pointer">Response metadata</summary>
                  <p className="mt-2 [overflow-wrap:anywhere]">ID: {response.id}</p>
                  <p>Submitted: <time dateTime={response.submittedAt}>{new Date(response.submittedAt).toLocaleString()}</time></p>
                </details>
                <dl className="space-y-4">
                  {data.questions.map(question => {
                    const values = response.answers.find(answer => answer.questionId === question.id)?.values.filter(value => value.trim()) ?? [];
                    return (
                      <div key={question.id} className="min-w-0">
                        <dt className="text-sm font-bold text-gray-400 [overflow-wrap:anywhere]">{question.label}</dt>
                        <dd className="mt-1">
                          {values.length ? (
                            <ul className="space-y-1">
                              {values.map((value, i) => <li key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</li>)}
                            </ul>
                          ) : <span className="text-gray-500">Not answered</span>}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </article>
            ))}
            {data.pageCount > 1 && (
              <nav aria-label="Background responses pagination" className="flex flex-wrap items-center justify-between gap-3">
                <button type="button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}
                  className="rounded-xl bg-gray-700 px-4 py-2 font-bold hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed">Previous</button>
                <p className="text-sm text-gray-400">Page {data.page} of {data.pageCount}</p>
                <button type="button" disabled={data.page >= data.pageCount} onClick={() => setPage(data.page + 1)}
                  className="rounded-xl bg-gray-700 px-4 py-2 font-bold hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
              </nav>
            )}
          </section>
        </>
      ))}
    </div>
  );
}
