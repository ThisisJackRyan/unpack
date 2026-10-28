import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { clerkUserOrNull } from "./clerk-user";

// What Clerk's users.getUser (behind currentUser) throws for a user it has
// deleted: a ClerkAPIResponseError with status 404.
function clerkError(status: number) {
  return Object.assign(new Error("Not Found"), { name: "ClerkAPIResponseError", status });
}

describe("clerkUserOrNull", () => {
  it("a session left over from a deleted Clerk user is no user, not a crash", async () => {
    // The /welcome crash: after the under-13 delete, the account lookup
    // asked Clerk for the deleted user and the 404 took the page down.
    const user = await clerkUserOrNull(async () => {
      throw clerkError(404);
    });
    assert.equal(user, null);
  });

  it("passes a live user and a missing session through as they are", async () => {
    const live = { id: "user_live" };
    assert.equal(await clerkUserOrNull(async () => live), live);
    assert.equal(await clerkUserOrNull(async () => null), null);
  });

  it("any other error is still thrown", async () => {
    await assert.rejects(
      clerkUserOrNull(async () => {
        throw clerkError(500);
      }),
      { status: 500 },
    );
    await assert.rejects(
      clerkUserOrNull(async () => {
        throw new Error("network");
      }),
      { message: "network" },
    );
  });

  it("the account lookup (requireArea) loads the Clerk user through it", () => {
    const source = readFileSync(new URL("./account.ts", import.meta.url), "utf8");
    assert.match(source, /await clerkUserOrNull\(\(\) => currentUser\(\)\)/);
    assert.doesNotMatch(source, /= await currentUser\(\)/);
  });
});
