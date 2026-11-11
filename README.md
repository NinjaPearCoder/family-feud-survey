# Feud Survey

Survey collection and game-result export using Next.js 16, React 19, Prisma, and SQLite.

## Local preview

Use Node.js 24 LTS. Install dependencies with `npm ci`.

The gitignored `.env` supplies Prisma CLI and the app with a local database URL:

```dotenv
DATABASE_URL="file:./dev.db"
```

The gitignored `.env.local` supplies `ADMIN_PASSWORD`, `SESSION_SECRET`, and AI settings,
as documented in `.env.local.example`. Use a unique password of at least 12 characters
and a randomly generated session secret of at least 32 bytes. Missing credentials and
example/default values disable authentication rather than enabling a fallback login.

Keep `AI_ENABLED="false"` and `ANTHROPIC_API_KEY=""` for a local preview without external
AI calls. The existing AI action reports that it is disabled. No real API key is needed
to create surveys or collect responses.

```powershell
npm run db:generate
npx prisma migrate deploy
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000/login`. Stop the server with Ctrl+C. Binding to loopback keeps
this preview off the LAN; its QR codes will not work from another device.

On a managed Windows machine where Node does not automatically trust the organization's
certificate chain, set `$env:NODE_USE_SYSTEM_CA = '1'` before npm/Prisma/Next commands.
Do not disable TLS verification. Optionally set `$env:NEXT_TELEMETRY_DISABLED = '1'`.

## Survey lifecycle

### LivIT collection sets

`surveys/livit.json` contains five sets of ten questions supplied for the LivIT collection.
With the app running, `npm run survey:import-livit` creates missing sets as drafts targeting
LivIT. Repeating the import preserves matching surveys and their responses; conflicting
existing titles are reported rather than overwritten. Review and explicitly open drafts
before distributing links. No background questions are added automatically.

For an authorized remote deployment, set `SURVEY_IMPORT_URL` to its HTTPS origin and provide
that deployment's `ADMIN_PASSWORD`. The catalog and importer are included in the Docker image.
Importing is an explicit operation, not a startup side effect. Git pushes do not transfer the
local SQLite database. `--replace-local-samples` deletes only the two named preview samples
and is permitted only when importing into loopback; back up the preview database first.

### Collection states

- New surveys start as **Draft**. Open them explicitly to collect responses.
- **Open** surveys accept new submissions. Closing immediately stops collection.
- **Closed** surveys can reopen or be archived.
- **Archived** surveys are read-only and unavailable to respondents. Restore to Closed
  before editing or reopening. A draft can also be archived without collecting data.
- Metadata includes title, description, source, audience, creation time, first opening,
  current closing, and archival time. Actual first/latest response dates are shown separately.
- Reopening preserves a known first-opening date and clears the current closing date.
  Historical opening dates that were never recorded remain unknown.
- The dashboard filters by status and audience. Collection status is not game readiness;
  approved publication snapshots are a separate upcoming feature.

`POST /api/surveys/:id/status` takes `{ "status": "CLOSED", "expectedStatus": "OPEN" }`.
Transitions are explicit and reject stale or invalid changes. The old `/lock` toggle is
replaced by this endpoint. Survey URLs and public tokens do not change with status.

## Background questions

Admins may add an optional Background Questions section when creating or editing a survey.
Each field has a label, input type (radio buttons, checkboxes, dropdown, or textbox), choices
where applicable, and its own Required toggle (off by default). The limits are 20 fields per
survey, 50 choices per choice field, 300 characters per label, and 2,000 characters per text answer.

With background fields configured, the public survey starts with a separate About you page,
followed by the normal five-question game pages. A 13-question survey therefore has four pages
with background fields and three without. Required fields must be completed before continuing
and are validated again by the server; a required checkbox group needs at least one choice.
Game questions remain optional, with at least one game answer needed for a final submission.

Background values are included in local draft recovery and the single retry-safe submission.
They are stored separately from game answers and are never sent to AI review or included in
game JSON exports. **Background answers** in the admin detail page opens an authenticated report
with choice counts and paginated individual responses. Older responses may predate these fields.
Age range, work area, or combinations of fields may identify people; collect only what is needed.

