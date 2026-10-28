// Shared by the question actions and panel. Kept out of the actions file
// because a "use server" file may only export async functions.
import { QUESTION_MAX_LENGTH } from "@/lib/ai/prompts";

export { QUESTION_MAX_LENGTH };

export const QUESTION_INTENTS = [
  "generate",
  "regenerate_all",
  "regenerate_one",
  "update",
  "delete",
  "publish",
  "sample",
] as const;

export type QuestionIntent = (typeof QUESTION_INTENTS)[number];

export function isQuestionIntent(value: unknown): value is QuestionIntent {
  return (
    typeof value === "string" &&
    (QUESTION_INTENTS as readonly string[]).includes(value)
  );
}

export type QuestionActionState = {
  intent?: QuestionIntent;
  // The card an error or success belongs to.
  questionId?: string;
  ok?: boolean;
  // For the live region: what just happened, or what went wrong.
  status?: string;
  error?: string;
  // At the question writing limit: an amber note with the retry time (not
  // an error).
  limit?: string;
  // Per-student preview: a sample set, shown once and never saved.
  sample?: string[];
};

// "Create & generate" lands on the reading page with ?generate=1, and the
// panel then runs the "generate" intent once, through the same action as
// the Generate button. Only for a shared draft that has no questions yet;
// anything else ignores the flag (the action refuses a second set anyway).
export const GENERATE_FLAG = "generate";

export function shouldAutoGenerate(input: {
  flag: string | string[] | undefined;
  status: "draft" | "published";
  mode: "shared" | "per_student";
  questionCount: number;
}): boolean {
  return input.flag === "1" && input.status === "draft" && input.mode === "shared" && input.questionCount === 0;
}
