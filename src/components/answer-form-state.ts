// The answer form's state, shared by the student and self-learner reading
// pages' actions. Kept out of the actions because a "use server" file may
// only export async functions.

// After a saved check the page re-renders from the database (the new
// try's results and nudges), so a saved check returns an empty state.
export type AnswerFormState = {
  // By question id.
  errors?: Record<string, string>;
  message?: string;
};