Answered fields cannot be deleted or have their label, type, or choices changed. Requiredness
and order can change for future submissions without changing existing responses. Unanswered
definition changes get new field IDs. Versioned configuration changes cause stale forms to
refresh before recording new responses, while already accepted retries still confirm safely.

API configuration uses `backgroundQuestions` and `backgroundVersion`; submissions use
`backgroundAnswers: [{ questionId, values: string[] }]`. Admin reporting is available at
`GET /api/surveys/:id/background-results?page=1&pageSize=25` (maximum page size 100).

## Reliable submissions

Surveys show five questions per page with Back/Next navigation and an overall answer count.
Questions are optional. Only the final page has Submit; navigation sends no responses.
Editable answers and page position are saved separately in per-survey session storage and
recovered on refresh. Deleted/replaced question IDs are removed from the recovered draft.
The frozen pending submission always takes precedence until its outcome is confirmed.

The public POST requires a UUID `submissionId`, a `respondentToken`, and one nonempty
answer per question. A database constraint prevents duplicate answer rows within a response.
The `(surveyId, submissionId)` pair identifies a submission attempt, not a person.

The browser saves the pending payload in per-survey session storage before sending. A failed
or uncertain request keeps the exact payload and key for explicit retry, including after a
page reload. An identical retry acknowledges the existing response, even after closing or
archiving, without inserting more data. Reusing the key with different answers is rejected.
Successful confirmation clears pending data. Storage failures are disclosed; in-memory
recovery still works while the tab remains open. This is not a one-person-one-vote system.

## Editing safeguards

- Metadata edits and no-op saves preserve question IDs, responses, answers, and results.
- Answered or tabulated questions cannot be rewritten or deleted. Add a new question instead.
- Unanswered questions can be added, removed, or rewritten. Rewriting gives a question a new
  ID so an already-open form cannot attach an old answer to the new wording.
- A form containing stale question IDs is rejected without partially saving responses.
- Survey updates are transactional: a failed write rolls back all changes in that save.
- Every administrative API handler authenticates independently of the Next.js proxy.
- Sessions issued before the authentication upgrade require a fresh login. The password
  itself has not changed. Logout clears the cookie even if the session is invalid.

## Verification

```powershell
npm test
npm run typecheck
npm run build
npm audit
```

Tests exercise handlers directly (without relying on the proxy), authentication failure
modes, preserved data, rejected edits, stale submissions, and rollback after a forced
database failure. They migrate a uniquely named temporary SQLite database and remove it
afterwards; they do not use `prisma/dev.db` or contact an AI provider.

Lifecycle tests also cover repeated/concurrent submissions, closure races, an AI result
arriving after archival, and migration of populated legacy databases.

## Question review

The Results screen provides advisory question assessments, flagged-answer details, grouped
answers, and current/stale snapshot indicators. No review marks a survey Ready or publishes
a game. Raw answers are retained, including flagged answers.

- **Review new answers** skips unchanged questions. If a question changes, its entire current
  answer set is reassessed so grouping remains coherent.
- **Reassess all** includes unchanged questions. Either action handles at most five questions
  per run; additional batches may be necessary. Attempts rotate so failures cannot block later questions.
- Counts come from validated per-answer assignments, not model-supplied totals. The AI must
  assign every input ID exactly once. Invalid, incomplete, or truncated results are rejected.
- Each review and its grouped counts are replaced transactionally. Provider failures, changed
  input, expired leases, and archival preserve the previous successful snapshot.
- A question is limited to 300 answers and 60,000 serialized input characters per review. An
  over-limit question reports an actionable error; answers are never silently truncated.
- Each provider call has a 60-second timeout and no automatic retries. HTTPS is required except
  for loopback testing, and redirects are rejected. Provider errors do not expose raw payloads.

Metrics are deliberately transparent, not statistical confidence claims:

