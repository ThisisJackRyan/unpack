import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { grantExtraTryWith, grantOutcome, grantStatements } from "./challenge-grant-core";
import {
  decideStatements,
  GIVE_EXTRA_TRY_LABEL,
  GIVE_EXTRA_TRY_PENDING,
  grantMessage,
  type GrantInput,
  type GrantResult,
} from "./challenge-queue-core";
import { CHALLENGE_UNIQUE_CONSTRAINT } from "./challenges-core";
import type { Statement } from "./link-rate-limit";
import { EXTRA_TRY_CHECKS, grantedChecksSql, grantedTriesSql } from "./reading-limits";
import { EFFORT_CLAIM_STALE_SECONDS } from "./submit-answers-core";
import { EFFORT_CHECK_LIMIT, MAX_TRIES, validateChallengeNote } from "./validate-answers";

const INPUT: GrantInput = { classId: "c1", teacherId: "t1", studentId: "s1", readingId: "r1" };

describe("grantStatements", () => {
  const [lock, insert, diagnosis] = grantStatements(INPUT);

  it("take the student's (student, reading) lock first, like a note and a decision", () => {
    assert.equal(lock.text, "select pg_advisory_xact_lock($1::int, hashtext($2::text))");
    assert.deepEqual(lock.params, [3, "s1:r1"]);
    assert.deepEqual(grantStatements({ ...INPUT, studentId: "S1", readingId: "R1" })[0].params, [3, "s1:r1"]);
  });

  it("insert a denied round with an empty note, resolved by this teacher, at the next round", () => {
    assert.match(
      insert.text,
      /^insert into challenges \(student_id, reading_id, note, round, status, resolved_at, resolved_by, tries_allowed, checks_allowed\)\nselect \$1::uuid, \$2::uuid, '',/,
    );
    assert.match(insert.text, /\(select coalesce\(max\(round\), 0\) \+ 1 from challenges where student_id = \$1::uuid and reading_id = \$2::uuid\),\s+'denied', now\(\), \$3::uuid,/);
    assert.match(insert.text, /returning tries_allowed, checks_allowed$/);
    assert.deepEqual(insert.params, ["s1", "r1", "t1", "c1", EXTRA_TRY_CHECKS, EFFORT_CLAIM_STALE_SECONDS]);
  });

  it("grant exactly what Deny, give one more try grants (tries used + 1, checks used + EXTRA_TRY_CHECKS)", () => {
    assert.ok(insert.text.includes(grantedTriesSql("$1::uuid", "$2::uuid")));
    assert.ok(insert.text.includes(grantedChecksSql("$1::uuid", "$2::uuid", "$5::int")));
    const decide = decideStatements({ challengeId: "ch1", classId: "c1", teacherId: "t1", decision: "deny", extraTry: true })[1];
    assert.ok(decide.text.includes(grantedTriesSql("ch.student_id", "ch.reading_id")));
    assert.ok(decide.text.includes(grantedChecksSql("ch.student_id", "ch.reading_id", "$6::int")));
    assert.match(grantedTriesSql("x", "y"), /^\(select count\(\*\)::int from attempts a where a\.student_id = x and a\.reading_id = y\) \+ 1$/);
    assert.match(grantedChecksSql("x", "y", "$9::int"), /outcome is distinct from 'given_back'\) \+ \$9::int$/);
  });

  it("only for this teacher's class, a student in it, and a published reading in it", () => {
    assert.match(
      insert.text,
      /where exists \(\s*select 1 from readings r\s+join classes c on c\.id = r\.class_id\s+join students s on s\.class_id = c\.id\s+where r\.id = \$2::uuid and s\.id = \$1::uuid and r\.status = 'published'\s+and c\.id = \$4::uuid and c\.teacher_id = \$3::uuid\s+\)/,
    );
  });

  it("only while out of tries (or checks) with no note: no pass, no blocking round, no check running", () => {
    assert.match(insert.text, /and not exists \(\s*select 1 from attempts where student_id = \$1::uuid and reading_id = \$2::uuid and result = 'pass'/);
    assert.match(insert.text, /and not exists \(\s*select 1 from challenges where student_id = \$1::uuid and reading_id = \$2::uuid\s+and \(status <> 'denied' or tries_allowed is null\)/);
    assert.match(insert.text, /and \(\(select count\(\*\) from attempts where student_id = \$1::uuid and reading_id = \$2::uuid\) >= coalesce\(/);
    assert.match(insert.text, /or \(select count\(\*\) from effort_checks [^)]*outcome is distinct from 'given_back'\) >= coalesce\(/);
    assert.match(insert.text, /and not exists \(\s*select 1 from effort_checks\s+where [^)]*finished_at is null and created_at > now\(\) - make_interval\(secs => \$6::int\)/);
  });

  it("diagnose with the same scope and rules", () => {
    assert.match(diagnosis.text, /^select exists \(\s*select 1 from readings r[\s\S]*c\.teacher_id = \$3::uuid\s+\) as owned, /);
    assert.match(diagnosis.text, / as not_waiting, /);
    assert.match(diagnosis.text, /make_interval\(secs => \$5::int\)\s+\) as live$/);
    assert.deepEqual(diagnosis.params, ["s1", "r1", "t1", "c1", EFFORT_CLAIM_STALE_SECONDS]);
  });

  it("use every parameter they pass", () => {
    for (const s of [insert, diagnosis]) {
      for (let i = 1; i <= s.params.length; i++) assert.match(s.text, new RegExp(`\\$${i}::`));
      assert.doesNotMatch(s.text, new RegExp(`\\$${s.params.length + 1}\\b`));
    }
  });
});

describe("grantOutcome", () => {
  it("reads the grant, or why there wasn't one", () => {
    assert.deepEqual(grantOutcome([[{}], [{ tries_allowed: 4, checks_allowed: 8 }], [{}]]), { status: "granted" });
    assert.deepEqual(grantOutcome([[{}], [], [{ owned: false, not_waiting: false, live: false }]]), { status: "not_found" });
    assert.deepEqual(grantOutcome([[{}], [], []]), { status: "not_found" });
    assert.deepEqual(grantOutcome([[{}], [], [{ owned: true, not_waiting: true, live: true }]]), { status: "not_waiting" });
    assert.deepEqual(grantOutcome([[{}], [], [{ owned: true, not_waiting: false, live: true }]]), { status: "busy" });
    assert.deepEqual(grantOutcome([[{}], [], [{ owned: true, not_waiting: false, live: false }]]), { status: "not_waiting" });
  });
});

// A fake of the locked conditional insert, by the same rules, reading the
// statement's own parameters. Batches run one at a time (the lock).
type Round = { round: number; status: "open" | "approved" | "denied" | "closed"; note: string; triesAllowed: number | null; checksAllowed: number | null };
function fakeDb(init: { tries?: number; checks?: number; passed?: boolean; rounds?: Round[]; live?: boolean; published?: boolean } = {}) {
  const state = {
    tries: init.tries ?? MAX_TRIES,
    checks: init.checks ?? MAX_TRIES,
    passed: init.passed ?? false,
    rounds: [...(init.rounds ?? [])],
    live: init.live ?? false,
    published: init.published ?? true,
  };
  const latestGrant = (key: "triesAllowed" | "checksAllowed") =>
    [...state.rounds].reverse().find((r) => r[key] !== null)?.[key] ?? null;
  let queue = Promise.resolve();
  const execute = (statements: Statement[]) => {
    const run = queue.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const [student, reading, teacher, klass, extraChecks] = statements[1].params as [string, string, string, string, number];
      const owned = state.published && student === "s1" && reading === "r1" && teacher === "t1" && klass === "c1";
      const blocking = state.rounds.some((r) => r.status !== "denied" || r.triesAllowed === null);
      const out = state.tries >= (latestGrant("triesAllowed") ?? MAX_TRIES) || state.checks >= (latestGrant("checksAllowed") ?? EFFORT_CHECK_LIMIT);
      if (owned && !state.passed && !blocking && out && !state.live) {
        const row: Round = {
          round: Math.max(0, ...state.rounds.map((r) => r.round)) + 1,
          status: "denied",
          note: "",
          triesAllowed: state.tries + 1,
          checksAllowed: state.checks + extraChecks,
        };
        state.rounds.push(row);
        return [[{}], [{ tries_allowed: row.triesAllowed, checks_allowed: row.checksAllowed }], [{}]];
      }
      return [[{}], [], [{ owned, not_waiting: state.passed || blocking || !out, live: state.live }]];
    });
    queue = run.then(() => undefined);
    return run;
  };
  return { execute, state };
}

