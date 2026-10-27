import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACCOUNT_ROUTE_PATTERNS, AFTER_AUTH_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "./auth-routes";

// Every pattern is a plain prefix followed by "(.*)".
function isProtected(path: string): boolean {
  return ACCOUNT_ROUTE_PATTERNS.some((pattern) => {
    assert.ok(pattern.endsWith("(.*)"), pattern);
    return path.startsWith(pattern.slice(0, -"(.*)".length));
  });
}

test("the sign-in and sign-up pages stay public, including their sub-steps", () => {
  for (const path of [SIGN_IN_PATH, SIGN_UP_PATH, `${SIGN_IN_PATH}/factor-one`, `${SIGN_UP_PATH}/verify-email-address`]) {
    assert.equal(isProtected(path), false, path);
  }
});

test("account routes still need a session; landing and student routes don't", () => {
  for (const path of ["/teacher", "/learn/history", "/welcome", "/settings", AFTER_AUTH_PATH]) {
    assert.equal(isProtected(path), true, path);
  }
  for (const path of ["/", "/join", "/c", "/account-deleted", "/api/webhooks/clerk"]) {
    assert.equal(isProtected(path), false, path);
  }
});

test(".env.example names the in-app pages and /home as the fallback", () => {
  const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  assert.match(example, new RegExp(`^NEXT_PUBLIC_CLERK_SIGN_IN_URL=${SIGN_IN_PATH}$`, "m"));
  assert.match(example, new RegExp(`^NEXT_PUBLIC_CLERK_SIGN_UP_URL=${SIGN_UP_PATH}$`, "m"));
  assert.match(example, new RegExp(`^NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=${AFTER_AUTH_PATH}$`, "m"));
  assert.match(example, new RegExp(`^NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=${AFTER_AUTH_PATH}$`, "m"));
});

test("the landing page's Get started goes to sign-up and Sign in to sign-in", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /href=\{SIGN_UP_PATH\}[^>]*>\s*Get started/);
  assert.match(page, /href=\{SIGN_IN_PATH\}[^>]*>\s*Sign in/);
});
