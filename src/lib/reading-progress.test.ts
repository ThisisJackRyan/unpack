import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answerStage,
  latestChallenge,
  passedCountLabel,
  progressStatements,
  readingListItems,
  readingListStatement,
  readingProgress,
  stageAnnouncement,
  STUDENT_READING_STATUS_LABELS,
  studentReadingStatus,
  type AttemptView,
  type LatestChallenge,
  type ReadingProgress,
} from "./reading-progress";
import { DEFAULT_LIMITS, EXTRA_TRY_CHECKS } from "./reading-limits";
import { EFFORT_CHECK_LIMIT, MAX_TRIES } from "./validate-answers";

const fail = (tryNumber: number): AttemptView => ({
  tryNumber,
  result: "fail",
  answers: { q1: { text: "a", pass: true, nudge: "" }, q2: { text: "idk", pass: false, nudge: "Look again." } },
});
const pass = (tryNumber: number): AttemptView => ({
  tryNumber,
  result: "pass",
  answers: { q1: { text: "a", pass: true, nudge: "" }, q2: { text: "b", pass: true, nudge: "" } },
});

const open: LatestChallenge = { status: "open", extraTry: false };
const approved: LatestChallenge = { status: "approved", extraTry: false };
const denied: LatestChallenge = { status: "denied", extraTry: false };
const deniedExtra: LatestChallenge = { status: "denied", extraTry: true };
const closed: LatestChallenge = { status: "closed", extraTry: false };
// The limits after one more try from 3 used tries and 3 checks.
const granted = { tries: MAX_TRIES + 1, checks: MAX_TRIES + EXTRA_TRY_CHECKS };

function progress(p: Partial<ReadingProgress>): ReadingProgress {
  return { attempts: [], challenge: null, checks: 0, limits: DEFAULT_LIMITS, ...p };
}

describe("studentReadingStatus", () => {
  const s = studentReadingStatus;

  it("derives the status from attempts and the challenge", () => {
    assert.equal(s({ passed: false, tries: 0, checks: 0, challenge: null }), "not_started");
    assert.equal(s({ passed: false, tries: 1, checks: 1, challenge: null }), "in_progress");
    assert.equal(s({ passed: false, tries: 3, checks: 3, challenge: null }), "in_progress");
    assert.equal(s({ passed: true, tries: 2, checks: 2, challenge: null }), "passed");
    assert.equal(s({ passed: false, tries: 3, checks: 3, challenge: open }), "challenged");
  });

  it("accepted counts as passed", () => {
    assert.equal(s({ passed: false, tries: 3, checks: 3, challenge: approved }), "passed");
    assert.equal(s({ passed: false, tries: 0, checks: EFFORT_CHECK_LIMIT, challenge: approved }), "passed");
  });

  it("denied without one more try is Challenge denied", () => {
    assert.equal(s({ passed: false, tries: 3, checks: 3, challenge: denied }), "challenge_denied");
    assert.equal(s({ passed: false, tries: 0, checks: EFFORT_CHECK_LIMIT, challenge: denied }), "challenge_denied");
  });

  it("denied with one more try is In progress, used or not, until a new note", () => {
    assert.equal(s({ passed: false, tries: 3, checks: 3, challenge: deniedExtra, limits: granted }), "in_progress");
    assert.equal(s({ passed: false, tries: 4, checks: 4, challenge: deniedExtra, limits: granted }), "in_progress");
    // The extra try failed and the student sent a new note (round 2).
    assert.equal(s({ passed: false, tries: 4, checks: 4, challenge: open, limits: granted }), "challenged");
    // ...which the teacher denied for good.
    assert.equal(s({ passed: false, tries: 4, checks: 4, challenge: denied, limits: granted }), "challenge_denied");
  });

  it("passed after a challenge beats every challenge state", () => {
    for (const challenge of [open, denied, deniedExtra, closed, approved]) {
      assert.equal(s({ passed: true, tries: 4, checks: 4, challenge, limits: granted }), "passed", challenge.status);
    }
  });

  it("is In progress once every check is used, even with no try saved, by the student's own limit", () => {
    assert.equal(s({ passed: false, tries: 0, checks: EFFORT_CHECK_LIMIT - 1, challenge: null }), "not_started");
    assert.equal(s({ passed: false, tries: 0, checks: EFFORT_CHECK_LIMIT, challenge: null }), "in_progress");
    assert.equal(s({ passed: false, tries: 0, checks: EFFORT_CHECK_LIMIT, challenge: open }), "challenged");
    assert.equal(s({ passed: false, tries: 0, checks: 2, challenge: null, limits: { tries: 1, checks: 2 } }), "in_progress");
  });

  it("has a label for each", () => {
    assert.deepEqual(Object.values(STUDENT_READING_STATUS_LABELS), [
      "Not started",
      "In progress",
      "Passed",
      "Challenged",
      "Challenge denied",
    ]);
  });

  it("parses the latest challenge", () => {
    assert.deepEqual(latestChallenge("denied", true), deniedExtra);
    assert.deepEqual(latestChallenge("closed", null), closed);
    assert.equal(latestChallenge(null, false), null);
    assert.equal(latestChallenge("weird", true), null);
  });
});

