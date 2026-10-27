// The role picker's state, shared by the /welcome and /settings actions.
// Kept out of the actions because a "use server" file may only export
// async functions.

import type { RoleChoiceErrors } from "@/lib/account-role";

export type RoleFormState = {
  errors?: RoleChoiceErrors & { form?: string };
  // What was chosen, kept after an error.
  role?: string;
  // /settings: "ask" when a teacher's switch to self-learner came without
  // the confirm (show the warning); "confirmed" when it came with it but
  // something else stopped the save (don't ask again).
  switchConfirm?: "ask" | "confirmed";
  // Self-learner was refused by the age screen (now, or the cookie from
  // before): show the class note in place of the screen.
  ageGate?: true;
};

// The age screen shows one note at a time: the neutral hint, or the red
// error in its place while the error is active. Both selects'
// aria-describedby point at whichever is shown. The error stays active
// until a month or year is picked or the form is sent again.
export const AGE_HINT_ID = "age-hint";
export const AGE_ERROR_ID = "age-error";

export function ageNote(activeError: string | undefined): { show: "hint" | "error"; describedBy: string } {
  return activeError
    ? { show: "error", describedBy: AGE_ERROR_ID }
    : { show: "hint", describedBy: AGE_HINT_ID };
}
