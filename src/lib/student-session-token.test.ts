import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_MAX_AGE_SECONDS,
  STUDENT_SESSION_COOKIE,
  studentSessionCookieOptions,
} from "./student-session-token";

describe("student session token", () => {
  it("is long, random, and url-safe", () => {
    const a = generateSessionToken();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, generateSessionToken());
  });

  it("hashes deterministically to SHA-256 hex, not the token", () => {
    const token = generateSessionToken();
    assert.equal(hashSessionToken(token), hashSessionToken(token));
    assert.equal(hashSessionToken(token), createHash("sha256").update(token).digest("hex"));
    assert.notEqual(hashSessionToken(token), token);
  });
});

describe("studentSessionCookieOptions", () => {
  it("is an httpOnly, 180-day, site-wide cookie, secure in production", () => {
    assert.equal(STUDENT_SESSION_COOKIE, "unpack_student_session");
    assert.equal(SESSION_MAX_AGE_SECONDS, 180 * 24 * 60 * 60);
    assert.deepEqual(studentSessionCookieOptions(true), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    assert.equal(studentSessionCookieOptions(false).secure, false);
  });
});
