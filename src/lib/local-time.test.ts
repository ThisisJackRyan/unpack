import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateFromRow, formatNextFree, resolveTimeZone, retryAtSentence, withRetryAt, type RetryClock } from "./local-time";
import { formatNextFree as allowanceFormatNextFree, resolveTimeZone as allowanceResolveTimeZone } from "./self-allowance";

const NOW = new Date("2026-10-27T14:30:00Z"); // a Tuesday
const utc: RetryClock = { now: NOW, timeZone: "UTC", utcLabel: true };
const ny: RetryClock = { now: NOW, timeZone: "America/New_York", utcLabel: false };

describe("retryAtSentence", () => {
  it("says the clock time today, in the reader's zone", () => {
    const at = new Date("2026-10-27T14:40:00Z");
    assert.equal(retryAtSentence(at, ny), "You can try again at 10:40 AM.");
    assert.equal(retryAtSentence(at, { ...utc, utcLabel: false }), "You can try again at 2:40 PM.");
  });

  it("labels UTC when the zone is the fallback (no or unknown header)", () => {
    const { timeZone, fallback } = resolveTimeZone(null);
    const clock = { now: NOW, timeZone, utcLabel: fallback };
    assert.equal(retryAtSentence(new Date("2026-10-27T14:40:00Z"), clock), "You can try again at 2:40 PM UTC.");
  });

  it("says tomorrow or the weekday when it isn't today", () => {
    assert.equal(retryAtSentence(new Date("2026-10-28T09:00:00Z"), utc), "You can try again tomorrow at 9:00 AM UTC.");
    assert.equal(retryAtSentence(new Date("2026-10-30T09:00:00Z"), utc), "You can try again on Friday at 9:00 AM UTC.");
    // 2026-10-28 02:00 UTC is still Oct 27 in New York.
    assert.equal(retryAtSentence(new Date("2026-10-28T02:00:00Z"), ny), "You can try again at 10:00 PM.");
  });

  it("is relative under a minute, now once passed, and when the time isn't known", () => {
    assert.equal(retryAtSentence(new Date(NOW.getTime() + 30_000), utc), "You can try again in a minute.");
    assert.equal(retryAtSentence(new Date(NOW.getTime() + 60_000), utc), "You can try again at 2:31 PM UTC.");
    assert.equal(retryAtSentence(NOW, utc), "You can try again now.");
    assert.equal(retryAtSentence(new Date(NOW.getTime() - 5_000), utc), "You can try again now.");
    assert.equal(retryAtSentence(null, utc), "Try again in a few minutes.");
    assert.equal(retryAtSentence(new Date("2026-10-27T14:40:00Z"), null), "Try again in a few minutes.");
    assert.equal(retryAtSentence(new Date("nope"), utc), "Try again in a few minutes.");
  });

  it("joins a limiter's message and the sentence, with no em dashes", () => {
    const text = withRetryAt("Paused for a bit.", new Date("2026-10-27T14:40:00Z"), ny);
    assert.equal(text, "Paused for a bit. You can try again at 10:40 AM.");
    assert.equal(/—/.test(text), false);
  });

  it("is the same helper the weekly allowance uses (moved, not copied)", () => {
    assert.equal(allowanceFormatNextFree, formatNextFree);
    assert.equal(allowanceResolveTimeZone, resolveTimeZone);
  });
});

describe("dateFromRow", () => {
  it("reads a Date or a driver string, else null", () => {
    const d = new Date("2026-10-27T14:40:00Z");
    assert.deepEqual(dateFromRow(d), d);
    assert.deepEqual(dateFromRow("2026-10-27T14:40:00Z"), d);
    assert.equal(dateFromRow(null), null);
    assert.equal(dateFromRow(""), null);
    assert.equal(dateFromRow("nope"), null);
    assert.equal(dateFromRow(new Date("nope")), null);
  });
});
