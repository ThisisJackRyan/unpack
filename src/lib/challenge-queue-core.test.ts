import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  decideChallengeWith,
  decideOutcome,
  decideStatements,
  decisionMessage,
  parseDecisionChoice,
  NO_NOTE_LABEL,
  triesUsedLabel,
  noNoteHelp,
  noNoteItems,
  noNoteStatement,
  openCountStatement,
  queueCount,
  queueItems,
  queueStatements,
  teacherQueue,
  type DecideInput,
  type DecideResult,
  type NoNoteItem,
  type QueueItem,
} from "./challenge-queue-core";
import type { Statement } from "./link-rate-limit";
import { EXTRA_TRY_CHECKS } from "./reading-limits";

const INPUT: DecideInput = { challengeId: "ch1", classId: "c1", teacherId: "t1", decision: "accept", extraTry: false };

describe("decideStatements", () => {
  const [lock, update, diagnosis] = decideStatements(INPUT);

  it("take the student's (student, reading) lock, keyed from the challenge row", () => {
    assert.equal(
      lock.text,
      "select pg_advisory_xact_lock(3, hashtext(ch.student_id::text || ':' || ch.reading_id::text)) from challenges ch where ch.id = $1::uuid",
    );
    assert.deepEqual(lock.params, ["ch1"]);
  });

  it("update only an open, unpassed challenge in this teacher's class, in one statement", () => {
    assert.match(update.text, /^update challenges ch set status = \$4::challenge_status, resolved_at = now\(\), resolved_by = \$2::uuid/);
    assert.match(update.text, /c\.id = \$3::uuid and c\.teacher_id = \$2::uuid/);
    assert.match(update.text, /and ch\.status = 'open'/);
    assert.match(update.text, /not exists \(\s*select 1 from attempts p[\s\S]*p\.result = 'pass'/);
    assert.match(update.text, /returning ch\.status, ch\.tries_allowed, ch\.checks_allowed$/);
    assert.deepEqual(update.params, ["ch1", "t1", "c1", "approved", false, EXTRA_TRY_CHECKS]);
  });

  it("grant tries used + 1 and checks used + EXTRA_TRY_CHECKS only for Deny with one more try", () => {
    assert.match(update.text, /tries_allowed = case when \$5::boolean then\s+\(select count\(\*\)::int from attempts a [^)]*\) \+ 1 end/);
    assert.match(update.text, /checks_allowed = case when \$5::boolean then\s+\(select count\(\*\)::int from effort_checks e [^)]*\) \+ \$6::int end/);
    assert.deepEqual(decideStatements({ ...INPUT, decision: "deny", extraTry: true })[1].params.slice(3, 5), ["denied", true]);
    assert.deepEqual(decideStatements({ ...INPUT, decision: "deny", extraTry: false })[1].params.slice(3, 5), ["denied", false]);
    // Accept never grants.
    assert.deepEqual(decideStatements({ ...INPUT, decision: "accept", extraTry: true })[1].params.slice(3, 5), ["approved", false]);
  });

  it("diagnose ownership with the same scope", () => {
    assert.match(diagnosis.text, /where ch\.id = \$1::uuid and c\.id = \$3::uuid and c\.teacher_id = \$2::uuid$/);
    assert.deepEqual(diagnosis.params, ["ch1", "t1", "c1"]);
  });

  it("use every parameter they pass", () => {
    for (const s of decideStatements(INPUT)) {
      for (let i = 1; i <= s.params.length; i++) assert.match(s.text, new RegExp(`\\$${i}::`));
      assert.doesNotMatch(s.text, new RegExp(`\\$${s.params.length + 1}\\b`));
    }
  });
});

describe("decideOutcome", () => {
  it("reads the decision, or why there wasn't one", () => {
    assert.deepEqual(decideOutcome([[{}], [{ status: "approved", tries_allowed: null }], [{}]]), { status: "accepted" });
    assert.deepEqual(decideOutcome([[{}], [{ status: "denied", tries_allowed: null }], [{}]]), { status: "denied", extraTry: false });
    assert.deepEqual(decideOutcome([[{}], [{ status: "denied", tries_allowed: 4 }], [{}]]), { status: "denied", extraTry: true });
    assert.deepEqual(decideOutcome([[{}], [], [{ status: "approved" }]]), { status: "already_decided" });
    assert.deepEqual(decideOutcome([[], [], []]), { status: "not_found" });
  });
});

