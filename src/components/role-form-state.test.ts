import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { AGE_REQUIRED_MESSAGE } from "@/lib/account-role";
import { AGE_SCREEN_ERROR } from "@/lib/age-screen";
import { AGE_ERROR_ID, AGE_HINT_ID, ageAnswerMissing, ageNote, signOutTo } from "./role-form-state";

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

describe("the teacher pick with the age gate cookie (no role yet)", () => {
  it("/welcome shows only the class note: no role choices, no submit button", () => {
    const picker = readFileSync(new URL("./role-picker.tsx", import.meta.url), "utf8");
    assert.match(picker, /const onlyNote = Boolean\(leaving\) \|\| \(firstRun && gated\);/);
    assert.match(picker, /const gateShown = gated && \(role === "self_learner" \|\| onlyNote\);/);
    assert.match(picker, /\{!warning && !gateShown && \(/);
    const welcome = readFileSync(new URL("../app/welcome/page.tsx", import.meta.url), "utf8");
    assert.match(welcome, /ageGated=\{ageGated\}\n\s+birthYears=\{birthYearOptions\(new Date\(\)\)\}\n\s+firstRun\n/);
    // /settings (a role holder) never passes firstRun.
    const settings = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(settings, /firstRun/);
  });
});

// C6: "Choose a month and a year." showed before anything was picked (an
// old error came back with the age box). It shows only after a press.
describe("the age error only after a press", () => {
  const picker = () => readFileSync(new URL("./role-picker.tsx", import.meta.url), "utf8");

  it("is missing for reading for myself with a blank month or year", () => {
    for (const [month, year] of [[null, null], ["", ""], ["3", ""], ["", "2001"], ["3", null], [null, "2001"]]) {
      assert.equal(ageAnswerMissing({ role: "self_learner", month, year }), true, `${month} ${year}`);
    }
  });

  it("isn't missing with both picked, for a teacher, or with no role yet", () => {
    assert.equal(ageAnswerMissing({ role: "self_learner", month: "3", year: "2001" }), false);
    assert.equal(ageAnswerMissing({ role: "teacher", month: null, year: null }), false);
    assert.equal(ageAnswerMissing({ role: null, month: null, year: null }), false);
  });

  it("is the same words as the server's error", () => {
    assert.equal(AGE_SCREEN_ERROR, "Choose a month and a year.");
    assert.equal(AGE_REQUIRED_MESSAGE, AGE_SCREEN_ERROR);
  });

  it("the picker checks on send, before the switch warning, and stops the send", () => {
    const source = picker();
    const onSubmit = source.slice(source.indexOf("function onSubmit("), source.indexOf("function keepTeaching("));
    assert.match(
      onSubmit,
      /if \(askAge && !onlyNote\) \{[\s\S]*if \(ageAnswerMissing\(\{ role: data\.get\("role"\), month: data\.get\(BIRTH_MONTH_FIELD\), year: data\.get\(BIRTH_YEAR_FIELD\) \}\)\) \{\s*e\.preventDefault\(\);\s*setAgeMissing\(true\);\s*return;/,
    );
    assert.ok(onSubmit.indexOf("ageAnswerMissing") < onSubmit.indexOf("needsConfirm"));
  });

  it("starts with no error, and the error is only the press or the server's latest answer", () => {
    const source = picker();
    assert.match(source, /const \[ageMissing, setAgeMissing\] = useState\(false\);/);
    assert.match(source, /const ageError = ageMissing \? AGE_SCREEN_ERROR : ageErrorCleared \? undefined : errors\.age;/);
    // A new server answer starts fresh.
    assert.match(source, /setAgeErrorCleared\(false\);\n\s+setAgeMissing\(false\);\n\s+\}/);
  });

  it("picking a month, a year, or either role clears it", () => {
    const source = picker();
    assert.match(source, /function clearAgeError\(\) \{\s*setAgeErrorCleared\(true\);\s*setAgeMissing\(false\);\s*\}/);
    assert.equal(source.match(/onChange=\{clearAgeError\}/g)?.length, 2);
    assert.match(source, /onChange=\{\(e\) => \{\s*setRole\(e\.currentTarget\.value\);\s*clearAgeError\(\);\s*\}\}/);
  });

  it("keeps one polite live region for the error, mounted while empty", () => {
    const source = picker();
    assert.match(source, /<ErrorMessage id=\{AGE_ERROR_ID\}>\s*\{ageError\}\s*<\/ErrorMessage>/);
    assert.equal(source.match(/id=\{AGE_ERROR_ID\}/g)?.length, 1);
  });
});
