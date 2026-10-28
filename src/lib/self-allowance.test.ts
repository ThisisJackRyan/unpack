import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowanceFor,
  allowanceFromCreations,
  allowanceFromRow,
  allowanceLimitMessage,
  allowanceRemainingLabel,
  allowanceState,
  countsAt,
  createOutcome,
  createOutcomeRedirect,
  createSelfReadingStatements,
  formatNextFree,
  nextFreeAt,
  resolveTimeZone,
  selfLearnerPlan,
  type SelfReadingDraft,
} from "./self-allowance";

const ID = "00000000-0000-4000-8000-000000000001";
const DAY = 24 * 60 * 60 * 1000;
const FREE = allowanceFor("free");
const DRAFT: SelfReadingDraft = {
  title: "The fox",
  bodyText: "Text ".repeat(50),
  sourceUrl: null,
  bodyTrimmed: false,
  gradeLevel: "5",
  questionCount: 3,
};

describe("allowanceFor", () => {
  it("free is 5 readings per rolling 7 days, and every self-learner is on free for now", () => {
    assert.deepEqual(FREE, { readings: 5, windowDays: 7 });
    assert.equal(selfLearnerPlan(), "free");
  });
});

describe("the rolling window", () => {
  const now = new Date("2026-10-27T15:00:00Z");

  it("counts a creation strictly inside 7 days; exactly 7 days old no longer counts", () => {
    assert.equal(countsAt(new Date(now.getTime() - 7 * DAY + 1), now, 7), true);
    assert.equal(countsAt(new Date(now.getTime() - 7 * DAY + 60_000), now, 7), true);
    assert.equal(countsAt(new Date(now.getTime() - 7 * DAY), now, 7), false);
    assert.equal(countsAt(new Date(now.getTime() - 7 * DAY - 1), now, 7), false);
    assert.equal(countsAt(now, now, 7), true);
  });

  it("frees the next slot 7 days after the oldest one in the window", () => {
    const oldest = new Date("2026-10-21T09:30:00Z");
    assert.equal(nextFreeAt(oldest, 7).toISOString(), "2026-10-28T09:30:00.000Z");
  });

  it("5 in the window: none left, next free from the oldest", () => {
    const creations = [1, 2, 3, 4, 5].map((d) => new Date(now.getTime() - d * DAY));
    const state = allowanceFromCreations(creations, now, FREE);
    assert.equal(state.used, 5);
    assert.equal(state.remaining, 0);
    assert.equal(state.nextFreeAt?.toISOString(), new Date(now.getTime() + 2 * DAY).toISOString());
  });

  it("a minute before the oldest turns 7 days it still blocks; just past, one frees up", () => {
    const oldestAge = 7 * DAY - 60_000;
    const creations = [oldestAge, 3 * DAY, 2 * DAY, DAY, 1000].map((age) => new Date(now.getTime() - age));
    const blocked = allowanceFromCreations(creations, now, FREE);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.nextFreeAt?.getTime(), now.getTime() + 60_000);
    const later = new Date(now.getTime() + 60_001);
    const freed = allowanceFromCreations(creations, later, FREE);
    assert.equal(freed.used, 4);
    assert.equal(freed.remaining, 1);
    assert.equal(freed.nextFreeAt, null);
  });

  it("under the allowance has no next free time", () => {
    assert.deepEqual(allowanceState(2, new Date(), FREE), { used: 2, remaining: 3, nextFreeAt: null });
    assert.deepEqual(allowanceState(0, null, FREE), { used: 0, remaining: 5, nextFreeAt: null });
  });

  it("reads the window row (Date or string)", () => {
    const state = allowanceFromRow({ used: 5, oldest: "2026-10-21T09:30:00Z" }, FREE);
    assert.equal(state.remaining, 0);
    assert.equal(state.nextFreeAt?.toISOString(), "2026-10-28T09:30:00.000Z");
  });
});

