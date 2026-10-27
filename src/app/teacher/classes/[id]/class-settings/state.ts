// Shared by the class settings action and form. Kept out of actions.ts
// because a "use server" file may only export async functions.

export type ClassSettingsState = {
  errors?: { name?: string; gradeLevel?: string };
  // What the form shows after a result (the trimmed name, the grade).
  values?: { name: string; gradeLevel: string };
  // What happened, for the live region.
  message?: string;
  // A save that failed (nothing changed).
  error?: string;
};
