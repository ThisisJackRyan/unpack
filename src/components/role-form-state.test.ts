import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { AGE_REQUIRED_MESSAGE } from "@/lib/account-role";
import { AGE_ERROR_ID, AGE_HINT_ID, ageNote } from "./role-form-state";

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

describe("the under-13 exit", () => {
  it("the role picker has no sign-out path: the action redirects to /join instead", () => {
    const source = readFileSync(new URL("./role-picker.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(source, /useClerk|signOut/);
    assert.match(source, /\{!onlyNote && \(\n\s+<fieldset/);
  });
});

describe("the teacher pick with the age gate cookie (no role yet)", () => {
  it("/welcome shows only the class note: no role choices, no submit button", () => {
    const picker = readFileSync(new URL("./role-picker.tsx", import.meta.url), "utf8");
    assert.match(picker, /const onlyNote = firstRun && gated;/);
    assert.match(picker, /const gateShown = gated && \(role === "self_learner" \|\| onlyNote\);/);
    assert.match(picker, /\{!warning && !gateShown && \(/);
    const welcome = readFileSync(new URL("../app/welcome/page.tsx", import.meta.url), "utf8");
    assert.match(welcome, /ageGated=\{ageGated\}\n\s+birthYears=\{birthYearOptions\(new Date\(\)\)\}\n\s+firstRun\n/);
    // /settings (a role holder) never passes firstRun.
    const settings = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(settings, /firstRun/);
  });
});
