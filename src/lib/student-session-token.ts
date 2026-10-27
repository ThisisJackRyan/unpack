import { createHash, randomBytes } from "node:crypto";

// The student session token and cookie settings, without next/headers, so
// tests and scripts can use them. student-session.ts reads and writes the
// cookie.
//
// Students are identified by a random session token. Only its SHA-256
// hash is stored (students.session_token_hash); the raw token lives only in
// the httpOnly cookie, so a database leak can't be replayed as a session.

export const STUDENT_SESSION_COOKIE = "unpack_student_session";

// About a school year plus a margin. Progress is tied to the browser
// session and does not carry over by name, so a short expiry would make
// students lose their work mid-year.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function studentSessionCookieOptions(production: boolean) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
