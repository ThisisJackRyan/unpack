// Shared by the create-class action and form. Kept out of actions.ts because
// a "use server" file may only export async functions.

export const CLASS_NAME_MAX_LENGTH = 60;

export type CreateClassState = {
  errors?: { name?: string; gradeLevel?: string; form?: string };
  values?: { name: string; gradeLevel: string };
};
