// Shared by the join code actions and panel. Kept out of actions.ts
// because a "use server" file may only export async functions.

export type JoinCodeState = {
  // What happened, for the live region.
  message?: string;
  // A save that failed (nothing changed).
  error?: string;
};