describe("answerStage", () => {
  it("starts at try 1, then prefills from the last failed try", () => {
    assert.deepEqual(answerStage(progress({})), { kind: "answer", tryNumber: 1, maxTries: MAX_TRIES, previous: null, extraTry: false });
    const one = fail(1);
    assert.deepEqual(answerStage(progress({ attempts: [one] })), {
      kind: "answer",
      tryNumber: 2,
      maxTries: MAX_TRIES,
      previous: one,
      extraTry: false,
    });
  });

  it("shows the passing try as done", () => {
    const p = pass(2);
    assert.deepEqual(answerStage(progress({ attempts: [fail(1), p] })), { kind: "passed", attempt: p, byTeacher: false });
  });

  it("offers the challenge after 3 failed tries", () => {
    const last = fail(3);
    assert.deepEqual(answerStage(progress({ attempts: [fail(1), fail(2), last] })), {
      kind: "out_of_tries",
      attempt: last,
      extraTry: false,
    });
  });

  it("at the check limit with tries left, offers only the note (no answer form)", () => {
    assert.deepEqual(answerStage(progress({ checks: EFFORT_CHECK_LIMIT })), { kind: "check_limit", attempt: null });
    const last = fail(1);
    assert.deepEqual(answerStage(progress({ attempts: [last], checks: EFFORT_CHECK_LIMIT })), { kind: "check_limit", attempt: last });
    assert.equal(answerStage(progress({ attempts: [fail(1), fail(2)], checks: EFFORT_CHECK_LIMIT + 1 })).kind, "check_limit");
    assert.equal(answerStage(progress({ attempts: [last], checks: EFFORT_CHECK_LIMIT - 1 })).kind, "answer");
  });

  it("puts passed, a challenge, and out of tries ahead of the check limit", () => {
    const checks = EFFORT_CHECK_LIMIT;
    const p = pass(2);
    assert.deepEqual(answerStage(progress({ attempts: [fail(1), p], checks })), { kind: "passed", attempt: p, byTeacher: false });
    assert.deepEqual(answerStage(progress({ attempts: [fail(1)], challenge: approved, checks })), {
      kind: "passed",
      attempt: fail(1),
      byTeacher: true,
    });
    assert.deepEqual(answerStage(progress({ challenge: open, checks })), { kind: "challenged", status: "open", attempt: null });
    assert.deepEqual(answerStage(progress({ attempts: [fail(1)], challenge: denied, checks })), {
      kind: "challenged",
      status: "denied",
      attempt: fail(1),
    });
    const three = [fail(1), fail(2), fail(3)];
    assert.deepEqual(answerStage(progress({ attempts: three, checks })), { kind: "out_of_tries", attempt: three[2], extraTry: false });
  });

  it("shows a sent, denied, or accepted challenge", () => {
    const attempts = [fail(1), fail(2), fail(3)];
    assert.equal(answerStage(progress({ attempts, challenge: open, checks: 3 })).kind, "challenged");
    assert.deepEqual(answerStage(progress({ attempts, challenge: denied, checks: 3 })), {
      kind: "challenged",
      status: "denied",
      attempt: attempts[2],
    });
    assert.deepEqual(answerStage(progress({ attempts, challenge: approved, checks: 3 })), {
      kind: "passed",
      attempt: attempts[2],
      byTeacher: true,
    });
  });

  it("denied with one more try: the form is back with 1 try left, then the note again", () => {
    const attempts = [fail(1), fail(2), fail(3)];
    assert.deepEqual(answerStage(progress({ attempts, challenge: deniedExtra, checks: 3, limits: granted })), {
      kind: "answer",
      tryNumber: 4,
      maxTries: 4,
      previous: attempts[2],
      extraTry: true,
    });
    const four = [...attempts, fail(4)];
    assert.deepEqual(answerStage(progress({ attempts: four, challenge: deniedExtra, checks: 4, limits: granted })), {
      kind: "out_of_tries",
      attempt: four[3],
      extraTry: true,
    });
    // Two model failures used the headroom without a try: the note opens.
    assert.equal(answerStage(progress({ attempts, challenge: deniedExtra, checks: granted.checks, limits: granted })).kind, "check_limit");
    // Passing the extra try is a plain pass.
    const passed = [...attempts, pass(4)];
    assert.deepEqual(answerStage(progress({ attempts: passed, challenge: deniedExtra, checks: 4, limits: granted })), {
      kind: "passed",
      attempt: passed[3],
      byTeacher: false,
    });
  });

  it("one more try at the check limit with tries unused: exactly 1 try left", () => {
    const limits = { tries: 2, checks: EFFORT_CHECK_LIMIT + EXTRA_TRY_CHECKS };
    const stage = answerStage(progress({ attempts: [fail(1)], challenge: deniedExtra, checks: EFFORT_CHECK_LIMIT, limits }));
    assert.equal(stage.kind === "answer" && stage.maxTries - stage.tryNumber + 1, 1);
  });
});

