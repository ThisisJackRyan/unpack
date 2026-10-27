// Shared by the delete action and dialog. Kept out of actions.ts because
// a "use server" file may only export async functions.

export type DeleteStudentState = {
  deleted?: boolean;
  // Nothing was deleted; the dialog stays open with this.
  error?: string;
};
