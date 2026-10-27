import "server-only";
import { cookies } from "next/headers";
import {
  STUDENT_SESSION_COOKIE,
  studentSessionCookieOptions,
} from "./student-session-token";

// Server-only: the student session cookie. The token and its hash are in
// student-session-token.ts; the student lookup is in student-auth.ts.

export {
  generateSessionToken,
  hashSessionToken,
  STUDENT_SESSION_COOKIE,
} from "./student-session-token";

export async function setStudentSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(
    STUDENT_SESSION_COOKIE,
    token,
    studentSessionCookieOptions(process.env.NODE_ENV === "production"),
  );
}

export async function getStudentSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(STUDENT_SESSION_COOKIE)?.value || undefined;
}

export async function clearStudentSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete({ name: STUDENT_SESSION_COOKIE, path: "/" });
}
