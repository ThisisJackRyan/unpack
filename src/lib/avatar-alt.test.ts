import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CLERK_AVATAR_SELECTOR, fixedAvatarAlt } from "./avatar-alt";

describe("Clerk's avatar alt fix", () => {
  it("empties an alt that starts with an apostrophe (no name)", () => {
    for (const alt of ["'s logo", "’s logo", " 's logo", "'s"]) assert.equal(fixedAvatarAlt(alt), "", alt);
  });

  it("leaves a named or empty alt alone", () => {
    for (const alt of ["Sam Lee's logo", "", null]) assert.equal(fixedAvatarAlt(alt), null, String(alt));
  });

  it("never leaves an alt starting with an apostrophe", () => {
    for (const alt of ["'s logo", "’s logo", "Sam's logo", ""]) {
      const result = fixedAvatarAlt(alt) ?? alt;
      assert.doesNotMatch(result, /^\s*['’]/, alt);
    }
  });

  it("targets Clerk's avatar images and is mounted once inside ClerkProvider", () => {
    assert.equal(CLERK_AVATAR_SELECTOR, "img.cl-avatarImage");
    const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
    assert.match(layout, /<ClerkProvider[\s\S]*<ClerkAvatarAlt \/>[\s\S]*<\/ClerkProvider>/);
    const component = readFileSync(new URL("../components/clerk-avatar-alt.tsx", import.meta.url), "utf8");
    assert.match(component, /^"use client";/);
    assert.match(component, /new MutationObserver/);
    assert.match(component, /observer\.disconnect\(\)/);
  });
});
