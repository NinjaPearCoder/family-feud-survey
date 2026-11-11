BEGIN TRANSACTION;

ALTER TABLE "Survey" ADD COLUMN "backgroundVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "BackgroundQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surveyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('RADIO', 'CHECKBOX', 'SELECT', 'TEXT')),
    "required" BOOLEAN NOT NULL DEFAULT false,
    "optionsJson" TEXT NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "BackgroundQuestion_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "BackgroundAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "valuesJson" TEXT NOT NULL,
    CONSTRAINT "BackgroundAnswer_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "Response" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BackgroundAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "BackgroundQuestion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BackgroundQuestion_surveyId_idx" ON "BackgroundQuestion"("surveyId");
CREATE UNIQUE INDEX "BackgroundAnswer_responseId_questionId_key" ON "BackgroundAnswer"("responseId", "questionId");
CREATE INDEX "BackgroundAnswer_questionId_idx" ON "BackgroundAnswer"("questionId");

COMMIT;
