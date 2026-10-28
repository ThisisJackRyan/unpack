import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AGE_GATE_COOKIE,
  AGE_GATE_MAX_AGE_SECONDS,
  AGE_GATE_VALUE,
  AGE_SCREEN_ERROR,
  ageGateCookieOptions,
  birthYearOptions,
  checkAgeScreen,
  isAgeGated,
  MONTH_NAMES,
  YEAR_SPAN,
} from "./age-screen";

const at = (iso: string) => new Date(iso);
const check = (month: number | string, year: number | string, now: string) =>
  checkAgeScreen({ month: String(month), year: String(year) }, at(now));

describe("checkAgeScreen: 13+ only from the month after the 13th birthday month", () => {
  it("mid-year: the birthday month is under, the month after is old enough", () => {
    const now = "2026-10-15T12:00:00Z";
    assert.equal(check(9, 2013, now), "old_enough");
    assert.equal(check(10, 2013, now), "under"); // the current month: 13 only for part of it
    assert.equal(check(11, 2013, now), "under");
    assert.equal(check(10, 2012, now), "old_enough");
    assert.equal(check(1, 2014, now), "under");
  });

  it("on the first and the last day of the current month alike", () => {
    for (const now of ["2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z"]) {
      assert.equal(check(9, 2013, now), "old_enough", now);
      assert.equal(check(10, 2013, now), "under", now);
    }
    // Next month (UTC), the October 2013 birthdays are all 13.
    assert.equal(check(10, 2013, "2026-11-01T00:00:00Z"), "old_enough");
  });

  it("December and January across the year boundary", () => {
    // In January 2027, December 2013 is a full month past its 13th birthday month.
    assert.equal(check(12, 2013, "2027-01-01T00:00:00Z"), "old_enough");
    assert.equal(check(1, 2014, "2027-01-20T00:00:00Z"), "under");
    assert.equal(check(1, 2014, "2027-02-01T00:00:00Z"), "old_enough");
    // In December 2026, December 2013 is the birthday month itself.
    assert.equal(check(12, 2013, "2026-12-31T23:59:59Z"), "under");
    assert.equal(check(11, 2013, "2026-12-01T00:00:00Z"), "old_enough");
  });

  it("uses the UTC month, not the server's local one", () => {
    // 23:30 UTC on 31 October is already November in UTC+1, still October in UTC.
    assert.equal(check(10, 2013, "2026-10-31T23:30:00Z"), "under");
    assert.equal(check(10, 2013, "2026-11-01T00:30:00+01:00"), "under");
  });

  it("a blank, out-of-range, malformed or future answer is invalid", () => {
    const now = "2026-10-15T12:00:00Z";
    for (const [month, year] of [
      ["", ""],
      ["", "2000"],
      ["5", ""],
      ["0", "2000"],
      ["13", "2000"],
      ["5.5", "2000"],
      ["-1", "2000"],
      ["5", "1925"], // older than the range
      ["5", "2027"], // next year
      ["11", "2026"], // next month
      ["May", "2000"],
      ["5", "2000 "],
    ]) {
      assert.equal(check(month, year, now), "invalid", `${month}/${year}`);
    }
    assert.equal(checkAgeScreen({ month: null, year: null }, at(now)), "invalid");
    assert.equal(checkAgeScreen({ month: 5, year: 2000 }, at(now)), "invalid");
    // The edges of the range are fine.
    assert.equal(check(1, 1926, now), "old_enough");
    assert.equal(check(10, 2026, now), "under");
    assert.equal(check("05", "2000", now), "old_enough");
  });
});