describe("grantExtraTryWith", () => {
  it("grants one more try with no note: a denied round, empty note, tries used + 1, checks used + EXTRA_TRY_CHECKS", async () => {
    const db = fakeDb({ tries: 3, checks: 4 });
    assert.deepEqual(await grantExtraTryWith(INPUT, db.execute), { status: "granted" });
    assert.deepEqual(db.state.rounds, [{ round: 1, status: "denied", note: "", triesAllowed: 4, checksAllowed: 4 + EXTRA_TRY_CHECKS }]);
  });

  it("at the check limit with tries unused: exactly 1 try left too", async () => {
    const db = fakeDb({ tries: 1, checks: EFFORT_CHECK_LIMIT });
    assert.deepEqual(await grantExtraTryWith(INPUT, db.execute), { status: "granted" });
    assert.equal(db.state.rounds[0].triesAllowed, 2);
    assert.equal(db.state.rounds[0].checksAllowed, EFFORT_CHECK_LIMIT + EXTRA_TRY_CHECKS);
  });

  it("after a used one more try (a denied note with a grant, then a failed try): the next round", async () => {
    const db = fakeDb({ tries: 4, checks: 5, rounds: [{ round: 1, status: "denied", note: "I tried.", triesAllowed: 4, checksAllowed: 5 }] });
    assert.deepEqual(await grantExtraTryWith(INPUT, db.execute), { status: "granted" });
    assert.deepEqual(db.state.rounds.map((r) => [r.round, r.triesAllowed]), [[1, 4], [2, 5]]);
  });

  it("no more than the existing rule: a second grant is refused until that try is used", async () => {
    const db = fakeDb();
    assert.equal((await grantExtraTryWith(INPUT, db.execute)).status, "granted");
    assert.deepEqual(await grantExtraTryWith(INPUT, db.execute), { status: "not_waiting" });
    assert.equal(db.state.rounds.length, 1);
  });

  it("20 parallel grants (double-clicks, tabs): exactly one", async () => {
    const db = fakeDb();
    const results = await Promise.all(Array.from({ length: 20 }, () => grantExtraTryWith(INPUT, db.execute)));
    assert.equal(results.filter((r) => r.status === "granted").length, 1);
    assert.equal(results.filter((r) => r.status === "not_waiting").length, 19);
    assert.equal(db.state.rounds.length, 1);
  });

  it("refuses when not out of tries with no note, and changes nothing", async () => {
    const cases: [string, Parameters<typeof fakeDb>[0]][] = [
      ["tries left", { tries: 2, checks: 2 }],
      ["passed", { passed: true }],
      ["note open", { rounds: [{ round: 1, status: "open", note: "Hi", triesAllowed: null, checksAllowed: null }] }],
      ["note denied, no try", { rounds: [{ round: 1, status: "denied", note: "Hi", triesAllowed: null, checksAllowed: null }] }],
      ["note accepted", { rounds: [{ round: 1, status: "approved", note: "Hi", triesAllowed: null, checksAllowed: null }] }],
      ["one more try not used yet", { tries: 3, checks: 3, rounds: [{ round: 1, status: "denied", note: "", triesAllowed: 4, checksAllowed: 5 }] }],
    ];
    for (const [name, init] of cases) {
      const db = fakeDb(init);
      const before = JSON.stringify(db.state.rounds);
      assert.deepEqual(await grantExtraTryWith(INPUT, db.execute), { status: "not_waiting" }, name);
      assert.equal(JSON.stringify(db.state.rounds), before, name);
    }
  });

  it("waits while an effort check is running (busy), and changes nothing", async () => {
    const db = fakeDb({ checks: EFFORT_CHECK_LIMIT, tries: 1, live: true });
    assert.deepEqual(await grantExtraTryWith(INPUT, db.execute), { status: "busy" });
    assert.equal(db.state.rounds.length, 0);
  });

  it("another teacher, another class, a student or reading not in the class, or an unpublished reading: not found, nothing changes", async () => {
    const inputs: GrantInput[] = [
      { ...INPUT, teacherId: "t2" },
      { ...INPUT, classId: "c2" },
      { ...INPUT, studentId: "s9" },
      { ...INPUT, readingId: "r9" },
    ];
    for (const input of inputs) {
      const db = fakeDb();
      assert.deepEqual(await grantExtraTryWith(input, db.execute), { status: "not_found" }, JSON.stringify(input));
      assert.equal(db.state.rounds.length, 0);
    }
    const draft = fakeDb({ published: false });
    assert.deepEqual(await grantExtraTryWith(INPUT, draft.execute), { status: "not_found" });
  });

  it("a duplicate round is not_waiting; other errors propagate (fail closed)", async () => {
    const dup = Object.assign(new Error("dup"), { code: "23505", constraint: CHALLENGE_UNIQUE_CONSTRAINT });
    assert.deepEqual(await grantExtraTryWith(INPUT, async () => { throw dup; }), { status: "not_waiting" });
    await assert.rejects(grantExtraTryWith(INPUT, async () => { throw new Error("db down"); }), /db down/);
  });
});