// A fake of the locked conditional update: each batch is one step.
function fakeDb(owned = true) {
  let status = "open";
  let grants = 0;
  const execute = async (statements: Statement[]) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const [, update] = statements;
    const [, teacherId, , newStatus, grant] = update.params as [string, string, string, string, boolean];
    if (owned && teacherId === "t1" && status === "open") {
      status = newStatus;
      if (grant) grants++;
      return [[{}], [{ status, tries_allowed: grant ? 4 : null }], [{ status }]];
    }
    return [[{}], [], owned && teacherId === "t1" ? [{ status }] : []];
  };
  return { execute, status: () => status, grants: () => grants };
}

describe("decideChallengeWith", () => {
  it("20 parallel accepts and denies make exactly one decision", async () => {
    const db = fakeDb();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        decideChallengeWith({ ...INPUT, decision: i % 2 ? "deny" : "accept", extraTry: i % 3 === 0 }, db.execute),
      ),
    );
    const decided = results.filter((r) => r.status === "accepted" || r.status === "denied");
    assert.equal(decided.length, 1);
    assert.equal(results.filter((r) => r.status === "already_decided").length, 19);
    assert.ok(db.grants() <= 1);
  });

  it("two tabs granting one more try: one grant", async () => {
    const db = fakeDb();
    const deny = { ...INPUT, decision: "deny" as const, extraTry: true };
    const results = await Promise.all([decideChallengeWith(deny, db.execute), decideChallengeWith(deny, db.execute)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["already_decided", "denied"]);
    assert.equal(db.grants(), 1);
  });

  it("another teacher's challenge is not found and stays open", async () => {
    const db = fakeDb();
    assert.deepEqual(await decideChallengeWith({ ...INPUT, teacherId: "t2" }, db.execute), { status: "not_found" });
    assert.equal(db.status(), "open");
  });

  it("propagates database errors (fail closed)", async () => {
    await assert.rejects(
      decideChallengeWith(INPUT, async () => {
        throw new Error("db down");
      }),
      /db down/,
    );
  });
});

describe("decisionMessage", () => {
  it("has a calm message for each outcome", () => {
    const all: DecideResult[] = [
      { status: "accepted" },
      { status: "denied", extraTry: false },
      { status: "denied", extraTry: true },
      { status: "already_decided" },
      { status: "not_found" },
    ];
    const messages = all.map((r) => decisionMessage(r, "Maya Ro"));
    assert.deepEqual(messages, [
      "Accepted. Maya Ro passed this reading.",
      "Denied. Maya Ro will see that you read their note.",
      "Denied. Maya Ro has 1 more try.",
      "Already decided. The list is up to date.",
      "We couldn’t find that challenge. The list is up to date.",
    ]);
    for (const m of messages) assert.doesNotMatch(m, /\u2014/);
  });

  it("reads each button as its own explicit choice", () => {
    assert.deepEqual(parseDecisionChoice("accept"), { decision: "accept", extraTry: false });
    assert.deepEqual(parseDecisionChoice("deny"), { decision: "deny", extraTry: false });
    assert.deepEqual(parseDecisionChoice("deny_extra_try"), { decision: "deny", extraTry: true });
    for (const v of ["accept_extra_try", "toString", "__proto__", "", null, undefined, 1]) {
      assert.equal(parseDecisionChoice(v), null, String(v));
    }
  });
});

