import type { AnswerFormState } from "./answer-form-state";
import { AnswerForm } from "./answer-form";
import type { AnswerStage } from "@/lib/reading-progress";
import type { StudentQuestion } from "@/lib/student-questions-core";

type Props = {
  action: (state: AnswerFormState, formData: FormData) => Promise<AnswerFormState>;
  readingId: string;
  // The student id (class) or account id (self-learner): whose drafts.
  ownerId: string;
  questions: StudentQuestion[];
  stage: Extract<AnswerStage, { kind: "answer" }>;
  // Only the QA route (src/app/qa) passes one; see AnswerForm.
  checkTimeoutMs?: number;
};

// The answer form exactly as each reading page renders it, so the QA route
// (scripts/browser-check-answer-timeout.ts) drives the same thing as
// /c/r/[readingId] and /learn/r/[readingId], with only the action swapped.

// A class student: their teacher may have given one extra try.
export function ClassAnswerForm({ action, readingId, ownerId, questions, stage, checkTimeoutMs }: Props) {
  return (
    <AnswerForm
      action={action}
      questions={questions}
      tryNumber={stage.tryNumber}
      maxTries={stage.maxTries}
      previous={stage.previous}
      extraTry={stage.extraTry}
      drafts={{ mode: "class", readingId, ownerId }}
      checkTimeoutMs={checkTimeoutMs}
    />
  );
}

// A self-learner: no teacher, so never an extra try.
export function SelfAnswerForm({ action, readingId, ownerId, questions, stage, checkTimeoutMs }: Props) {
  return (
    <AnswerForm
      action={action}
      questions={questions}
      tryNumber={stage.tryNumber}
      maxTries={stage.maxTries}
      previous={stage.previous}
      extraTry={false}
      drafts={{ mode: "self", readingId, ownerId }}
      checkTimeoutMs={checkTimeoutMs}
    />
  );
}
