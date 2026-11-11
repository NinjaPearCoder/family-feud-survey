BEGIN TRANSACTION;

ALTER TABLE "Survey" ADD COLUMN "reviewLeaseId" TEXT;
ALTER TABLE "Survey" ADD COLUMN "reviewLeaseUntil" DATETIME;
ALTER TABLE "Survey" ADD COLUMN "lastReviewAttemptAt" DATETIME;
ALTER TABLE "Survey" ADD COLUMN "lastReviewError" TEXT;
ALTER TABLE "Question" ADD COLUMN "reviewAttemptedAt" DATETIME;

CREATE TABLE "QuestionReview" (
    "questionId" TEXT NOT NULL PRIMARY KEY,
    "inputHash" TEXT NOT NULL,
    "reviewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseCount" INTEGER NOT NULL,
    "validCount" INTEGER NOT NULL,
    "flaggedCount" INTEGER NOT NULL,
    "questionScore" REAL NOT NULL,
    "qualityScore" REAL NOT NULL,
    "sampleScore" REAL NOT NULL,
    "distributionScore" REAL NOT NULL,
    "topAnswerShare" REAL NOT NULL,
    "topEightShare" REAL NOT NULL,
    "groupCount" INTEGER NOT NULL,
    "recommendation" TEXT NOT NULL CHECK ("recommendation" IN ('NEEDS_MORE_RESPONSES', 'NEEDS_ATTENTION', 'PROMISING')),
    "summary" TEXT NOT NULL,
    "issuesJson" TEXT NOT NULL,
    "flagsJson" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    CONSTRAINT "QuestionReview_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

COMMIT;