| Metric | Meaning |
|---|---|
| Quality | Percentage of reviewed answers considered usable |
| Sample | Usable answers divided by the configured target, capped at 100% |
| Distribution | Top-eight coverage, penalized linearly when one answer exceeds 50% of usable answers |
| AI question score | The model's separate judgment of clarity and game suitability |
| Recommendation | Needs more responses, needs attention, or promising; never automatic game readiness |

Recommendation thresholds: below the response target means needs more responses. Otherwise,
usable quality below 80%, AI question score below 60, distribution below 50, fewer than two
groups, or any reported issue means needs attention. Remaining questions are promising.

### Provider and scheduling

Keep `AI_ENABLED=false` in local previews. To activate inference, configure an approved
provider and explicitly set it to `true`:

- `AI_PROVIDER=anthropic` uses `ANTHROPIC_API_KEY` and configurable `AI_MODEL` / `AI_BASE_URL`.
- `AI_PROVIDER=openai-compatible` uses `AI_API_KEY`, `AI_MODEL`, and the full API base in
  `AI_BASE_URL` (for example an approved HTTPS gateway ending in `/v1`). Compatibility still
  needs a live validation with the selected gateway/model.
- `REVIEW_TARGET_RESPONSES` defaults to 100 (1..300); `REVIEW_INTERVAL_MINUTES` defaults to 15.

For automation, generate a separate random `REVIEW_SCHEDULER_SECRET` of at least 32 characters;
it must not be the admin password or session secret. Either:

1. Schedule authenticated `POST /api/reviews/run` calls using `Authorization: Bearer <secret>`.
2. Run `npm run review:worker` as a separate supervised process with
   `REVIEW_WORKER_ENABLED=true`. It checks the local scheduler every 60 seconds by default,
   awaiting each request so it never overlaps its own calls. The server enforces the configured
   per-survey review interval and processes at most one due Open/Closed survey per request.

The worker is included in the Docker image at `scripts/review-worker.mjs`; run it with Node
under a process supervisor or as a separate worker deployment. `startup.sh` starts only the
web server, not the worker. `REVIEW_WORKER_URL` can point to an approved HTTPS scheduler if
the worker is separate; otherwise it uses loopback and `REVIEW_WORKER_PORT` / `PORT` (3000).
Configure hosting timeouts for bounded runs of up to five 60-second calls. A worker process
or scheduler must actually be running; merely setting a credential does not schedule work.

The admin page polls read-only review status every ten seconds. This does not run AI jobs.
Raw question/answer text is sent to the configured provider only when review is enabled;
audience metadata, respondent tokens, and credentials are not included in model prompts.

## Upgrading existing data

Back up SQLite consistently and stop the application before running migrations. The lifecycle
migration maps unlocked surveys to Open and locked surveys to Closed, preserving tokens,
questions, answers, response timestamps, and tabulations. Old responses retain NULL submission
IDs; no retroactive respondent deduplication is performed.

Before upgrading a legacy database, check for duplicate answer rows:

```sql
SELECT responseId, questionId, COUNT(*) AS answerCount
FROM Answer
GROUP BY responseId, questionId
HAVING COUNT(*) > 1;
```

If any exist, resolve them with the data owner before migration. The new uniqueness constraint
deliberately fails rather than deleting data silently. The migration is transactional; after
a failure, restore/verify the backup and follow Prisma's failed-migration recovery procedure
before retrying. Do not use `migrate reset` on a database containing responses to preserve.

## Remaining work

The immediate priority is collection launch for three surveys with roughly 200 invitees each.
Cross-survey question filtering and the game-pack builder are deferred until after the first
game; manual question selection/export assembly is acceptable for that event.
See [the launch plan and deferred backlog](doc/launch-plan.md).

This is not yet a production-hardening signoff. Rate limits,
game-ready publication, privacy/retention, and tested hosting/backup arrangements
remain separate work. Prisma 5 is retained in this batch; migrating to a supported newer
ORM release requires separate database/adapter and container validation. A clean npm
audit does not mean every dependency is under active maintenance.
