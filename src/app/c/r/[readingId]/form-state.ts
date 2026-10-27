// Shared by the reading page's actions and forms. Kept out of actions.ts
// because a "use server" file may only export async functions.

export {
  ANSWER_FIELD_PREFIX,
  ANSWER_MAX_LENGTH,
  CHALLENGE_NOTE_MAX_LENGTH,
  MAX_TRIES,
} from "@/lib/validate-answers";

// After a saved check the page re-renders from the database (the new
// try's results and nudges), so a saved check returns an empty state.
export type AnswerFormState = {
  // By question id.
  errors?: Record<string, string>;
  message?: string;
};

export type ChallengeFormState = { error?: string };
