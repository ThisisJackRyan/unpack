import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { AGE_REQUIRED_MESSAGE } from "@/lib/account-role";
import { AGE_ERROR_ID, AGE_HINT_ID, ageNote, signOutTo } from "./role-form-state";

describe("ageNote", () => {
  it("shows the hint, described by the hint, with no error", () => {
    assert.deepEqual(ageNote(undefined), { show: "hint", describedBy: AGE_HINT_ID });
    assert.deepEqual(ageNote(""), { show: "hint", describedBy: AGE_HINT_ID });
  });

  it("shows only the error, described by the error, while it is active", () => {
    assert.deepEqual(ageNote(AGE_REQUIRED_MESSAGE), { show: "error", describedBy: AGE_ERROR_ID });
  });

  it("never points aria-describedby at both", () => {
    for (const error of [undefined, AGE_REQUIRED_MESSAGE]) {
      assert.equal(ageNote(error).describedBy.split(" ").length, 1);
    }
  });

  it("the role picker renders the hint only when ageNote says so", () => {
    const source = readFileSync(new URL("./role-picker.tsx", import.meta.url), "utf8");
    assert.match(source, /age\.show === "hint" &&/);
    assert.match(source, /aria-describedby=\{age\.describedBy\}/);
    assert.doesNotMatch(source, /age-hint age-error/);
  });
});

describe("signOutTo", () => {
  it("signs out with Clerk's redirect to the path", async () => {
    const calls: unknown[] = [];
    const navigated: string[] = [];
    await signOutTo("/join", async (options) => calls.push(options), (path) => navigated.push(path));
    assert.deepEqual(calls, [{ redirectUrl: "/join" }]);
    assert.deepEqual(navigated, []);
  });

  it("goes to the path anyway when Clerk's sign-out throws", async () => {
    const navigated: string[] = [];
    await signOutTo(
      "/join",
      async () => {
        throw new Error("session gone");
      },
      (path) => navigated.push(path),
    );
    assert.deepEqual(navigated, ["/join"]);
  });

  it("the role picker signs out to state.signOutTo, and shows only the class note while it does", () => {
    const source = readFileSync(new URL("./role-picker.tsx", import.meta.url), "utf8");
    assert.match(source, /const leaving = state\.signOutTo;/);
    assert.match(source, /if \(leaving\) void signOutTo\(leaving, signOut, \(path\) => window\.location\.assign\(path\)\)/);
    assert.match(source, /\{!onlyNote && \(\n\s+<fieldset/);
  });
});
