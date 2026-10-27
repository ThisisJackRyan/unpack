import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideChallengeWith,
  decideOutcome,
  decideStatements,
  decisionMessage,
  isChallengeDecision,
  openCountStatement,
  queueItems,
  queueStatements,
  type DecideInput,
  type DecideResult,
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
    for (const m of messages) assert.doesNotMatch(m, /—/);
  });

  it("knows the decisions", () => {
    assert.equal(isChallengeDecision("accept"), true);
    assert.equal(isChallengeDecision("deny"), true);
    assert.equal(isChallengeDecision("approve"), false);
    assert.equal(isChallengeDecision(null), false);
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
    assert.equal(items[1].triesAllowed, 3);
    assert.equal(items[1].checksAllowed, 6);
    assert.equal(items[1].lastTry, null);
    assert.deepEqual(items[1].questions, [{ id: "q1", position: 1, prompt: "What?", answer: null }]);
  });
});
