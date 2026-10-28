// Shared by the reading page's actions and forms. Kept out of actions.ts
// because a "use server" file may only export async functions.

export {
  ANSWER_FIELD_PREFIX,
  ANSWER_MAX_LENGTH,
  CHALLENGE_NOTE_MAX_LENGTH,
  MAX_TRIES,
} from "@/lib/validate-answers";

export { TIMED_OUT_STATE, type AnswerFormState } from "@/components/answer-form-state";

export type ChallengeFormState = { error?: string };
