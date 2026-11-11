PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE "new_Survey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT,
    "audience" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "openedAt" DATETIME,
    "closedAt" DATETIME,
    "archivedAt" DATETIME,
    "token" TEXT NOT NULL
);

-- Historical opening dates were not recorded. Keep them unknown, not fabricated.
INSERT INTO "new_Survey" ("id", "title", "description", "source", "status", "createdAt", "updatedAt", "closedAt", "token")
SELECT "id", "title", "description", "source",
       CASE WHEN "lockedAt" IS NULL THEN 'OPEN' ELSE 'CLOSED' END,
       "createdAt", "updatedAt", "lockedAt", "token"
FROM "Survey";

DROP TABLE "Survey";
ALTER TABLE "new_Survey" RENAME TO "Survey";
CREATE UNIQUE INDEX "Survey_token_key" ON "Survey"("token");
CREATE INDEX "Survey_status_idx" ON "Survey"("status");

-- NULL is intentional for historical responses, which had no submission identity.
ALTER TABLE "Response" ADD COLUMN "submissionId" TEXT;
CREATE UNIQUE INDEX "Response_surveyId_submissionId_key" ON "Response"("surveyId", "submissionId");

-- Fail rather than silently discard legacy duplicate answers. Resolve them before retrying migration.
CREATE UNIQUE INDEX "Answer_responseId_questionId_key" ON "Answer"("responseId", "questionId");

COMMIT;
PRAGMA foreign_keys=ON;
