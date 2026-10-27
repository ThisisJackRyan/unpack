// Checks that the free plan class limit holds under concurrency, through the
// real neon-http driver and the real insertClassIfAllowed.
//
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-class-limit [flags]
//
// Flags:
//   --n=10         parallel creates per round (default 10)
//   --rounds=20    free plan rounds (default 20)
//   --control      negative control: run a plain READ COMMITTED conditional
//                  insert with no lock instead of the app function, to show
//                  this check can detect the race (expects >1 row sometimes)
//
// Set NEON_FETCH_ENDPOINT (for example https://db.localtest.me:4445/sql) to
// point the driver at a local Neon proxy. Against a Neon dev branch, leave it
// unset. Writes teachers named test_concurrency_<run>_<n> and deletes them
// (and their classes, by cascade) at the end. Never run against production.
import { neonConfig } from "@neondatabase/serverless";
import { getSql } from "@/db";
import { FREE_PLAN_CLASS_LIMIT, insertClassIfAllowed } from "@/lib/classes";
import {
  generateJoinCode,
  isJoinCodeConflict,
  JoinCodeExhaustedError,
} from "@/lib/join-code";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Refusing to run.");
  process.exit(2);
}
if (process.env.ALLOW_DB_WRITES !== "1") {
  console.error(
    "This script writes and deletes rows. Set ALLOW_DB_WRITES=1 to run it.",
  );
  process.exit(2);
}
const fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
if (fetchEndpoint) {
  neonConfig.fetchEndpoint = () => fetchEndpoint;
}

