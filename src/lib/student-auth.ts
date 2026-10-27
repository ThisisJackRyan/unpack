import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { findStudentBySessionToken, type StudentSession } from "./student-lookup";
import { getStudentSessionToken } from "./student-session";

// Server-only: the current student, from the session cookie (see
// student-lookup.ts).

export type { StudentSession } from "./student-lookup";

// Cached per request so a page and its metadata share one lookup.
export const getStudentSession = cache(async (): Promise<StudentSession | null> => {
  const token = await getStudentSessionToken();
  return token ? findStudentBySessionToken(token) : null;
});

// For student pages: no valid session means back to the join form.
export async function requireStudentSession(): Promise<StudentSession> {
  const session = await getStudentSession();
  if (!session) redirect("/join");
  return session;
}
