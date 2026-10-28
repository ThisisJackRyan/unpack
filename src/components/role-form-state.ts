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
  // /welcome: the under-13 answer deleted the account. The form signs the
  // user out to this path (signOutTo below).
  signOutTo?: string;
};

// Clerk's signOut, then its redirect. If it throws (the account is
// already gone in Clerk, so the session may be too), go there anyway.
export async function signOutTo(
  path: string,
  signOut: (options: { redirectUrl: string }) => Promise<unknown>,
  navigate: (path: string) => void,
): Promise<void> {
  try {
    await signOut({ redirectUrl: path });
  } catch {
    navigate(path);
  }
}

// The age screen shows one note at a time: the neutral hint, or the red
// error in its place while the error is active. Both selects'
// aria-describedby point at whichever is shown. The error stays active
// until a month, a year, or a role is picked, or the form is sent again.
export const AGE_HINT_ID = "age-hint";
export const AGE_ERROR_ID = "age-error";

export function ageNote(activeError: string | undefined): { show: "hint" | "error"; describedBy: string } {
  return activeError
    ? { show: "error", describedBy: AGE_ERROR_ID }
    : { show: "hint", describedBy: AGE_HINT_ID };
}

// The age error shows only once the form is sent (Continue, or Save and
// Switch on /settings) with "reading for myself" and a blank month or year:
// the picker checks that here before sending, so it shows right away with
// no round trip, and the server checks again. Picking a month, a year, or
// the other role clears it, so switching back never shows an old error.
// Only blank or not; the answer itself is never kept.
export function ageAnswerMissing(form: { role: unknown; month: unknown; year: unknown }): boolean {
  return form.role === "self_learner" && (!form.month || !form.year);
}
