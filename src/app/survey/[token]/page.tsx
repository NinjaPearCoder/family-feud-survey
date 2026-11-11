'use client';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { getQuestionPage, restoreDraft, type SurveyDraft } from '@/lib/pagination';
import { getBackgroundErrors, type BackgroundQuestion, type BackgroundAnswerInput } from '@/lib/background';
import styles from './survey-layout.module.css';

interface Question { id: string; text: string }
interface SurveyData { title: string; description?: string; questions: Question[]; backgroundVersion: number; backgroundQuestions: BackgroundQuestion[] }
interface Submission {
  submissionId: string;
  respondentToken: string;
  answers: { questionId: string; text: string }[];
  backgroundVersion?: number;
  backgroundAnswers?: BackgroundAnswerInput[];
}
interface Pending { payload: Submission; conflict: boolean }
type Status = 'loading' | 'open' | 'DRAFT' | 'CLOSED' | 'ARCHIVED' | 'unavailable' | 'missing' | 'error';

// Also retain unresolved submissions during client navigation when storage is blocked.
const pendingInMemory = new Map<string, Pending | null>();
const draftsInMemory = new Map<string, SurveyDraft | null>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPending(value: unknown): value is Pending {
  if (!value || typeof value !== 'object') return false;
  const { payload, conflict } = value as Pending;
  return typeof conflict === 'boolean' && !!payload &&
    typeof payload.submissionId === 'string' && uuidPattern.test(payload.submissionId) &&
    typeof payload.respondentToken === 'string' && !!payload.respondentToken.trim() &&
    Array.isArray(payload.answers) && payload.answers.length > 0 &&
    payload.answers.every(a => a && typeof a.questionId === 'string' && !!a.questionId &&
      typeof a.text === 'string' && !!a.text.trim()) &&
    new Set(payload.answers.map(a => a.questionId)).size === payload.answers.length &&
    ((payload.backgroundVersion === undefined && payload.backgroundAnswers === undefined) ||
      (typeof payload.backgroundVersion === 'number' && Number.isSafeInteger(payload.backgroundVersion) && payload.backgroundVersion >= 0 &&
      Array.isArray(payload.backgroundAnswers) &&
      payload.backgroundAnswers.every(a => a && typeof a.questionId === 'string' && !!a.questionId &&
        Array.isArray(a.values) && a.values.every(v => typeof v === 'string')) &&
      new Set(payload.backgroundAnswers.map(a => a.questionId)).size === payload.backgroundAnswers.length));
}

