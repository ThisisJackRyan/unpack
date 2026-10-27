// Shared by the row actions and their buttons. Kept out of actions.ts because
// a "use server" file may only export async functions.

export type DeleteStudentState = {
  deleted?: boolean;
  // Nothing was deleted; the dialog stays open with this.
  error?: string;
};

export type ResetTriesState = {
  reset?: boolean;
  // Nothing changed; shown next to the button.
  error?: string;
};