describe("the grant row fits the schema as it is", () => {
  const sql = readdirSync(new URL("../../drizzle/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(new URL(`../../drizzle/${f}`, import.meta.url), "utf8"))
    .join("\n");

  it("note is NOT NULL with no length check, so an empty note is allowed", () => {
    assert.match(sql, /"note" text NOT NULL,/);
    assert.doesNotMatch(sql, /CHECK \([^)]*"note"/);
  });

  it("a grant needs both limits and status denied (challenges_grant_check), and the insert sets all three", () => {
    assert.match(sql, /"challenges_grant_check" CHECK \(\("challenges"\."tries_allowed" is null\) = \("challenges"\."checks_allowed" is null\) and \("challenges"\."tries_allowed" is null or "challenges"\."status" = 'denied'\)\)/);
    const [, insert] = grantStatements(INPUT);
    assert.match(insert.text, /'denied', now\(\), \$3::uuid,\s+\(select count/);
  });

  it("a student's own note is never empty, so an empty note always means a teacher's grant", () => {
    assert.equal(validateChallengeNote("").ok, false);
    assert.equal(validateChallengeNote("   ").ok, false);
  });
});

describe("Give one more try on the queue", () => {
  const queue = readFileSync(new URL("../app/teacher/classes/[id]/challenges/queue.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../app/teacher/classes/[id]/challenges/actions.ts", import.meta.url), "utf8");
  const row = queue.slice(queue.indexOf("function NoNoteRow"), queue.indexOf("function ChallengeCard"));

  it("is a secondary 48px button on the no-note row, with who and which reading for screen readers", () => {
    assert.equal(GIVE_EXTRA_TRY_LABEL, "Give one more try");
    assert.equal(GIVE_EXTRA_TRY_PENDING, "Giving…");
    assert.match(row, /<button type="submit" disabled=\{pending\} className=\{`\$\{secondaryButtonDisabled\} self-start`\}>/);
    assert.match(row, /\{pending \? GIVE_EXTRA_TRY_PENDING : GIVE_EXTRA_TRY_LABEL\}/);
    assert.match(row, /<span className="sr-only">\s*\{" "\}\s*for \{item\.studentName\} on \{item\.readingTitle\}\s*<\/span>/);
    assert.match(row, /name="studentId" value=\{item\.studentId\}/);
    assert.match(row, /name="readingId" value=\{item\.readingId\}/);
    const button = row.slice(row.indexOf("<button"), row.indexOf("</button>"));
    assert.doesNotMatch(button, /danger|warning|red-|amber/);
  });

  it("announces in the queue's live region and moves focus, unless the row stays (busy)", () => {
    assert.match(row, /onDecided\(grantMessage\(next\.result, item\.studentName\), next\.result\.status === "busy"\)/);
    assert.match(row, /<ErrorMessage>\{state\.key === key \? state\.error : ""\}<\/ErrorMessage>/);
  });

  it("the action checks the teacher on the server and refreshes the queue and the class", () => {
    const action = actions.slice(actions.indexOf("export async function giveExtraTryAction"));
    assert.match(action, /const teacher = await getOrCreateTeacher\(\);/);
    assert.match(action, /grantExtraTry\(\{ classId, teacherId: teacher\.id, studentId, readingId \}\)/);
    assert.match(action, /revalidatePath\(`\/teacher\/classes\/\$\{classId\}\/challenges`\)/);
    // No ids of a student in the log.
    assert.match(action, /console\.error\("giveExtraTryAction: grant failed", \{ name, code, message, classId \}\)/);
  });

  it("says what happened, with curly apostrophes and no em dashes", () => {
    const results: GrantResult[] = [{ status: "granted" }, { status: "not_waiting" }, { status: "busy" }, { status: "not_found" }];
    assert.deepEqual(
      results.map((r) => grantMessage(r, "Maya Ro")),
      [
        "One more try given. Maya Ro has 1 more try.",
        "Nothing to change. The list is up to date.",
        "Maya Ro’s answers are still being checked. Try again in a minute.",
        "We couldn’t find that student on that reading. The list is up to date.",
      ],
    );
    for (const r of results) assert.doesNotMatch(grantMessage(r, "Maya Ro"), /'|\u2014/);
  });
});