function unavailableStatus(status: unknown): Status {
  return status === 'DRAFT' || status === 'CLOSED' || status === 'ARCHIVED' ? status : 'unavailable';
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const RESPONDENT_KEY = 'feud-survey-respondent';
function getRespondentToken() {
  try {
    let t = localStorage.getItem(RESPONDENT_KEY);
    if (!t) { t = randomToken(); localStorage.setItem(RESPONDENT_KEY, t); }
    return t;
  } catch {
    return randomToken();
  }
}

export default function SurveyPage() {
  const { token } = useParams<{ token: string }>();
  return <RespondentSurvey key={token} token={token} />;
}

function RespondentSurvey({ token }: { token: string }) {
  const [survey,    setSurvey]    = useState<SurveyData | null>(null);
  const [answers,   setAnswers]   = useState<Record<string, string>>({});
  const [backgroundValues, setBackgroundValues] = useState<Record<string, string[]>>({});
  const [backgroundErrors, setBackgroundErrors] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [status,    setStatus]    = useState<Status>('loading');
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [restored, setRestored] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const sending = useRef(false);
  const active = useRef(false);
  const loadingRequest = useRef<AbortController | null>(null);
  const draft = useRef<SurveyDraft | null>(null);
  const draftLoaded = useRef(false);
  const questionSection = useRef<HTMLElement | null>(null);
  const focusPage = useRef(false);
  const focusBackgroundError = useRef(false);
  const backgroundErrorSummary = useRef<HTMLDivElement | null>(null);
  const storageKey = `feud-survey-pending:${token}`;
  const draftStorageKey = `feud-survey-draft:${token}`;
  const backgroundQuestions = survey?.backgroundQuestions ?? [];
  const hasBackground = backgroundQuestions.length > 0;

  useEffect(() => {
    active.current = true;
    let saved = pendingInMemory.get(token) ?? null;
    if (pendingInMemory.has(token)) {
      try {
        if (saved) sessionStorage.setItem(storageKey, JSON.stringify(saved));
        else sessionStorage.removeItem(storageKey);
      } catch {
        setStorageFailed(true);
      }
    } else {
      let raw: string | null = null;
      try {
        raw = sessionStorage.getItem(storageKey);
      } catch {
        setStorageFailed(true);
      }
      if (raw !== null) {
        try {
          const value: unknown = JSON.parse(raw);
          if (!isPending(value)) throw new Error('Invalid pending submission');
          saved = value;
          pendingInMemory.set(token, saved);
        } catch {
          setRecoveryError('The saved submission cannot be recovered safely. No new response will be sent. Contact the survey organizer before clearing this tab\'s saved data.');
        }
      }
    }
    setPending(saved);
    if (saved) {
      const savedAnswers = Object.fromEntries(saved.payload.answers.map(a => [a.questionId, a.text]));
      setAnswers(savedAnswers);
      const savedBackground = Object.fromEntries((saved.payload.backgroundAnswers ?? []).map(a => [a.questionId, a.values]));
      setBackgroundValues(savedBackground);
      // Older pending submissions may not have a separate editable draft.
      draft.current = { answers: savedAnswers, page: 0, backgroundValues: savedBackground, backgroundVersion: saved.payload.backgroundVersion };
      draftLoaded.current = true;
    }
    setRestored(true);
    return () => { active.current = false; };
  }, [token, storageKey]);

  useEffect(() => {
    const controller = new AbortController();
    loadingRequest.current = controller;
    setStatus('loading');
    setDraftReady(false);
    setSurvey(null);
    fetch(`/api/submit/${encodeURIComponent(token)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (response.status === 403) { setStatus(unavailableStatus(data?.status)); return; }
        if (response.status === 404) { setStatus('missing'); return; }
        if (!response.ok || !data || typeof data.title !== 'string' || !Array.isArray(data.questions) ||
          !Number.isSafeInteger(data.backgroundVersion) || data.backgroundVersion < 0 || !Array.isArray(data.backgroundQuestions)) {
          setStatus('error'); return;
        }
        setSurvey(data);
        setStatus('open');
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [token, refresh]);

  useEffect(() => {
    if (!restored || !survey || pending || done || recoveryError) return;
    let value: unknown = draft.current;
    if (!draftLoaded.current) {
      if (draftsInMemory.has(token)) {
        value = draftsInMemory.get(token) ?? null;
      } else {
        let raw: string | null = null;
        try {
          raw = sessionStorage.getItem(draftStorageKey);
        } catch {
          setDraftStorageFailed(true);
        }
        if (raw !== null) {
          try {
            value = JSON.parse(raw);
            if (value === null) setDraftError('The saved draft is invalid. New edits will replace it.');
          }
          catch { setDraftError('The saved draft could not be read. New edits will replace it.'); }
        }
      }
      draftLoaded.current = true;
    }
    const recovered = restoreDraft(value, survey.questions, survey.backgroundQuestions, survey.backgroundVersion);
    if (value !== null && !recovered) setDraftError('The saved draft is invalid. New edits will replace it.');
    const next = recovered ?? { answers: {}, page: 0 };
    draft.current = next;
    setAnswers(next.answers);
    setBackgroundValues(next.backgroundValues ?? {});
    setPage(next.page);
    setDraftReady(true);
    // Reconcile only after reading storage and receiving the current question IDs.
    if (recovered) saveDraft(next);
  }, [restored, survey, pending, done, recoveryError, token, draftStorageKey]);

  useEffect(() => {
    if (!focusPage.current) return;
    focusPage.current = false;
    questionSection.current?.focus({ preventScroll: true });
    questionSection.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [page]);

  useEffect(() => {
    if (!focusBackgroundError.current || page !== 0 || pending || status !== 'open') return;
    const first = survey?.backgroundQuestions?.find(q => Object.hasOwn(backgroundErrors, q.id));
    const control = first ? document.getElementById(`background-${first.id}`) : backgroundErrorSummary.current;
    if (!control) return;
    focusBackgroundError.current = false;
    control.focus({ preventScroll: true });
    control.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [backgroundErrors, page, pending, status, survey, draftReady]);

  function currentDraft(nextAnswers = answers, nextPage = page, nextBackground = backgroundValues): SurveyDraft {
    return {
      answers: nextAnswers, page: nextPage,
      backgroundValues: nextBackground,
      backgroundVersion: survey?.backgroundVersion,
      backgroundTypes: Object.fromEntries(backgroundQuestions.map(q => [q.id, q.type])),
    };
  }

  function setBackgroundAnswer(questionId: string, values: string[]) {
    if (pending || sending.current || recoveryError) return;
    const next = { ...backgroundValues, [questionId]: values };
    setBackgroundValues(next);
    setBackgroundErrors(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== questionId)));
    saveDraft(currentDraft(answers, page, next));
    setDraftError('');
  }

  function validateBackground() {
    const errors = getBackgroundErrors(backgroundQuestions, backgroundValues);
    setBackgroundErrors(errors);
    if (!Object.keys(errors).length) return true;
    focusBackgroundError.current = true;
    setPage(0);
    saveDraft(currentDraft(answers, 0));
    return false;
  }

  function saveDraft(value: SurveyDraft | null) {
    draft.current = value;
    draftsInMemory.set(token, value);
    try {
      if (value) sessionStorage.setItem(draftStorageKey, JSON.stringify(value));
      else sessionStorage.removeItem(draftStorageKey);
      setDraftStorageFailed(false);
    } catch {
      setDraftStorageFailed(true);
    }
  }

  function savePending(value: Pending | null) {
    pendingInMemory.set(token, value);
    setPending(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }

  function setAnswer(questionId: string, text: string) {
    if (pending || sending.current || recoveryError) return;
    const next = { ...answers, [questionId]: text };
    setAnswers(next);
    saveDraft(currentDraft(next));
    setDraftError('');
  }

  function navigatePage(requestedPage: number) {
    if (!survey) return;
    const next = getQuestionPage(survey.questions, requestedPage, hasBackground).page;
    if (next === page) return;
    if (hasBackground && page === 0 && next > page && !pending && !sending.current && !recoveryError && !validateBackground()) return;
    focusPage.current = true;
    setPage(next);
    if (!pending && !sending.current && !recoveryError) {
      saveDraft(currentDraft(answers, next));
      setDraftError('');
    }
  }

  async function submit() {
    if (!restored || sending.current || done || recoveryError) return;
    let saved = pending;
    if (!saved) {
      if (status !== 'open' || !survey || !draftReady) return;
      const currentPage = getQuestionPage(survey.questions, page, hasBackground);
      if (currentPage.page !== currentPage.pageCount - 1) return;
      if (!validateBackground()) return;
      const filled = Array.from(new Set(survey.questions.map(q => q.id)))
        .map(questionId => ({ questionId, text: (answers[questionId] ?? '').trim() }))
        .filter(a => a.text);
      if (!filled.length) return;
      saveDraft(currentDraft());
      const backgroundAnswers = backgroundQuestions.map(q => ({
        questionId: q.id,
        values: (Object.hasOwn(backgroundValues, q.id) ? backgroundValues[q.id] : [])
          .map(v => q.type === 'TEXT' ? v.trim() : v).filter(v => v.trim()),
      })).filter(a => a.values.length);
      try {
        saved = { payload: { submissionId: crypto.randomUUID(), respondentToken: getRespondentToken(), answers: filled,
          backgroundVersion: survey.backgroundVersion, backgroundAnswers }, conflict: false };
      } catch {
        setSubmitError('This browser cannot create a secure submission ID. Use a supported browser over HTTPS. Nothing was sent.');
        return;
      }
    }
    // Persist before sending; retries never rebuild the payload from editable answers.
    savePending(saved);
    sending.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      const response = await fetch(`/api/submit/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(saved.payload),
      });
      const result = await response.json().catch(() => null);
      const message = typeof result?.error === 'string' ? result.error : '';
      // After navigation, leave confirmation to the next mount's explicit retry.
      if (!active.current || pendingInMemory.get(token)?.payload.submissionId !== saved.payload.submissionId) return;
      if (response.status === 403) {
        loadingRequest.current?.abort();
        setSurvey(null);
        setStatus(unavailableStatus(result?.status));
      }
      if (response.ok && result?.ok === true) {
        savePending(null);
        saveDraft(null);
        setDraftError('');
        setAnswers({});
        setBackgroundValues({});
        setDone(true);
      } else if (response.status === 409 && result?.code === 'IDEMPOTENCY_CONFLICT') {
        savePending({ ...saved, conflict: true });
        setSubmitError(message || 'This submission ID was already used for different answers.');
      } else if (!saved.conflict && (response.status === 400 || response.status === 403 ||
        (response.status === 409 && result?.code === 'STALE_QUESTIONS'))) {
        savePending(null);
        if (response.status === 403) {
          setSubmitError(message || 'No new responses are accepted. This submission was not recorded.');
        } else if (response.status === 409) {
          loadingRequest.current?.abort();
          setStatus('loading');
          setSurvey(null);
          setRefresh(n => n + 1);
          setSubmitError('The questions changed. This submission was not recorded. Review the refreshed questions and your remaining answers before submitting again.');
        } else if (result?.code === 'BACKGROUND_VALIDATION') {
          focusBackgroundError.current = true;
          const fieldErrors = result.fieldErrors;
          const errors = fieldErrors && typeof fieldErrors === 'object' && !Array.isArray(fieldErrors)
            ? Object.fromEntries(Object.entries(fieldErrors).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
            : {};
          setBackgroundErrors(Object.keys(errors).length ? errors : { _background: message || 'Review these fields before continuing.' });
          setPage(0);
          if (draft.current) saveDraft({ ...draft.current, page: 0 });
          setSubmitError(message || 'This submission was not recorded. Review your background answers before submitting again.');
        } else {
          setSubmitError(message || 'This submission was not recorded. Review your answers before submitting again.');
        }
      } else {
        setSubmitError(response.status === 503 && result?.code === 'RETRY'
          ? 'The survey is busy. Retry the saved submission using the same answers and submission ID.'
          : message || 'The result could not be confirmed. Retry the saved submission; do not start a new response.');
      }
    } catch {
      if (active.current) setSubmitError('The result could not be confirmed because the connection failed. Retry the saved submission; it may already have been recorded.');
    } finally {
      sending.current = false;
      if (active.current) setSubmitting(false);
    }
  }

  const answeredCount = survey ? survey.questions.filter(q => answers[q.id]?.trim()).length : 0;
  const pagination = getQuestionPage(survey?.questions ?? [], page, hasBackground);
  const isBackgroundPage = hasBackground && pagination.page === 0;

  const feedback = (
    <div className="space-y-4 text-left">
      {draftStorageFailed && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">{done
        ? 'Your response is confirmed, but the saved draft could not be removed from this tab. If it reappears after a reload, do not submit it as a new response.'
        : 'Draft session storage is unavailable. Your edits are retained in memory during navigation, but recovery after a reload is not guaranteed. Keep this tab open.'}</p>}
      {draftError && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">{draftError}</p>}
      {storageFailed && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">{done
        ? 'Your response is confirmed, but the saved session copy could not be removed. If it reappears after reloading, retrying that same submission will not create a duplicate.'
        : 'Session storage is unavailable. Retry recovery after a reload is not guaranteed. Keep this tab open until the result is confirmed; the exact submission is retained in memory.'}</p>}
      {recoveryError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">{recoveryError}</p>}
      {submitError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">{submitError}</p>}
      {pending && <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-3">
        <p role="status" className="text-blue-900">{pending.conflict
          ? 'A prior payload has already been accepted under this submission ID, but it does not match these saved answers. Do not submit with a new ID. Contact the survey organizer with the ID below to resolve this conflict; retrying will only resend this exact saved payload.'
          : 'Submission pending confirmation. Answers are locked. Retry sends the exact saved response, not a new response, even if the survey has since closed or been archived.'}</p>
        <p className="text-xs text-blue-900 break-all">Submission ID: {pending.payload.submissionId}</p>
        <button onClick={submit} disabled={submitting || !restored} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold py-3 rounded-xl">{submitting ? 'Confirming...' : 'Retry / Confirm Saved Submission'}</button>
      </div>}
    </div>
  );

  if (done) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-5xl mb-4">🎉</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Thanks!</h1>
          <p className="text-gray-500">Your responses have been recorded.</p>
          <div className="max-w-lg mt-4">{feedback}</div>
        </div>
      </div>
    );
  }

  if (!restored || status !== 'open' || !survey || (!pending && !draftReady && !recoveryError)) {
    const screens: Record<Status, [string, string]> = {
      loading: ['Loading Survey', 'Checking survey availability...'],
      open: ['Loading Survey', 'Checking survey availability...'],
      DRAFT: ['Survey Not Yet Open', 'This survey is not accepting responses yet. Please check back later.'],
      CLOSED: ['Survey Closed', 'This survey is no longer accepting new responses.'],
      ARCHIVED: ['Survey Archived', 'This survey is no longer available.'],
      unavailable: ['Survey Unavailable', 'This survey is not accepting new responses.'],
      missing: ['Survey Not Found', 'This survey link may be invalid.'],
      error: ['Unable to Load Survey', 'Survey availability could not be checked. Please try again.'],
    };
    const [title, description] = screens[restored ? status : 'loading'];
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center max-w-lg w-full space-y-4">
          <h1 className="text-2xl font-bold text-gray-800">{title}</h1>
          <p className="text-gray-500">{description}</p>
          {feedback}
          {status === 'error' && <button onClick={() => setRefresh(n => n + 1)} className="text-blue-700 underline">Retry Loading Survey</button>}
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.shell} flex flex-col bg-gray-50`}>
      {/* Header */}
      <header className={`${styles.header} shrink-0 bg-blue-700 text-white text-center`}>
        <h1 className={`${styles.title} font-bold [overflow-wrap:anywhere]`}>{survey.title}</h1>
        {survey.description && <p className={`${styles.caption} text-blue-100 mt-1 [overflow-wrap:anywhere]`}>{survey.description}</p>}
        <p className={`${styles.caption} text-blue-100 mt-1`}>{hasBackground
          ? 'Background fields are marked Required or Optional. You may skip any game question.'
          : "Skip any question you're unsure about."}</p>
      </header>

      {/* Progress */}
      <div className={`${styles.progress} shrink-0 bg-white border-b border-gray-200 flex items-center gap-3`}>
        <div className="flex-1 bg-gray-200 rounded-full h-1.5">
          <div
            className="bg-blue-600 h-1.5 rounded-full transition-all"
            style={{ width: `${survey.questions.length ? (answeredCount / survey.questions.length) * 100 : 0}%` }}
          />
        </div>
        <span className={`${styles.caption} text-gray-500 font-medium flex-shrink-0`}>
          {answeredCount} / {survey.questions.length} answered
        </span>
      </div>

      {/* Questions */}
      <main className={`${styles.main} mx-auto flex-1 flex flex-col`}>
        {(draftStorageFailed || draftError || storageFailed || recoveryError || submitError || pending) && feedback}
        <section ref={questionSection} tabIndex={-1} aria-labelledby="question-page" className={`${styles.questions} scroll-mt-3 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}>
          <h2 id="question-page" aria-live="polite" aria-atomic="true" className={`${styles.pageNumber} font-semibold text-gray-600`}>
            Page {pagination.page + 1} of {pagination.pageCount}
            {isBackgroundPage && ' - About you'}
          </h2>
          {isBackgroundPage && <>
            <p className="text-sm text-gray-600">Background answers are visible to survey administrators and are excluded from the game and AI processing.</p>
            {Object.keys(backgroundErrors).length > 0 && <div ref={backgroundErrorSummary} tabIndex={-1} role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
              <p className="font-semibold">Please review your background answers.</p>
              {Object.entries(backgroundErrors).map(([id, message]) => <p key={id}>{backgroundQuestions.find(q => q.id === id)?.label ?? 'Background'}: {message}</p>)}
            </div>}
            <div className={styles.backgroundGrid}>
              {backgroundQuestions.map(q => {
                const values = Object.hasOwn(backgroundValues, q.id) ? backgroundValues[q.id] : [];
                const error = Object.hasOwn(backgroundErrors, q.id) ? backgroundErrors[q.id] : undefined;
                const controlId = `background-${q.id}`;
                const labelId = `${controlId}-label`;
                const errorId = `${controlId}-error`;
                return <fieldset key={q.id} disabled={!!pending || submitting || !!recoveryError} aria-describedby={error ? errorId : undefined} className={`${styles.backgroundCard} bg-white rounded-xl border border-gray-200`}>
                  <legend id={labelId} className="font-semibold text-gray-800">
                    {q.label} <span className="text-sm font-normal text-gray-600">({q.required ? 'Required' : 'Optional'})</span>
                  </legend>
                  {(q.type === 'RADIO' || q.type === 'CHECKBOX') && <>
                    {q.type === 'CHECKBOX' && <p className="text-sm text-gray-500">{q.required ? 'Select at least one.' : 'Select any that apply.'}</p>}
                    {q.options.map((option, index) => <label key={option} className={styles.backgroundChoice}>
                      <input
                        id={index === 0 ? controlId : `${controlId}-option-${index}`}
                        type={q.type === 'RADIO' ? 'radio' : 'checkbox'}
                        name={controlId}
                        value={option}
                        checked={values.includes(option)}
                        required={q.type === 'RADIO' && q.required}
                        aria-invalid={!!error}
                        aria-describedby={error ? errorId : undefined}
                        onChange={e => setBackgroundAnswer(q.id, q.type === 'RADIO' ? [option]
                          : e.target.checked ? [...values, option] : values.filter(v => v !== option))}
                      />
                      <span>{option}</span>
                    </label>)}
                    {q.type === 'RADIO' && !q.required && <button type="button" onClick={() => setBackgroundAnswer(q.id, [])} className={styles.clearSelection}>Clear selection</button>}
                  </>}
                  {q.type === 'SELECT' && <select id={controlId} aria-labelledby={labelId} required={q.required} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
                    value={values[0] ?? ''} onChange={e => setBackgroundAnswer(q.id, e.target.value ? [e.target.value] : [])}
                    className={`${styles.answer} w-full min-w-0 border border-gray-300 rounded-lg bg-white text-gray-800`}>
                    <option value="">Choose an option</option>
                    {q.options.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>}
                  {q.type === 'TEXT' && <input id={controlId} type="text" aria-labelledby={labelId} required={q.required} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
                    value={values[0] ?? ''} onChange={e => setBackgroundAnswer(q.id, [e.target.value])}
                    className={`${styles.answer} w-full border border-gray-300 rounded-lg text-gray-800 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100`} />}
                  {error && <p id={errorId} className="mt-2 text-sm text-red-700">{error}</p>}
                </fieldset>;
              })}
            </div>
          </>}
          {pagination.questions.map((q, i) => (
            <div key={q.id} className={`${styles.card} bg-white rounded-xl border border-gray-200`}>
              <div className={`${styles.question} flex`}>
                <span aria-hidden="true" className="shrink-0 font-semibold text-blue-600 tabular-nums">{pagination.start + i + 1}.</span>
                <label htmlFor={`answer-${q.id}`} className="min-w-0 text-gray-800 font-semibold [overflow-wrap:anywhere]">{q.text}</label>
              </div>
              <input
                id={`answer-${q.id}`}
                type="text"
                disabled={!!pending || submitting || !!recoveryError}
                value={answers[q.id] ?? ''}
                onChange={e => setAnswer(q.id, e.target.value)}
                placeholder="Your answer…"
                className={`${styles.answer} w-full border border-gray-300 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100`}
              />
            </div>
          ))}
        </section>

        <div className={`${styles.actions} mt-auto`}>
          <nav aria-label="Question pages" className={`${styles.navigation} flex`}>
            {pagination.pageCount > 1 && <button type="button" onClick={() => navigatePage(page - 1)} disabled={pagination.page === 0} className="flex-1 border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 text-gray-700 font-semibold rounded-xl">Back</button>}
            {pagination.page < pagination.pageCount - 1 && <button type="button" onClick={() => navigatePage(page + 1)} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl">Next</button>}
            {!pending && pagination.page === pagination.pageCount - 1 && <button
              type="button"
              onClick={submit}
              disabled={submitting || answeredCount === 0 || !!recoveryError}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold rounded-xl transition-colors"
            >
              {submitting ? 'Submitting…' : `Submit ${answeredCount > 0 ? `(${answeredCount} answer${answeredCount !== 1 ? 's' : ''})` : ''}`}
            </button>}
          </nav>
          <footer className={`${styles.footer} text-center text-gray-500`}>
            {!pending && !recoveryError && !draftStorageFailed && <p>Drafts stay in this tab until you submit.</p>}
            <p>Responses are used for a Family Feud game.</p>
          </footer>
        </div>
      </main>
    </div>
  );
}