describe("the year select", () => {
  it("runs from this year (UTC) back YEAR_SPAN years, newest first, so it gives no cutoff away", () => {
    const years = birthYearOptions(at("2026-10-15T12:00:00Z"));
    assert.equal(YEAR_SPAN, 100);
    assert.equal(years.length, 101);
    assert.equal(years[0], 2026);
    assert.equal(years.at(-1), 1926);
    assert.equal(birthYearOptions(at("2026-12-31T23:30:00Z"))[0], 2026);
  });

  it("names all twelve months", () => {
    assert.equal(MONTH_NAMES.length, 12);
    assert.equal(MONTH_NAMES[0], "January");
    assert.equal(MONTH_NAMES[11], "December");
  });

  it("has one generic error that says nothing about the cutoff", () => {
    assert.equal(AGE_SCREEN_ERROR, "Choose a month and a year.");
  });
});

describe("the age gate cookie", () => {
  it("is httpOnly, lax, 30 days, Secure in production, and holds no date or age", () => {
    assert.equal(AGE_GATE_COOKIE, "unpack_age_gate");
    assert.equal(AGE_GATE_VALUE, "under");
    assert.doesNotMatch(AGE_GATE_VALUE, /\d/);
    assert.equal(AGE_GATE_MAX_AGE_SECONDS, 30 * 24 * 60 * 60);
    assert.deepEqual(ageGateCookieOptions(true), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: AGE_GATE_MAX_AGE_SECONDS,
    });
    assert.equal(ageGateCookieOptions(false).secure, false);
  });

  it("only the exact value counts", () => {
    assert.equal(isAgeGated("under"), true);
    for (const v of [undefined, "", "Under", "over", "under "]) assert.equal(isAgeGated(v), false);
  });
});

describe("the month and year never leave the action", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("both actions set the cookie on an under-13 answer and check it on every send", () => {
    // /welcome's steps are in welcome-core.ts (the action passes the cookie in).
    assert.match(read("../app/welcome/actions.ts"), /ageGated: await readAgeGate\(\),\n\s+now: new Date\(\),\n\s+setAgeGate,/);
    const welcome = read("../app/welcome/welcome-core.ts");
    assert.match(welcome, /ageGated: deps\.ageGated/);
    assert.match(welcome, /await deps\.setAgeGate\(\);\n\s+const deleted = await deps\.deleteUnder13\(account\.clerkUserId\);/);
    const settings = read("../app/settings/actions.ts");
    assert.match(settings, /ageGated: await readAgeGate\(\)/);
    assert.match(settings, /if \(choice\.ageGate === "set"\) await setAgeGate\(\);/);
    for (const [path, source] of [["welcome-core.ts", welcome], ["settings/actions.ts", settings]]) {
      // Read only inside the parse call: never logged, kept, or returned.
      assert.equal(source.match(/BIRTH_(MONTH|YEAR)_FIELD/g)?.length, 4, path);
      assert.doesNotMatch(source, /(console\.[a-z]+|logError)\([^)]*birth/i, path);
      assert.doesNotMatch(source, /birthMonth:(?!\s*formData)|birthYear:(?!\s*formData)/, path);
    }
    assert.doesNotMatch(read("../app/welcome/actions.ts"), /BIRTH_|birth/i);
  });

  it("the cookie holds only the gate value", () => {
    const source = read("./age-gate.ts");
    assert.match(source, /store\.set\(AGE_GATE_COOKIE, AGE_GATE_VALUE, ageGateCookieOptions\(isProduction\(\)\)\)/);
    assert.equal(source.match(/store\.set\(/g)?.length, 1);
  });

  it("the role picker never stores the answer in the browser and names no cutoff", () => {
    const source = read("../components/role-picker.tsx");
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
    // On-screen words: no age number and no "older/younger/old enough".
    assert.doesNotMatch(source, /\b13\b|older|younger|old enough|cutoff/i);
    // No default selection: both selects start on the placeholder.
    assert.equal(source.match(/defaultValue=""/g)?.length, 2);
    assert.match(source, /<option value="" disabled>\s*Month\s*<\/option>/);
    assert.match(source, /<option value="" disabled>\s*Year\s*<\/option>/);
  });
});
