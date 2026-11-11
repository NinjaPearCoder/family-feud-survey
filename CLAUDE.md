# Feud Survey

A Next.js web app for collecting Family Feud survey responses, with AI-powered tabulation.

## What it does
- Admins create draft surveys with questions, audience, and other metadata, then explicitly open collection
- Admins can optionally add first-page background questions with radio/checkbox/dropdown/text inputs and per-field Required toggles
- A QR code is generated linking to the public survey form
- Respondents scan the QR code and answer questions anonymously
- Admin monitors response counts per question (targeting 100 per question)
- Optional AI review groups answers, flags junk without deleting it, and assesses question quality
- Results export as JSON matching the Family Feud Pi app format

## Stack
- **Next.js 16** with App Router, React 19, TypeScript, and `output: 'standalone'`
- **Prisma** ORM with **SQLite** (file-based, no separate DB server)
- **Tailwind CSS** for styling
- **Anthropic SDK** or an approved **OpenAI-compatible API** for configurable AI review
- **jose** for JWT session management
- **qrcode** for QR code generation

## Local development
```bash
# 1. Copy env file and fill in values
cp .env.local.example .env.local

# 2. Install deps
npm install

# 3. Create the local SQLite database and apply migrations
npm run db:migrate   # creates prisma/dev.db

# 4. Start dev server
npm run dev
```

The local SQLite file lives at `prisma/dev.db` (gitignored).

## Key routes
- `/admin` — survey dashboard (requires auth)
- `/admin/surveys/new` — create a survey
- `/admin/surveys/[id]` — edit survey, view QR code, open/close/archive/restore
- `/admin/surveys/[id]/results` — response counts, AI tabulation, export
- `/survey/[token]` — public survey form (no auth required)
- `/login` — admin login

## API routes
- `GET/POST /api/surveys` — list / create surveys
- `GET/PUT/DELETE /api/surveys/[id]` — get / update / delete a survey
- `POST /api/surveys/[id]/status` — explicitly transition collection status with an expected current state
- `POST /api/surveys/[id]/tabulate` — review up to five changed questions (`?force=true` to reassess)
- `GET /api/surveys/[id]/review` — admin review status, assessments, and grouped counts from one snapshot
- `GET /api/surveys/[id]/background-results` — admin-only background answer summaries and paginated responses, separate from AI/game results
- `POST /api/reviews/run` — one bounded scheduler batch, protected by a separate scheduler credential
- `GET /api/surveys/[id]/export` — download Family Feud JSON
- `GET/POST /api/submit/[token]` — public: get an open survey form / submit answers with a retry-safe submission ID

## Auth
Simple JWT cookie auth. Set `ADMIN_PASSWORD` in `.env.local`.
Session cookie (`admin-session`) is valid for 7 days.
Administrative API handlers verify the session independently of `src/proxy.ts`.
Missing/default credentials fail closed; see `README.md` for local setup and testing.

## Export format
Matches the format expected by the Family Feud Pi app:
```json
{
  "title": "Survey Title",
  "rounds": [
    {
      "question": "Name something in a kitchen",
      "answers": [
        { "text": "Refrigerator", "points": 45 },
        { "text": "Stove", "points": 22 }
      ]
    }
  ]
}
```
Points are scaled so the total across all answers ≈ 100.

## Production (Azure App Service with containers)

### How persistence works
Azure App Service Linux mounts `/home` as persistent Azure Files storage
(`WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` by default). The SQLite database
lives at `/home/data/feud.db` inside the container, so it survives restarts
and redeployments. On first start, `startup.sh` creates `/home/data/` and
runs `prisma migrate deploy` to initialise the schema.

### Environment variables (set in App Service Configuration)
| Variable | Value |
|---|---|
| `DATABASE_URL` | `file:/home/data/feud.db` |
| `ADMIN_PASSWORD` | your admin password |
| `SESSION_SECRET` | long random string |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `NEXT_PUBLIC_APP_URL` | `https://<your-app>.azurewebsites.net` |

### Build and deploy
```bash
# Build the image (targets linux/amd64 regardless of build machine)
docker build -t feud-survey .

# Or cross-platform from ARM (Raspberry Pi):
docker buildx build --platform linux/amd64 -t feud-survey .

# Tag and push to Azure Container Registry
docker tag feud-survey <acr-name>.azurecr.io/feud-survey:latest
docker push <acr-name>.azurecr.io/feud-survey:latest
```

Then configure your App Service to pull from the ACR image and set the
environment variables above.

### Single-instance note
SQLite does not support concurrent writes across multiple instances.
Keep the App Service scaled to **one instance** (the default).

---

## Doc Folder Rules

The `doc/` folder is managed by a two-AI workflow. Follow these rules exactly:

- `doc/memory.md` — **Append your notes here freely.** Add entries for decisions made, bugs found, approaches tried, or anything worth remembering. Always commit and push after appending.
- `doc/project.md` — **DO NOT edit.** This file is owned and maintained by Amos (Karl's Cowork AI). It will be overwritten during sync.
