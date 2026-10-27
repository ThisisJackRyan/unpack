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
  // Per-student preview: a sample set, shown once and never saved.
  sample?: string[];
};