describe("stageAnnouncement", () => {
  it("says what changed, and nothing before the first try", () => {
    assert.equal(stageAnnouncement({ kind: "answer", tryNumber: 1, maxTries: 3, previous: null, extraTry: false }), "");
    assert.equal(
      stageAnnouncement({ kind: "answer", tryNumber: 2, maxTries: 3, previous: fail(1), extraTry: false }),
      "Not yet. 1 of 2 answers passed. Read the tips and try again. This is try 2 of 3.",
    );
    assert.equal(
      stageAnnouncement({ kind: "answer", tryNumber: 4, maxTries: 4, previous: fail(3), extraTry: true }),
      "Your teacher gave you one more try. You have 1 try left.",
    );
    assert.match(stageAnnouncement({ kind: "passed", attempt: pass(1), byTeacher: false }), /You passed/);
    assert.equal(stageAnnouncement({ kind: "passed", attempt: null, byTeacher: true }), "Your teacher accepted your answers.");
    assert.match(stageAnnouncement({ kind: "out_of_tries", attempt: null, extraTry: false }), /try 3 of 3/);
    assert.match(stageAnnouncement({ kind: "out_of_tries", attempt: null, extraTry: true }), /That was your extra try/);
    assert.equal(
      stageAnnouncement({ kind: "check_limit", attempt: null }),
      "We couldn’t check your answers. You can send a note to your teacher.",
    );
    assert.match(stageAnnouncement({ kind: "challenged", status: "open", attempt: null }), /Your teacher will take a look/);
    assert.equal(stageAnnouncement({ kind: "challenged", status: "denied", attempt: null }), "Your teacher read your note.");
  });

  it("counts passed answers", () => {
    assert.equal(passedCountLabel(pass(1)), "2 of 2 answers passed.");
    assert.equal(passedCountLabel({ tryNumber: 1, result: "fail", answers: { q: { text: "", pass: false, nudge: "x" } } }), "0 of 1 answer passed.");
  });
});

