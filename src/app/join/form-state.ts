// Shared by the join action and form. Kept out of actions.ts because a
// "use server" file may only export async functions.

export { FIRST_NAME_MAX_LENGTH, LAST_INITIALS_MAX_LENGTH } from "@/lib/student-name";

export type JoinState = {
  errors?: { code?: string; firstName?: string; lastInitials?: string; form?: string };
  values?: { code: string; firstName: string; lastInitials: string };
};