function intFlag(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

const N = intFlag("n", 10);
const ROUNDS = intFlag("rounds", 20);
const CONTROL = process.argv.includes("--control");
const RUN_ID = Math.random().toString(36).slice(2, 10);

const sql = getSql();
let teacherSeq = 0;
const failures: string[] = [];

type ErrorInfo = { name: string; code: unknown; constraint: unknown };

function describe(error: unknown): ErrorInfo {
  const e = error as { name?: unknown; code?: unknown; constraint?: unknown };
  return {
    name: String(e?.name ?? typeof error),
    code: e?.code,
    constraint: e?.constraint,
  };
}

async function createTeacher(plan: "free" | "paid"): Promise<string> {
  const clerkUserId = `test_concurrency_${RUN_ID}_${++teacherSeq}`;
  const rows = await sql`
    insert into teachers (clerk_user_id, email, plan)
    values (${clerkUserId}, 'test@example.invalid', ${plan}::plan)
    returning id
  `;
  return (rows[0] as { id: string }).id;
}

async function classCount(teacherId: string): Promise<number> {
  const rows = await sql`
    select count(*)::int as n from classes where teacher_id = ${teacherId}
  `;
  return (rows[0] as { n: number }).n;
}

// Same conditional insert as the app, as one autocommit statement at READ
// COMMITTED with no lock. Each concurrent statement can count 0 classes.
async function unsafeInsert(teacherId: string): Promise<{ id: string } | undefined> {
  const rows = await sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    select t.id, 'Control class', '4'::grade_level, ${generateJoinCode()}
    from teachers t
    where t.id = ${teacherId}
      and (
        t.plan = 'paid'
        or (select count(*) from classes c where c.teacher_id = t.id)
          < ${FREE_PLAN_CLASS_LIMIT}
      )
    returning id
  `;
  const row = rows[0] as { id: string } | undefined;
  return row && { id: row.id };
}

type RoundResult = {
  rows: number;
  created: number;
  blocked: number;
  thrown: ErrorInfo[];
  retries: ErrorInfo[];
};

async function runRound(plan: "free" | "paid", control: boolean): Promise<RoundResult> {
  const teacherId = await createTeacher(plan);
  const retries: ErrorInfo[] = [];
  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      control
        ? unsafeInsert(teacherId)
        : insertClassIfAllowed(
            teacherId,
            { name: `Concurrency class ${i + 1}`, gradeLevel: "4" },
            { onRetry: (error) => retries.push(describe(error)) },
          ),
    ),
  );
  const result: RoundResult = {
    rows: await classCount(teacherId),
    created: 0,
    blocked: 0,
    thrown: [],
    retries,
  };
  for (const s of settled) {
    if (s.status === "rejected") result.thrown.push(describe(s.reason));
    else if (s.value) result.created++;
    else result.blocked++;
  }
  return result;
}

function summarizeRetries(retries: ErrorInfo[]): string {
  if (retries.length === 0) return "none";
  const byCode = new Map<string, number>();
  for (const r of retries) {
    const key = `${r.name} code=${String(r.code)}`;
    byCode.set(key, (byCode.get(key) ?? 0) + 1);
  }
  return [...byCode].map(([k, v]) => `${v} x ${k}`).join(", ");
}

async function checkFreeLimit(control: boolean): Promise<void> {
  const label = control
    ? "NEGATIVE CONTROL (single statement, READ COMMITTED, no lock)"
    : "FREE PLAN (insertClassIfAllowed)";
  console.log(`\n== ${label}: ${ROUNDS} rounds x ${N} parallel creates ==`);
  const allRetries: ErrorInfo[] = [];
  const allThrown: ErrorInfo[] = [];
  const rowsPerRound: number[] = [];
  let badRounds = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    const r = await runRound("free", control);
    rowsPerRound.push(r.rows);
    allRetries.push(...r.retries);
    allThrown.push(...r.thrown);
    const ok =
      r.rows === FREE_PLAN_CLASS_LIMIT &&
      r.created === FREE_PLAN_CLASS_LIMIT &&
      r.blocked === N - FREE_PLAN_CLASS_LIMIT &&
      r.thrown.length === 0;
    if (!ok) badRounds++;
    console.log(
      `round ${String(round).padStart(2)}: rows=${r.rows} created=${r.created} ` +
        `undefined=${r.blocked} threw=${r.thrown.length} retries=${r.retries.length}` +
        (r.thrown.length ? ` errors=[${summarizeRetries(r.thrown)}]` : "") +
        (ok ? "" : "  <-- not exactly 1 row / 1 created / 0 thrown"),
    );
  }
  const serialization = allRetries.filter((r) => r.code === "40001");
  const escaped40001 = allThrown.filter((r) => r.code === "40001").length;
  console.log(`rows per round: [${rowsPerRound.join(", ")}]`);
  console.log(`rounds with exactly 1 row and no errors: ${ROUNDS - badRounds}/${ROUNDS}`);
  console.log(`retries observed: ${summarizeRetries(allRetries)}`);
  console.log(
    `40001 retries: ${serialization.length}; .code === "40001" intact on caught error: ` +
      (serialization.length ? "yes" : "n/a (none observed)"),
  );
  console.log(`errors thrown to caller: ${summarizeRetries(allThrown)}`);
  console.log(`40001 escaped after retries: ${escaped40001}`);
  if (control) {
    const raced = rowsPerRound.filter((n) => n > FREE_PLAN_CLASS_LIMIT).length;
    console.log(`control: rounds with >1 row (race detected): ${raced}/${ROUNDS}`);
    if (raced === 0) {
      failures.push("negative control never produced >1 row; the check cannot see the race");
    }
  } else if (badRounds > 0) {
    failures.push(`free plan: ${badRounds}/${ROUNDS} rounds did not end with exactly 1 row and no errors`);
  }
}

async function checkPaid(): Promise<void> {
  console.log(`\n== PAID PLAN: ${N} parallel creates ==`);
  const r = await runRound("paid", false);
  console.log(
    `rows=${r.rows} created=${r.created} undefined=${r.blocked} threw=${r.thrown.length} ` +
      `retries=${summarizeRetries(r.retries)}`,
  );
  if (r.rows !== N || r.created !== N || r.thrown.length) {
    failures.push(`paid plan: expected ${N} rows, got ${r.rows} (threw ${r.thrown.length})`);
  }
}

// Forces a join code collision inside sql.transaction to show the 23505 still
// arrives with .code and .constraint through neon-http, and is retried.
async function checkJoinCodeCollision(): Promise<void> {
  console.log("\n== JOIN CODE COLLISION (23505 through sql.transaction) ==");
  const owner = await createTeacher("paid");
  const taken = generateJoinCode();
  await sql`
    insert into classes (teacher_id, name, grade_level, join_code)
    values (${owner}, 'Collision target', '4'::grade_level, ${taken})
  `;

  const teacherId = await createTeacher("free");
  const conflicts: unknown[] = [];
  const codes = [taken];
  const created = await insertClassIfAllowed(
    teacherId,
    { name: "Collision class", gradeLevel: "4" },
    {
      generateJoinCode: () => codes.shift() ?? generateJoinCode(),
      onRetry: (error) => conflicts.push(error),
    },
  );
  const info = conflicts.map(describe);
  console.log(`first code collided, then retried: created=${Boolean(created)} rows=${await classCount(teacherId)}`);
  console.log(`conflict errors seen: ${JSON.stringify(info)}`);
  const intact =
    info.length === 1 &&
    info[0].code === "23505" &&
    info[0].constraint === "classes_join_code_unique" &&
    isJoinCodeConflict(conflicts[0]);
  console.log(`.code and .constraint intact: ${intact ? "yes" : "NO"}`);
  if (!created || !intact || (await classCount(teacherId)) !== 1) {
    failures.push("join code collision was not retried with an intact 23505");
  }

  const exhaustedTeacher = await createTeacher("free");
  let exhausted: unknown;
  try {
    await insertClassIfAllowed(
      exhaustedTeacher,
      { name: "Exhausted class", gradeLevel: "4" },
      { generateJoinCode: () => taken },
    );
  } catch (error) {
    exhausted = error;
  }
  const rows = await classCount(exhaustedTeacher);
  console.log(
    `always colliding: threw ${describe(exhausted).name}, rows=${rows}`,
  );
  if (!(exhausted instanceof JoinCodeExhaustedError) || rows !== 0) {
    failures.push("always-colliding code did not end in JoinCodeExhaustedError with 0 rows");
  }
}

async function cleanup(): Promise<void> {
  const rows = await sql`
    delete from teachers where clerk_user_id like ${`test_concurrency_${RUN_ID}_%`}
    returning id
  `;
  console.log(`\ncleanup: deleted ${rows.length} test teachers (and their classes)`);
}

async function main(): Promise<void> {
  const [info] = await sql`
    select current_setting('server_version') as version,
           current_setting('default_transaction_isolation') as isolation
  `;
  console.log(
    `run ${RUN_ID}: postgres ${info.version}, default isolation ${info.isolation}, ` +
      `n=${N}, rounds=${ROUNDS}, endpoint=${fetchEndpoint ?? "default"}`,
  );
  try {
    if (CONTROL) {
      await checkFreeLimit(true);
    } else {
      await checkFreeLimit(false);
      await checkPaid();
      await checkJoinCodeCollision();
    }
  } finally {
    await cleanup();
  }
  if (failures.length) {
    console.log(`\nFAIL\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((error) => {
  console.error("check-class-limit crashed:", error);
  process.exit(1);
});