describe("queue", () => {
  it("lists open, unpassed challenges in this teacher's class, oldest first", () => {
    const [list, questions] = queueStatements("c1", "t1");
    for (const s of [list, questions, openCountStatement("c1", "t1")]) {
      assert.match(s.text, /where c\.id = \$1::uuid and c\.teacher_id = \$2::uuid and ch\.status = 'open' and not exists \(\s*select 1 from attempts p/);
      assert.deepEqual(s.params, ["c1", "t1"]);
    }
    assert.match(list.text, /order by ch\.created_at, ch\.id$/);
    assert.match(questions.text, /q\.student_id is not distinct from \(case when r\.question_mode = 'per_student' then ch\.student_id end\)/);
    assert.match(questions.text, /order by a\.try_number desc limit 1/);
    // Every join comes before the where clause.
    for (const s of [list, questions]) {
      const where = s.text.search(/^where /m);
      assert.ok(where > 0 && !/\bjoin\b/.test(s.text.slice(where)), "no join after where");
    }
  });

  it("maps rows to items with the last try's answers", () => {
    const items = queueItems([
      [
        {
          id: "ch1",
          round: 2,
          note: "I tried.",
          created_at: new Date("2026-10-27T10:00:00Z"),
          student_id: "s1",
          first_name: "Maya",
          last_initials: "Ro",
          reading_id: "r1",
          title: "Foxes",
          tries: 4,
          checks: 5,
          tries_allowed: 4,
          checks_allowed: 5,
          last_try: 4,
          // Round 1 was one more try without a note: this is their first.
          note_number: 1,
        },
        { id: "ch2", note: "Help", created_at: "2026-10-27", student_id: "s2", first_name: "Keʻala", last_initials: "P", reading_id: "r1", title: "Foxes", tries: 0, checks: 6, last_try: null },
      ],
      [
        { challenge_id: "ch1", question_id: "q2", position: 2, prompt: "Why?", text: "idk", ai_pass: false, ai_feedback: "Look again." },
        { challenge_id: "ch1", question_id: "q1", position: 1, prompt: "What?", text: "A fox", ai_pass: true, ai_feedback: null },
        { challenge_id: "ch2", question_id: "q1", position: 1, prompt: "What?", text: null, ai_pass: null, ai_feedback: null },
      ],
    ]);
    assert.deepEqual(items[0], {
      id: "ch1",
      round: 2,
      noteNumber: 1,
      note: "I tried.",
      createdAt: "2026-10-27T10:00:00.000Z",
      studentId: "s1",
      studentName: "Maya Ro",
      readingId: "r1",
      readingTitle: "Foxes",
      tries: 4,
      triesAllowed: 4,
      checks: 5,
      checksAllowed: 5,
      lastTry: 4,
      questions: [
        { id: "q1", position: 1, prompt: "What?", answer: { text: "A fox", pass: true, nudge: "" } },
        { id: "q2", position: 2, prompt: "Why?", answer: { text: "idk", pass: false, nudge: "Look again." } },
      ],
    });
    assert.equal(items[1].studentName, "Keʻala P");
    assert.equal(items[1].round, 1);
    assert.equal(items[1].noteNumber, 1);
    assert.equal(items[1].triesAllowed, 3);
    assert.equal(items[1].checksAllowed, 6);
    assert.equal(items[1].lastTry, null);
    assert.deepEqual(items[1].questions, [{ id: "q1", position: 1, prompt: "What?", answer: null }]);
  });
});

describe("out of tries, no note yet", () => {
  // A student out of tries on r1: 3 of 3 tries, no challenge.
  const ROW = {
    student_id: "s1",
    first_name: "Maya",
    last_initials: "Ro",
    reading_id: "r1",
    title: "Foxes",
    challenge: null,
    extra_try: null,
    tries: 3,
    checks: 3,
    tries_allowed: 3,
    checks_allowed: 6,
    ran_out_at: new Date("2026-10-27T09:00:00Z"),
  };

  function challenge(id: string, studentId: string, createdAt: string, readingId = "r1"): QueueItem {
    return {
      id,
      round: 1,
      noteNumber: 1,
      note: "I tried.",
      createdAt,
      studentId,
      studentName: "Kid",
      readingId,
      readingTitle: "Foxes",
      tries: 3,
      triesAllowed: 3,
      checks: 3,
      checksAllowed: 6,
      lastTry: 3,
      questions: [],
    };
  }

  function noNote(studentId: string, ranOutAt: string, readingId = "r1"): NoNoteItem {
    return {
      studentId,
      studentName: "Kid",
      readingId,
      readingTitle: "Foxes",
      tries: 3,
      triesAllowed: 3,
      checks: 3,
      checksAllowed: 6,
      ranOutAt,
    };
  }

  it("reads only this teacher's class, its published readings, and its students", () => {
    const s = noNoteStatement("c1", "t1");
    assert.deepEqual(s.params, ["c1", "t1"]);
    assert.match(s.text, /join students s on s\.class_id = c\.id/);
    assert.match(s.text, /join readings r on r\.class_id = c\.id and r\.status = 'published'/);
    assert.match(s.text, /where c\.id = \$1::uuid and c\.teacher_id = \$2::uuid/);
    assert.match(s.text, /not exists \(select 1 from attempts p where p\.student_id = s\.id and p\.reading_id = r\.id and p\.result = 'pass'\)/);
    assert.match(s.text, /lc\.status not in \('open', 'approved'\)/);
    assert.match(s.text, /t\.tries >= t\.tries_allowed or t\.checks >= t\.checks_allowed/);
    // Only counted checks, for the count and for the time they ran out.
    assert.equal(s.text.match(/outcome is distinct from 'given_back'/g)?.length, 2);
    const where = s.text.search(/^where /m);
    assert.ok(where > 0 && !/\bjoin\b/.test(s.text.slice(where)), "no join after where");
  });

  it("maps a Waiting row to an item, with the time they ran out", () => {
    assert.deepEqual(noNoteItems([ROW]), [
      {
        studentId: "s1",
        studentName: "Maya Ro",
        readingId: "r1",
        readingTitle: "Foxes",
        tries: 3,
        triesAllowed: 3,
        checks: 3,
        checksAllowed: 6,
        ranOutAt: "2026-10-27T09:00:00.000Z",
      },
    ]);
  });

  it("lists the check limit and a used one more try too", () => {
    const checkLimit = { ...ROW, tries: 1, checks: 6 };
    const usedExtraTry = { ...ROW, challenge: "denied", extra_try: true, tries: 4, tries_allowed: 4, checks: 5, checks_allowed: 5 };
    assert.equal(noNoteItems([checkLimit, usedExtraTry]).length, 2);
  });

  it("leaves out a sent note, a decision, one more try not used yet, or tries left", () => {
    const rows = [
      { ...ROW, challenge: "open" },
      { ...ROW, challenge: "approved" },
      { ...ROW, challenge: "denied", extra_try: false },
      { ...ROW, challenge: "denied", extra_try: true, tries_allowed: 4, checks_allowed: 8 },
      { ...ROW, tries: 2, checks: 2 },
    ];
    assert.deepEqual(noNoteItems(rows), []);
  });

  it("merges with the challenges, oldest first by when they started waiting", () => {
    const entries = teacherQueue(
      [challenge("ch1", "s1", "2026-10-27T10:00:00.000Z"), challenge("ch2", "s2", "2026-10-27T08:00:00.000Z")],
      [noNote("s3", "2026-10-27T09:00:00.000Z"), noNote("s4", "2026-10-27T11:00:00.000Z")],
    );
    assert.deepEqual(
      entries.map((e) => [e.kind, e.key, e.at]),
      [
        ["challenge", "ch2", "2026-10-27T08:00:00.000Z"],
        ["no_note", "s3:r1", "2026-10-27T09:00:00.000Z"],
        ["challenge", "ch1", "2026-10-27T10:00:00.000Z"],
        ["no_note", "s4:r1", "2026-10-27T11:00:00.000Z"],
      ],
    );
  });

  it("lists a student with a sent note once, as the challenge", () => {
    const entries = teacherQueue(
      [challenge("ch1", "s1", "2026-10-27T10:00:00.000Z")],
      [noNote("s1", "2026-10-27T09:00:00.000Z"), noNote("s1", "2026-10-27T09:00:00.000Z", "r2")],
    );
    assert.deepEqual(entries.map((e) => [e.kind, e.key]), [["no_note", "s1:r2"], ["challenge", "ch1"]]);
    assert.equal(queueCount([challenge("ch1", "s1", "2026-10-27T10:00:00.000Z")], [noNote("s1", "2026-10-27T09:00:00.000Z")]), 1);
  });

  it("counts both kinds, the same as the list", () => {
    assert.equal(queueCount([], []), 0);
    assert.equal(queueCount([challenge("ch1", "s1", "2026-10-27T10:00:00.000Z")], [noNote("s2", "2026-10-27T09:00:00.000Z")]), 2);
  });

  it("breaks ties by key and puts a missing time last", () => {
    const entries = teacherQueue(
      [challenge("ch9", "s9", "")],
      [noNote("s2", "2026-10-27T09:00:00.000Z"), noNote("s1", "2026-10-27T09:00:00.000Z")],
    );
    assert.deepEqual(entries.map((e) => e.key), ["s1:r1", "s2:r1", "ch9"]);
  });

  it("has a plain label and helper line", () => {
    assert.equal(NO_NOTE_LABEL, "Out of tries, no note yet");
    assert.equal(noNoteHelp("Maya Ro"), "Maya Ro can still send you a note.");
  });
});

// C2: the teacher's queue cards show tries, not "checks used".
describe("queue card counts", () => {
  it("says tries used, singular for 1", () => {
    assert.equal(triesUsedLabel(3, 3), "3 of 3 tries used");
    assert.equal(triesUsedLabel(4, 4), "4 of 4 tries used");
    assert.equal(triesUsedLabel(1, 1), "1 of 1 try used");
    assert.equal(triesUsedLabel(0, 3), "0 of 3 tries used");
  });

  it("neither the challenge card nor the out of tries row shows checks", () => {
    const queue = readFileSync(new URL("../app/teacher/classes/[id]/challenges/queue.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(queue, /checks used|item\.checks/);
    assert.equal(queue.match(/triesUsedLabel\(item\.tries, item\.triesAllowed\)/g)?.length, 2);
  });
});