describe("formatNextFree", () => {
  const now = new Date("2026-10-27T15:00:00Z"); // a Tuesday

  it("says today, tomorrow, or the weekday, in the reader's zone", () => {
    assert.equal(formatNextFree(new Date("2026-10-27T18:05:00Z"), now, "UTC"), "today at 6:05 PM");
    assert.equal(formatNextFree(new Date("2026-10-28T09:30:00Z"), now, "UTC"), "tomorrow at 9:30 AM");
    assert.equal(formatNextFree(new Date("2026-10-30T09:30:00Z"), now, "UTC"), "on Friday at 9:30 AM");
    // 2026-10-28 02:00 UTC is still Oct 27 in New York.
    assert.equal(formatNextFree(new Date("2026-10-28T02:00:00Z"), now, "America/New_York"), "today at 10:00 PM");
  });

  it("labels UTC when the zone is a guess", () => {
    assert.equal(formatNextFree(new Date("2026-10-30T09:30:00Z"), now, "UTC", true), "on Friday at 9:30 AM UTC");
  });

  it("labels what's left", () => {
    assert.equal(allowanceRemainingLabel(allowanceState(2, null, FREE), FREE), "3 of 5 new readings left this week");
  });

  it("builds the calm limit message", () => {
    assert.equal(
      allowanceLimitMessage(5, "on Friday at 9:30 AM"),
      "You’ve read 5 this week. Your next one frees up on Friday at 9:30 AM.",
    );
  });

  it("accepts only zones Intl knows", () => {
    assert.deepEqual(resolveTimeZone("Pacific/Honolulu"), { timeZone: "Pacific/Honolulu", fallback: false });
    assert.deepEqual(resolveTimeZone("Not/AZone"), { timeZone: "UTC", fallback: true });
    assert.deepEqual(resolveTimeZone(null), { timeZone: "UTC", fallback: true });
  });
});

describe("createSelfReadingStatements", () => {
  const [lock, insert, after] = createSelfReadingStatements(ID, DRAFT, FREE);

  it("locks the account row first", () => {
    assert.equal(lock.text, "select id from teachers where id = $1::uuid for update");
    assert.deepEqual(lock.params, [ID]);
  });

  it("inserts only for a self-learner under the allowance, counted in the rolling window", () => {
    assert.match(insert.text, /^insert into self_readings \(account_id, title, source_url, body_text, grade_level, question_count, body_trimmed\)/);
    assert.match(insert.text, /where exists \(select 1 from teachers where id = \$1::uuid and role = 'self_learner'\)/);
    // Only readings that hold their slot count (a failed generation gives
    // its slot back).
    assert.match(insert.text, /where account_id = \$1::uuid and slot_released_at is null\n    and created_at > now\(\) - make_interval\(days => \$7::int\)\) < \$8::int/);
    assert.deepEqual(insert.params, [ID, "The fox", null, DRAFT.bodyText, "5", 3, 7, 5, false]);
    // Never class or student tables.
    assert.equal(/\b(classes|students|readings r|from readings)\b/.test(insert.text), false);
  });

  it("then reads the window and the role for the outcome", () => {
    assert.match(after.text, /count\(\*\)::int as used, min\(created_at\) as oldest/);
    assert.match(after.text, /slot_released_at is null/);
    assert.deepEqual(after.params, [ID, 7]);
  });
});

describe("createOutcome", () => {
  it("created when the insert returned a row", () => {
    assert.deepEqual(createOutcome([[], [{ id: "r1" }], [{ used: 1, oldest: null, role: "self_learner" }]], FREE), {
      status: "created",
      id: "r1",
    });
  });

  it("limit_reached with the next free time", () => {
    const outcome = createOutcome([[], [], [{ used: 5, oldest: "2026-10-21T09:30:00Z", role: "self_learner" }]], FREE);
    assert.equal(outcome.status, "limit_reached");
    if (outcome.status === "limit_reached") {
      assert.equal(outcome.state.nextFreeAt?.toISOString(), "2026-10-28T09:30:00.000Z");
    }
  });

  it("not_allowed for a teacher or no account", () => {
    assert.deepEqual(createOutcome([[], [], [{ used: 0, oldest: null, role: "teacher" }]], FREE), { status: "not_allowed" });
    assert.deepEqual(createOutcome([[], [], [{ used: 0, oldest: null, role: null }]], FREE), { status: "not_allowed" });
  });
});

describe("createOutcomeRedirect", () => {
  it("replaces /learn/new in history, so Back from the new reading goes to /learn", () => {
    assert.deepEqual(createOutcomeRedirect({ status: "created", id: "r1" }), { path: "/learn/r/r1", type: "replace" });
    assert.deepEqual(createOutcomeRedirect({ status: "limit_reached", state: allowanceState(1, null, FREE) }), {
      path: "/learn/new",
      type: "replace",
    });
    assert.deepEqual(createOutcomeRedirect({ status: "not_allowed" }), { path: "/home", type: "replace" });
  });
});
