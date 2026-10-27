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
};
