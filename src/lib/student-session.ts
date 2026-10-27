import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

// Server-only: students are identified by a random session token. Only its
// SHA-256 hash is stored (students.session_token_hash); the raw token lives
// only in the httpOnly cookie.

export const STUDENT_SESSION_COOKIE = "unpack_student_session";

// About a school year plus a margin. Progress is tied to the browser
// session and does not carry over by name, so a short expiry would make
// students lose their work mid-year.
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function setStudentSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(STUDENT_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function getStudentSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(STUDENT_SESSION_COOKIE)?.value || undefined;
}

export async function clearStudentSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete({ name: STUDENT_SESSION_COOKIE, path: "/" });
}