describe("readingProgress", () => {
  it("reads attempts with their answers, the latest challenge, and the limits", () => {
    const result = readingProgress([
      [
        { try_number: 1, result: "fail", answers: [{ question_id: "q1", text: "idk", pass: false, nudge: "Look again." }] },
        { try_number: 2, result: "pass", answers: JSON.stringify([{ question_id: "q1", text: "b", pass: true, nudge: null }]) },
      ],
      [{ status: "denied", extra_try: true, tries_allowed: 4, checks_allowed: 5 }],
      [{ checks: 4 }],
    ]);
    assert.deepEqual(result, {
      attempts: [
        { tryNumber: 1, result: "fail", answers: { q1: { text: "idk", pass: false, nudge: "Look again." } } },
        { tryNumber: 2, result: "pass", answers: { q1: { text: "b", pass: true, nudge: "" } } },
      ],
      challenge: deniedExtra,
      checks: 4,
      limits: { tries: 4, checks: 5 },
    });
    assert.deepEqual(readingProgress([[], []]), { attempts: [], challenge: null, checks: 0, limits: DEFAULT_LIMITS });
  });

  it("scopes the queries to the student and reading, latest round first", () => {
    const [attempts, challenge, checks] = progressStatements("s1", "r1");
    assert.match(attempts.text, /where a\.student_id = \$1::uuid and a\.reading_id = \$2::uuid/);
    assert.match(attempts.text, /order by a\.try_number/);
    assert.match(challenge.text, /from \(select 1\) one\s+left join lateral \(select lc\.status, lc\.tries_allowed is not null as extra_try from challenges lc/);
    assert.match(challenge.text, /where lc\.student_id = \$1::uuid and lc\.reading_id = \$2::uuid\s+order by lc\.round desc limit 1\) lc on true/);
    assert.match(challenge.text, /as tries_allowed/);
    assert.match(challenge.text, /as checks_allowed/);
    assert.match(checks.text, /count\(\*\)::int as checks from effort_checks where student_id = \$1::uuid and reading_id = \$2::uuid/);
  });
});

describe("readingListItems", () => {
  it("lists published readings in the class with each status", () => {
    const s = readingListStatement("c1", "s1");
    assert.match(s.text, /where r\.class_id = \$1::uuid and r\.status = 'published'/);
    assert.match(s.text, /from effort_checks e where e\.reading_id = r\.id and e\.student_id = \$2::uuid and e\.outcome is distinct from 'given_back'\) as checks/);
    assert.match(s.text, /left join lateral \(select lc\.status[\s\S]*where lc\.student_id = \$2::uuid and lc\.reading_id = r\.id/);
    assert.deepEqual(s.params, ["c1", "s1"]);
    const items = readingListItems([
      { id: "r1", title: "A", question_count: 3, passed: false, tries: 0, challenge: null },
      { id: "r2", title: "B", question_count: 2, passed: true, tries: 2, challenge: null },
      { id: "r3", title: "C", question_count: 1, passed: false, tries: 3, challenge: "open" },
      { id: "r4", title: "D", question_count: 1, passed: false, tries: 1, challenge: null },
      { id: "r5", title: "E", question_count: 1, passed: false, tries: 0, checks: EFFORT_CHECK_LIMIT, challenge: null },
      { id: "r6", title: "F", question_count: 1, passed: false, tries: 3, challenge: "denied", extra_try: false },
      { id: "r7", title: "G", question_count: 1, passed: false, tries: 3, challenge: "denied", extra_try: true },
      { id: "r8", title: "H", question_count: 1, passed: false, tries: 3, challenge: "approved" },
      { id: "r9", title: "I", question_count: 1, passed: true, tries: 4, challenge: "closed" },
    ]);
    assert.deepEqual(items.map((i) => i.status), [
      "not_started",
      "passed",
      "challenged",
      "in_progress",
      "in_progress",
      "challenge_denied",
      "in_progress",
      "passed",
      "passed",
    ]);
    assert.deepEqual(items[0], { id: "r1", title: "A", questionCount: 3, status: "not_started" });
  });
});
