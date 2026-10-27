import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AUTH_LOADING_COPY } from "./auth-loading-text";

describe("sign-in and sign-up loading state", () => {
  it("has friendly copy with a real ellipsis, curly apostrophes and no em dash", () => {
    assert.equal(AUTH_LOADING_COPY.signIn, "Getting sign-in ready\u2026");
    assert.equal(AUTH_LOADING_COPY.signUp, "Getting sign-up ready\u2026");
    for (const text of Object.values(AUTH_LOADING_COPY)) {
      assert.ok(!text.includes("'"), text);
      assert.ok(!text.includes("..."), text);
      assert.ok(!text.includes("\u2014"), text);
    }
  });

  it("is on both auth pages, next to Clerk's form", () => {
    for (const [path, kind] of [
      ["../app/sign-in/[[...sign-in]]/page.tsx", "signIn"],
      ["../app/sign-up/[[...sign-up]]/page.tsx", "signUp"],
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, new RegExp(`<AuthLoading kind="${kind}" />`), path);
    }
  });

  it("is a status region while loading, still under reduced motion", () => {
    const source = readFileSync(new URL("./auth-loading.tsx", import.meta.url), "utf8");
    assert.match(source, /<ClerkLoading>[\s\S]*role="status"/);
    assert.match(source, /<ClerkFailed>[\s\S]*role="alert"/);
    // Every animation is motion-safe only.
    for (const m of source.matchAll(/\banimate-[a-z-]+/g)) {
      const before = source.slice(Math.max(0, m.index - 12), m.index);
      assert.ok(before.endsWith("motion-safe:"), m[0]);
    }
  });
});
