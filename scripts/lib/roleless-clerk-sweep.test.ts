import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { hashClerkUserId } from "@/lib/deleted-accounts";
import type { RolelessDeleteOutcome } from "@/lib/under-13-account";
import { clerkUserRef, listClerkUserIds, listClerkUsers, type FetchLike } from "./pending-clerk-deletes";
import {
  DEFAULT_LIMIT,
  DEFAULT_MIN_AGE_DAYS,
  MAX_LIMIT,
  MIN_AGE_FLOOR_DAYS,
  NO_ROW_SHARE_MAX,
  NO_ROW_SHARE_MIN_AGED,
  candidatesDigest,
  clerkKeyType,
  describeDatabaseUrl,
  environmentRefusal,
  kindTotalsLine,
  olderThan,
  parseOptions,
  pickCandidates,
  runSweep,
  sweepLookupStatements,
  sweepShapeRefusal,
  type Candidate,
  type Environment,
  type ListedRow,
  type Options,
  type RoleRow,
  type SweepDeps,
} from "./roleless-clerk-sweep";

const NOW = new Date("2026-10-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const KEY = "sk_test_secret_value";
const DB_PASSWORD = "hunter2-db-password";
const DB_URL = `postgres://sweeper:${DB_PASSWORD}@localhost:5432/unpack_test?sslmode=require`;
const INSTANCE = { id: "ins_test123", environment_type: "development" };
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;

// A Clerk user object with everything personal Clerk returns. Never
// signed in or active unless `seen` gives the days since.
function clerkUser(id: string, ageDays: number, seen: { signInDays?: number; activeDays?: number } = {}) {
  const ago = (days: number | undefined) => (days === undefined ? null : NOW.getTime() - days * DAY);
  return {
    id,
    created_at: NOW.getTime() - ageDays * DAY,
    last_sign_in_at: ago(seen.signInDays),
    last_active_at: ago(seen.activeDays),
    first_name: "Ada",
    last_name: "Child",
    username: "ada2015",
    email_addresses: [{ id: "idn_1", email_address: `${id}@example.invalid` }],
    phone_numbers: [{ phone_number: "+15555550100" }],
    birthday: "2015-03-01",
    public_metadata: { note: "secret-metadata" },
  };
}

function assertNothingPersonal(lines: string[]) {
  const text = lines.join("\n");
  assert.equal(EMAIL_LIKE.test(text), false, text);
  for (const bad of ["Ada", "Child", "ada2015", "+1555", "2015-03-01", "secret-metadata", KEY, DB_PASSWORD, "sweeper", "secret_value"]) {
    assert.equal(text.includes(bad), false, `${bad} in ${text}`);
  }
}

type Call = { url: string; method: string; auth: string };

// A fake Clerk: GET /v1/instance answers `instance`; GET /v1/users pages
// through `users`; DELETE /v1/users/{id} answers with deleteStatus(id)
// (200 by default). Every call is recorded.
function fakeClerk(users: unknown[], deleteStatus: (id: string) => number = () => 200, instance: unknown = INSTANCE) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, auth: init.headers.authorization });
    if (method === "DELETE") {
      const status = deleteStatus(decodeURIComponent(url.split("/").pop() ?? ""));
      return { ok: status >= 200 && status < 300, status, json: async () => ({ errors: [{ message: "x@y.z" }] }) };
    }
    if (url === "https://api.clerk.com/v1/instance") return { ok: true, status: 200, json: async () => instance };
    const params = new URL(url).searchParams;
    const offset = Number(params.get("offset"));
    const limit = Number(params.get("limit"));
    return { ok: true, status: 200, json: async () => users.slice(offset, offset + limit) };
  };
  return {
    fetchFn,
    calls,
    deletes: () => calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.url.split("/").pop() ?? "")),
    listed: () => calls.some((c) => c.url.startsWith("https://api.clerk.com/v1/users?")),
  };
}

// A fake database: role rows by id, listed hashes, and the local delete's
// outcome per id (a role can be "saved" between lookup and delete).
function fakeDb(roles: Record<string, string | null>, listed: Record<string, boolean> = {}) {
  const deletedLocal: string[] = [];
  const confirmed: string[] = [];
  const lookups: string[][] = [];
  const db = {
    roles,
    deps: {
      lookup: async (ids: readonly string[]) => {
        lookups.push([...ids]);
        const roleRows: RoleRow[] = ids.filter((id) => id in db.roles).map((id) => ({ clerk_user_id: id, role: db.roles[id] }));
        const listedRows: ListedRow[] = ids
          .map(hashClerkUserId)
          .filter((h) => h in listed)
          .map((h) => ({ clerk_user_hash: h, confirmed: listed[h] }));
        return { roleRows, listed: listedRows };
      },
      deleteLocal: async (id: string): Promise<RolelessDeleteOutcome> => {
        const role = db.roles[id];
        if (role !== undefined && role !== null) return "has_role";
        deletedLocal.push(id);
        const had = id in db.roles;
        delete db.roles[id];
        return had ? "deleted" : "already_gone";
      },
      confirmClerkDeleted: async (id: string) => {
        confirmed.push(id);
      },
    },
    deletedLocal,
    confirmed,
    lookups,
  };
  return db;
}

function deps(clerk: ReturnType<typeof fakeClerk>, db: ReturnType<typeof fakeDb>, lines: string[]): SweepDeps {
  return { fetchFn: clerk.fetchFn, secretKey: KEY, databaseUrl: DB_URL, ...db.deps, print: (line) => lines.push(line), now: NOW, pageSize: 2 };
}

const EXPECT = { expectDb: { host: "localhost", name: "unpack_test" }, expectInstance: "ins_test123" };
const DRY: Options = { apply: false, minAgeDays: DEFAULT_MIN_AGE_DAYS, limit: DEFAULT_LIMIT, ...EXPECT, expectCount: null, expectIds: null };
const digestOf = (ids: string[]) => candidatesDigest(ids.map((id) => ({ id })) as Candidate[]);
// --apply with --expect-count and --expect-ids for exactly these
// candidate ids.
const apply = (ids: string[]): Options => ({ ...DRY, apply: true, expectCount: ids.length, expectIds: digestOf(ids) });
const EXPECT_ARGS = ["--expect-db=localhost/unpack_test", "--expect-instance=ins_test123"];
const ENV_LINES = ["Clerk: instance ins_test123 (development), key type sk_test.", "Database: host localhost, database unpack_test."];
const ok = (r: Partial<SweepResultLike>) => ({ checked: 0, candidates: 0, deleted: 0, skippedHasRole: 0, stoppedStatus: null, aborted: null, ...r });
type SweepResultLike = Awaited<ReturnType<typeof runSweep>>;

describe("parseOptions", () => {
  const base = { ...EXPECT, expectCount: null, expectIds: null };
  const IDS = "--expect-ids=0123456789ab";

  it("is a dry run by default", () => {
    assert.deepEqual(parseOptions(EXPECT_ARGS), { apply: false, minAgeDays: 7, limit: 25, ...base });
    assert.deepEqual(parseOptions(["--help"]), { help: true });
  });

  it("takes --apply with --expect-count, --min-age-days, and --limit", () => {
    assert.deepEqual(parseOptions([...EXPECT_ARGS, "--apply", "--expect-count=3", IDS]), {
      apply: true,
      minAgeDays: 7,
      limit: 25,
      ...base,
      expectCount: 3,
      expectIds: "0123456789ab",
    });
    assert.deepEqual(parseOptions(["--min-age-days=30", "--limit=3", "--apply", "--expect-count=0", IDS, ...EXPECT_ARGS]), {
      apply: true,
      minAgeDays: 30,
      limit: 3,
      ...base,
      expectCount: 0,
      expectIds: "0123456789ab",
    });
    assert.deepEqual(parseOptions([...EXPECT_ARGS, "--min-age-days=7"]), { apply: false, minAgeDays: 7, limit: 25, ...base });
    assert.deepEqual(parseOptions([...EXPECT_ARGS, `--limit=${MAX_LIMIT}`]), { apply: false, minAgeDays: 7, limit: MAX_LIMIT, ...base });
  });

  it("--expect-db and --expect-instance are required, and checked for shape", () => {
    assert.ok("error" in parseOptions([]));
    assert.ok("error" in parseOptions(["--expect-db=localhost/unpack_test"]));
    assert.ok("error" in parseOptions(["--expect-instance=ins_test123"]));
    for (const bad of ["localhost", "/unpack", "localhost/", "a/b/c", "host name/db", ""]) {
      assert.ok("error" in parseOptions([`--expect-db=${bad}`, "--expect-instance=ins_test123"]), bad);
    }
    for (const bad of ["", "test123", "ins_", "ins_a-b", "sk_test_abc"]) {
      assert.ok("error" in parseOptions(["--expect-db=localhost/unpack_test", `--expect-instance=${bad}`]), bad);
    }
    const parsed = parseOptions(["--expect-db=EP-Host.Neon.tech/unpack", "--expect-instance=ins_test123"]);
    assert.ok(!("error" in parsed) && !("help" in parsed) && parsed.expectDb.host === "ep-host.neon.tech");
  });

  it("--apply needs --expect-count, and --expect-count needs --apply", () => {
    assert.ok("error" in parseOptions([...EXPECT_ARGS, "--apply", IDS]));
    assert.ok("error" in parseOptions([...EXPECT_ARGS, "--expect-count=3"]));
    for (const bad of ["", "-1", "1.5", "x"]) assert.ok("error" in parseOptions([...EXPECT_ARGS, "--apply", IDS, `--expect-count=${bad}`]), bad);
  });

  it("--apply needs --expect-ids (the dry run's 12-character digest), and --expect-ids needs --apply", () => {
    const missing = parseOptions([...EXPECT_ARGS, "--apply", "--expect-count=3"]);
    assert.ok("error" in missing && missing.error.startsWith("--apply needs --expect-ids=<digest>"));
    assert.ok("error" in parseOptions([...EXPECT_ARGS, IDS]));
    for (const bad of ["", "0123456789a", "0123456789abc", "0123456789AB", "0123456789ag", "x"]) {
      assert.ok("error" in parseOptions([...EXPECT_ARGS, "--apply", "--expect-count=3", `--expect-ids=${bad}`]), bad);
    }
    assert.ok("error" in parseOptions([...EXPECT_ARGS, "--apply", "--expect-count=3", IDS, IDS]));
  });

  it(`never goes under the ${MIN_AGE_FLOOR_DAYS} day floor, and refuses a bad number`, () => {
    assert.equal(MIN_AGE_FLOOR_DAYS, 7);
    for (const bad of ["0", "1", "6", "-1", "0.5", "7.5", "", "abc", "1e3", " 8"]) {
      assert.ok("error" in parseOptions([...EXPECT_ARGS, `--min-age-days=${bad}`]), bad);
    }
    for (const bad of ["0", "-1", "2.5", "", String(MAX_LIMIT + 1), "x"]) assert.ok("error" in parseOptions([...EXPECT_ARGS, `--limit=${bad}`]), bad);
  });

  it("refuses unknown and repeated arguments", () => {
    for (const bad of [
      ["--delete"],
      ["--apply=1"],
      ["--confirm"],
      ["user_1"],
      ["--min-age-days"],
      ["--limit"],
      ["--apply", "--apply"],
      ["--limit=2", "--limit=3"],
      ["--expect-db=localhost/a"],
      ["--expect-instance=ins_other"],
    ]) {
      assert.ok("error" in parseOptions([...EXPECT_ARGS, ...bad]), bad.join(" "));
    }
  });
});

describe("environment guard", () => {
  const env = (over: Partial<Environment> = {}): Environment => ({
    keyType: "sk_test",
    instance: { id: "ins_test123", environmentType: "development" },
    database: { host: "localhost", name: "unpack_test" },
    testDatabase: true,
    ...over,
  });
  const live = (over: Partial<Environment> = {}) =>
    env({ keyType: "sk_live", instance: { id: "ins_prod9", environmentType: "production" }, database: { host: "ep-x.neon.tech", name: "unpack" }, testDatabase: false, ...over });
  const liveExpect = { expectDb: { host: "ep-x.neon.tech", name: "unpack" }, expectInstance: "ins_prod9" };

  it("reads the key type from the prefix and the database without credentials", () => {
    assert.equal(clerkKeyType("sk_live_abc"), "sk_live");
    assert.equal(clerkKeyType("sk_test_abc"), "sk_test");
    assert.equal(clerkKeyType("pk_live_abc"), null);
    assert.deepEqual(describeDatabaseUrl(DB_URL), { host: "localhost", name: "unpack_test" });
    assert.deepEqual(describeDatabaseUrl("postgresql://u:p@EP-X.neon.tech/unpack"), { host: "ep-x.neon.tech", name: "unpack" });
    assert.equal(describeDatabaseUrl("postgres://u:p@host"), null);
    assert.equal(describeDatabaseUrl("https://host/db"), null);
    assert.equal(describeDatabaseUrl("not a url"), null);
  });

  it("a matching pair passes, live or test", () => {
    assert.equal(environmentRefusal(env(), EXPECT), null);
    assert.equal(environmentRefusal(live(), liveExpect), null);
    assert.equal(environmentRefusal(live({ instance: { id: "ins_prod9", environmentType: "staging" } }), liveExpect), null);
  });

  it("refuses a live/test mismatch, whatever the expect flags say", () => {
    assert.match(environmentRefusal(env({ instance: { id: "ins_test123", environmentType: "production" } }), EXPECT) ?? "", /Live\/test mismatch/);
    assert.match(environmentRefusal(live({ instance: { id: "ins_prod9", environmentType: "development" } }), liveExpect) ?? "", /Live\/test mismatch/);
    // A live key with a local or test database: the dangerous one (every
    // production Clerk user would look role-less).
    assert.match(environmentRefusal(live({ database: { host: "localhost", name: "unpack" }, testDatabase: true }), { ...liveExpect, expectDb: { host: "localhost", name: "unpack" } }) ?? "", /sk_live key with a local or test database/);
    assert.match(environmentRefusal(env({ database: { host: "ep-x.neon.tech", name: "unpack" }, testDatabase: false }), { ...EXPECT, expectDb: { host: "ep-x.neon.tech", name: "unpack" } }) ?? "", /sk_test key with a database that is not/);
    assert.ok(environmentRefusal(env({ keyType: null }), EXPECT));
    assert.ok(environmentRefusal(env({ database: null }), EXPECT));
  });

  it("refuses a database or instance other than the expected one", () => {
    assert.match(environmentRefusal(env(), { ...EXPECT, expectDb: { host: "localhost", name: "unpack_test2" } }) ?? "", /Database mismatch/);
    assert.match(environmentRefusal(env(), { ...EXPECT, expectDb: { host: "127.0.0.1", name: "unpack_test" } }) ?? "", /Database mismatch/);
    assert.match(environmentRefusal(env(), { ...EXPECT, expectInstance: "ins_other" }) ?? "", /Clerk instance mismatch/);
  });
});

describe("shape guard", () => {
  const at = NOW.getTime() - 10 * DAY;
  const users = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `user_${i}`, createdAt: at, lastSeenAt: at }));
  const rows = (n: number): RoleRow[] => Array.from({ length: n }, (_, i) => ({ clerk_user_id: `user_${i}`, role: "teacher" }));

  it("nothing aged: nothing to judge", () => {
    assert.equal(sweepShapeRefusal([], []), null);
  });

  it("aborts when no aged user has a teachers row, even one", () => {
    assert.match(sweepShapeRefusal(users(1), []) ?? "", /None of the 1 aged/);
    assert.match(sweepShapeRefusal(users(40), []) ?? "", /None of the 40 aged/);
    // A row with no role still counts as a match.
    assert.equal(sweepShapeRefusal(users(1), [{ clerk_user_id: "user_0", role: null }]), null);
  });

  it(`aborts over ${NO_ROW_SHARE_MAX * 100}% with no row once ${NO_ROW_SHARE_MIN_AGED} are aged`, () => {
    assert.equal(NO_ROW_SHARE_MAX, 0.5);
    assert.equal(NO_ROW_SHARE_MIN_AGED, 10);
    assert.equal(sweepShapeRefusal(users(10), rows(5)), null);
    assert.match(sweepShapeRefusal(users(10), rows(4)) ?? "", /6 of 10 aged Clerk users have no teachers row/);
    // Under 10 aged, only the zero-match rule applies.
    assert.equal(sweepShapeRefusal(users(9), rows(1)), null);
  });
});

describe("clerkUserRef", () => {
  const created = NOW.getTime() - 30 * DAY;

  it("last seen is the latest of created_at, last_sign_in_at and last_active_at", () => {
    const ref = clerkUserRef({ id: "user_1", created_at: created, last_sign_in_at: created + DAY, last_active_at: created + 5 * DAY });
    assert.deepEqual(ref, { id: "user_1", createdAt: created, lastSeenAt: created + 5 * DAY });
    const signIn = clerkUserRef({ id: "user_2", created_at: created, last_sign_in_at: created + 9 * DAY, last_active_at: created + 2 * DAY });
    assert.equal(signIn?.lastSeenAt, created + 9 * DAY);
  });

  it("a null last_* falls back to created_at", () => {
    assert.deepEqual(clerkUserRef({ id: "user_1", created_at: created, last_sign_in_at: null, last_active_at: null }), {
      id: "user_1",
      createdAt: created,
      lastSeenAt: created,
    });
    assert.equal(clerkUserRef({ id: "user_2", created_at: created, last_sign_in_at: null, last_active_at: created + DAY })?.lastSeenAt, created + DAY);
  });

  it("a missing or garbage time is unknown (never old enough)", () => {
    for (const bad of [undefined, "1700000000000", "yesterday", Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
      for (const user of [
        { id: "user_1", created_at: bad, last_sign_in_at: null, last_active_at: null },
        { id: "user_1", created_at: created, last_sign_in_at: bad, last_active_at: null },
        { id: "user_1", created_at: created, last_sign_in_at: null, last_active_at: bad },
      ]) {
        const ref = clerkUserRef(user);
        assert.equal(ref?.lastSeenAt, null, `${String(bad)} in ${JSON.stringify(user)}`);
        assert.deepEqual(olderThan(ref ? [ref] : [], 1, NOW), []);
      }
    }
  });

  it("no id: skipped", () => {
    assert.equal(clerkUserRef({ created_at: created }), null);
    assert.equal(clerkUserRef(null), null);
  });
});

describe("olderThan", () => {
  it("keeps users created and last seen at least N days ago; an unknown time is never old enough", () => {
    const at = (days: number) => NOW.getTime() - days * DAY;
    const users = [
      { id: "user_old", createdAt: at(8), lastSeenAt: at(8) },
      { id: "user_edge", createdAt: at(7), lastSeenAt: at(7) },
      { id: "user_young", createdAt: at(7) + 1, lastSeenAt: at(7) + 1 },
      { id: "user_back", createdAt: at(60), lastSeenAt: at(0) },
      { id: "user_back_edge", createdAt: at(60), lastSeenAt: at(7) + 1 },
      { id: "user_none", createdAt: null, lastSeenAt: null },
      { id: "user_unknown_seen", createdAt: at(60), lastSeenAt: null },
    ];
    assert.deepEqual(olderThan(users, 7, NOW).map((u) => u.id), ["user_old", "user_edge"]);
    assert.deepEqual(olderThan(users, 30, NOW), []);
  });
});

describe("pickCandidates", () => {
  const at = NOW.getTime() - 10 * DAY;
  const users = ["user_none", "user_null", "user_teacher", "user_self", "user_pending", "user_confirmed"].map((id) => ({ id, createdAt: at, lastSeenAt: at }));
  const roleRows: RoleRow[] = [
    { clerk_user_id: "user_null", role: null },
    { clerk_user_id: "user_teacher", role: "teacher" },
    { clerk_user_id: "user_self", role: "self_learner" },
  ];
  const listed: ListedRow[] = [
    { clerk_user_hash: hashClerkUserId("user_pending"), confirmed: false },
    { clerk_user_hash: hashClerkUserId("user_confirmed"), confirmed: true },
  ];

  it("excludes any role row and confirmed deletes; keeps no row, null role, and pending", () => {
    assert.deepEqual(
      pickCandidates(users, roleRows, listed).map((c) => [c.id, c.kind]),
      [
        ["user_none", "no_row"],
        ["user_null", "no_role"],
        ["user_pending", "pending"],
      ],
    );
  });

  it("an aged self-learner is never a candidate, like a teacher", () => {
    const old = NOW.getTime() - 400 * DAY;
    const aged = [{ id: "user_self", createdAt: old, lastSeenAt: old }];
    assert.deepEqual(pickCandidates(aged, [{ clerk_user_id: "user_self", role: "self_learner" }], []), []);
    // Even with its hash listed as pending.
    assert.deepEqual(pickCandidates(aged, [{ clerk_user_id: "user_self", role: "self_learner" }], [{ clerk_user_hash: hashClerkUserId("user_self"), confirmed: false }]), []);
  });

  it("the lookup reads ids and roles by id, and listed rows by hash", () => {
    const [teachers, deleted] = sweepLookupStatements(["user_a", "user_b"]);
    assert.match(teachers.text, /select clerk_user_id, role from teachers where clerk_user_id = any\(\$1::text\[\]\)/);
    assert.equal(/name|email/.test(teachers.text), false);
    assert.deepEqual(teachers.params, [["user_a", "user_b"]]);
    assert.deepEqual(deleted.params, [[hashClerkUserId("user_a"), hashClerkUserId("user_b")]]);
  });
});

describe("dry run summary", () => {
  const candidate = (id: string, kind: Candidate["kind"]): Candidate => ({ id, hash: hashClerkUserId(id), kind, lastSeenAt: 0 });

  it("totals every kind, zeros included", () => {
    assert.equal(
      kindTotalsLine([candidate("a", "no_row"), candidate("b", "no_row"), candidate("c", "no_role")]),
      "By kind: 2 no app row, 1 row with no role, 0 delete pending.",
    );
  });

  it("digests the sorted ids: order free, changes with the set, ids only", () => {
    const ab = candidatesDigest([candidate("user_a", "no_row"), candidate("user_b", "pending")]);
    assert.match(ab, /^[0-9a-f]{12}$/);
    assert.equal(candidatesDigest([candidate("user_b", "no_role"), candidate("user_a", "no_row")]), ab);
    assert.notEqual(candidatesDigest([candidate("user_a", "no_row"), candidate("user_c", "no_row")]), ab);
    assert.equal(ab, createHash("sha256").update("user_a\nuser_b").digest("hex").slice(0, 12));
  });
});

describe("listClerkUsers (shared paging)", () => {
  it("reads only the id and the three times; listClerkUserIds still returns ids only", async () => {
    const clerk = fakeClerk([clerkUser("user_1", 1), clerkUser("user_2", 10, { activeDays: 3 }), clerkUser("user_3", 1)]);
    const users = await listClerkUsers(clerk.fetchFn, KEY, 2);
    assert.deepEqual(users[1], { id: "user_2", createdAt: NOW.getTime() - 10 * DAY, lastSeenAt: NOW.getTime() - 3 * DAY });
    assert.deepEqual(Object.keys(users[0]).sort(), ["createdAt", "id", "lastSeenAt"]);
    assert.deepEqual(await listClerkUserIds(clerk.fetchFn, KEY, 2), ["user_1", "user_2", "user_3"]);
  });
});

describe("runSweep", () => {
  const clerkUsers = () => [
    clerkUser("user_none", 30),
    clerkUser("user_null", 20),
    clerkUser("user_teacher", 20),
    clerkUser("user_young", 2),
    clerkUser("user_back", 60, { signInDays: 1, activeDays: 0 }),
    clerkUser("user_pending", 9, { signInDays: 8 }),
    clerkUser("user_confirmed", 9),
  ];
  const listed = () => ({ [hashClerkUserId("user_pending")]: false, [hashClerkUserId("user_confirmed")]: true });

  it("dry run lists the candidates with id and hash prefix, writes nothing, and sends no DELETE", async () => {
    const clerk = fakeClerk(clerkUsers());
    const db = fakeDb({ user_null: null, user_teacher: "teacher" }, listed());
    const lines: string[] = [];
    const result = await runSweep(DRY, deps(clerk, db, lines));
    assert.deepEqual(clerk.deletes(), []);
    assert.ok(clerk.calls.every((c) => c.method === "GET" && c.auth === `Bearer ${KEY}`));
    assert.deepEqual(db.deletedLocal, []);
    assert.deepEqual(db.confirmed, []);
    // Only the old enough ids are looked up.
    assert.deepEqual(db.lookups, [["user_none", "user_null", "user_teacher", "user_pending", "user_confirmed"]]);
    assert.deepEqual(result, ok({ checked: 7, candidates: 3 }));
    assert.deepEqual(lines, [
      ...ENV_LINES,
      "Checked 7 Clerk users, 5 created and last seen at least 7 days ago.",
      "3 role-less accounts (no teacher or self-learner role):",
      `  user_none  (${hashClerkUserId("user_none").slice(0, 12)})  no app row, last seen 30 days ago`,
      `  user_null  (${hashClerkUserId("user_null").slice(0, 12)})  row with no role, last seen 20 days ago`,
      `  user_pending  (${hashClerkUserId("user_pending").slice(0, 12)})  delete pending, last seen 8 days ago`,
      "By kind: 1 no app row, 1 row with no role, 1 delete pending.",
      `Id digest: ${candidatesDigest([{ id: "user_pending" }, { id: "user_none" }, { id: "user_null" }] as Candidate[])} (sha256 of the sorted Clerk ids, first 12 characters).`,
      "Dry run: nothing deleted. --apply would delete up to 3 of these, oldest first (--limit=25).",
      "To apply, check the list above, then run with the same DATABASE_URL and CLERK_SECRET_KEY:",
      `  pnpm ops:sweep-roleless-clerk-users --apply --expect-db=localhost/unpack_test --expect-instance=ins_test123 --min-age-days=7 --limit=25 --expect-count=3 --expect-ids=${digestOf(["user_none", "user_null", "user_pending"])}`,
    ]);
    assertNothingPersonal(lines);
  });

  it("apply deletes only the candidates, locally first, then in Clerk, then confirms", async () => {
    const clerk = fakeClerk(clerkUsers());
    const db = fakeDb({ user_null: null, user_teacher: "teacher" }, listed());
    const lines: string[] = [];
    const result = await runSweep(apply(["user_none", "user_null", "user_pending"]), deps(clerk, db, lines));
    const expected = ["user_none", "user_null", "user_pending"];
    assert.deepEqual(clerk.deletes(), expected);
    assert.ok(clerk.calls.filter((c) => c.method === "DELETE").every((c) => c.url.startsWith("https://api.clerk.com/v1/users/")));
    assert.deepEqual(db.deletedLocal, expected);
    assert.deepEqual(db.confirmed, expected);
    assert.equal(db.roles.user_teacher, "teacher");
    assert.deepEqual(result, ok({ checked: 7, candidates: 3, deleted: 3 }));
    assert.equal(lines.at(-1), "Deleted 3 accounts; 0 skipped (got a role); 0 left for a later run.");
    assertNothingPersonal(lines);
  });

  it("an old account that was recently active is not a candidate (no lookup, no DELETE)", async () => {
    const clerk = fakeClerk([clerkUser("user_back", 90, { signInDays: 40, activeDays: 6 }), clerkUser("user_signin", 90, { signInDays: 2 })]);
    const db = fakeDb({ user_back: null, user_signin: null });
    const lines: string[] = [];
    const result = await runSweep(apply([]), deps(clerk, db, lines));
    assert.deepEqual(db.lookups, []);
    assert.deepEqual(clerk.deletes(), []);
    assert.deepEqual(db.deletedLocal, []);
    assert.equal(result.candidates, 0);
    assert.equal(lines[2], "Checked 2 Clerk users, 0 created and last seen at least 7 days ago.");
  });

  it("a garbage last_* time is never swept", async () => {
    const user = { ...clerkUser("user_odd", 90), last_active_at: "2026-01-01" };
    const clerk = fakeClerk([user]);
    const db = fakeDb({ user_odd: null });
    const result = await runSweep(apply([]), deps(clerk, db, []));
    assert.equal(result.candidates, 0);
    assert.deepEqual(clerk.deletes(), []);
  });

  it("a 404 from Clerk counts as done", async () => {
    const clerk = fakeClerk([clerkUser("user_gone", 10), clerkUser("user_teacher", 10)], () => 404);
    const db = fakeDb({ user_teacher: "teacher" });
    const result = await runSweep(apply(["user_gone"]), deps(clerk, db, []));
    assert.equal(result.deleted, 1);
    assert.deepEqual(db.confirmed, ["user_gone"]);
  });

  it("honors --limit (oldest first)", async () => {
    const clerk = fakeClerk([clerkUser("user_1", 40), clerkUser("user_2", 30), clerkUser("user_3", 20), clerkUser("user_teacher", 20)]);
    const db = fakeDb({ user_teacher: "teacher" });
    const lines: string[] = [];
    const result = await runSweep({ ...apply(["user_1", "user_2", "user_3"]), limit: 2 }, deps(clerk, db, lines));
    assert.deepEqual(clerk.deletes(), ["user_1", "user_2"]);
    assert.equal(result.deleted, 2);
    assert.equal(lines.at(-1), "Deleted 2 accounts; 0 skipped (got a role); 1 left for a later run.");
  });

  it("the re-check skips an account that got a role after the lookup (no Clerk call for it)", async () => {
    const clerk = fakeClerk([clerkUser("user_a", 10), clerkUser("user_b", 10)]);
    const db = fakeDb({ user_a: null });
    const lookup = db.deps.lookup;
    db.deps.lookup = async (ids) => {
      const found = await lookup(ids);
      db.roles.user_a = "teacher"; // finishes /welcome right after the lookup
      return found;
    };
    const lines: string[] = [];
    const result = await runSweep({ ...apply(["user_a", "user_b"]), limit: 1 }, deps(clerk, db, lines));
    assert.deepEqual(clerk.deletes(), ["user_b"]);
    assert.equal(db.roles.user_a, "teacher");
    assert.deepEqual(result, ok({ checked: 2, candidates: 2, deleted: 1, skippedHasRole: 1 }));
    assert.ok(lines.includes(`  skipped user_a  (${hashClerkUserId("user_a").slice(0, 12)}): has a role now, nothing changed`));
  });

  it("apply never deletes an aged self-learner, locally or in Clerk", async () => {
    const clerk = fakeClerk([clerkUser("user_self", 400), clerkUser("user_none", 30)]);
    const db = fakeDb({ user_self: "self_learner" });
    const lines: string[] = [];
    const result = await runSweep(apply(["user_none"]), deps(clerk, db, lines));
    assert.deepEqual(clerk.deletes(), ["user_none"]);
    assert.deepEqual(db.deletedLocal, ["user_none"]);
    assert.equal(db.roles.user_self, "self_learner");
    assert.equal(lines.some((l) => l.includes("user_self")), false);
    assert.deepEqual(result, ok({ checked: 2, candidates: 1, deleted: 1 }));
  });

  it("the re-check skips an account that became a self-learner after the lookup", async () => {
    const clerk = fakeClerk([clerkUser("user_a", 10)]);
    const db = fakeDb({ user_a: null });
    const lookup = db.deps.lookup;
    db.deps.lookup = async (ids) => {
      const found = await lookup(ids);
      db.roles.user_a = "self_learner";
      return found;
    };
    const result = await runSweep(apply(["user_a"]), deps(clerk, db, []));
    assert.deepEqual(clerk.deletes(), []);
    assert.equal(db.roles.user_a, "self_learner");
    assert.deepEqual(result, ok({ checked: 1, candidates: 1, skippedHasRole: 1 }));
  });

  it("stops on the first Clerk error, printing only the status", async () => {
    const clerk = fakeClerk([clerkUser("user_1", 30), clerkUser("user_2", 20), clerkUser("user_3", 10), clerkUser("user_teacher", 10)], (id) =>
      id === "user_2" ? 500 : 200,
    );
    const db = fakeDb({ user_teacher: "teacher" });
    const lines: string[] = [];
    const result = await runSweep(apply(["user_1", "user_2", "user_3"]), deps(clerk, db, lines));
    assert.deepEqual(clerk.deletes(), ["user_1", "user_2"]);
    assert.deepEqual(db.confirmed, ["user_1"]);
    assert.equal(result.stoppedStatus, 500);
    assert.ok(lines.some((l) => l.startsWith("  Clerk delete failed: HTTP 500. Stopped.")));
    assert.equal(lines.join("\n").includes("x@y.z"), false);
    assertNothingPersonal(lines);
  });

  it("a failed list stops before any lookup or delete", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const db = fakeDb({});
    await assert.rejects(runSweep(apply([]), { ...deps(fakeClerk([]), db, []), fetchFn }), /HTTP 401/);
    assert.deepEqual(db.lookups, []);
    assert.deepEqual(db.deletedLocal, []);
    // The instance answers, the users list fails.
    const clerk = fakeClerk([]);
    const listFails: FetchLike = async (url, init) => (url.includes("/v1/users?") ? { ok: false, status: 503, json: async () => ({}) } : clerk.fetchFn(url, init));
    await assert.rejects(runSweep(apply([]), { ...deps(clerk, db, []), fetchFn: listFails }), /HTTP 503/);
    assert.deepEqual(db.lookups, []);
  });

  it("nothing old enough: no lookup at all", async () => {
    const clerk = fakeClerk([clerkUser("user_new", 0)]);
    const db = fakeDb({});
    const result = await runSweep(apply([]), deps(clerk, db, []));
    assert.deepEqual(db.lookups, []);
    assert.equal(result.candidates, 0);
    assert.deepEqual(clerk.deletes(), []);
  });
  // Nothing listed from Clerk, nothing looked up, nothing written, no DELETE.
  function assertUntouched(clerk: ReturnType<typeof fakeClerk>, db: ReturnType<typeof fakeDb>, listedUsers: boolean) {
    assert.equal(clerk.listed(), listedUsers);
    assert.deepEqual(clerk.deletes(), []);
    assert.deepEqual(db.deletedLocal, []);
    assert.deepEqual(db.confirmed, []);
    if (!listedUsers) assert.deepEqual(db.lookups, []);
  }

  it("environment mismatch: prints the pair, then refuses before listing a user", async () => {
    const cases: { name: string; options: Options; over: Partial<SweepDeps>; instance?: unknown; why: RegExp }[] = [
      { name: "wrong --expect-db", options: { ...apply(["user_x"]), expectDb: { host: "localhost", name: "unpack_other" } }, over: {}, why: /Database mismatch/ },
      { name: "wrong --expect-instance", options: { ...apply(["user_x"]), expectInstance: "ins_other" }, over: {}, why: /Clerk instance mismatch/ },
      { name: "live key, test database", options: DRY, over: { secretKey: "sk_live_secret_value" }, instance: { id: "ins_test123", environment_type: "production" }, why: /sk_live key with a local or test database/ },
      { name: "test key, production instance", options: DRY, over: {}, instance: { id: "ins_test123", environment_type: "production" }, why: /Live\/test mismatch/ },
      { name: "unknown key type", options: DRY, over: { secretKey: "secret_value" }, why: /neither/ },
    ];
    for (const c of cases) {
      const clerk = fakeClerk([clerkUser("user_none", 30), clerkUser("user_teacher", 30)], () => 200, c.instance);
      const db = fakeDb({ user_teacher: "teacher" });
      const lines: string[] = [];
      const result = await runSweep(c.options, { ...deps(clerk, db, lines), ...c.over });
      assert.equal(result.aborted, "environment", c.name);
      assert.match(lines.at(-1) ?? "", c.why, c.name);
      assert.match(lines.at(-1) ?? "", /^Refused: .* Nothing changed\.$/, c.name);
      assert.match(lines[0], /^Clerk: instance ins_test123 \(\w+\), key type \w+\.$/, c.name);
      assert.equal(lines[1], "Database: host localhost, database unpack_test.", c.name);
      assertUntouched(clerk, db, false);
      assertNothingPersonal(lines);
    }
  });

  it("a failed instance lookup stops before listing a user", async () => {
    const clerk = fakeClerk([clerkUser("user_none", 30)], () => 200, { id: "not-an-instance" });
    const db = fakeDb({});
    await assert.rejects(runSweep(DRY, deps(clerk, db, [])), /unexpected response shape/);
    assertUntouched(clerk, db, false);
  });

  it("zero match: aged users but none has a teachers row, aborts with nothing changed", async () => {
    const clerk = fakeClerk([clerkUser("user_1", 30), clerkUser("user_2", 20), clerkUser("user_young", 1)]);
    const db = fakeDb({ user_young: "teacher" });
    const lines: string[] = [];
    const result = await runSweep(apply(["user_a", "user_b"]), deps(clerk, db, lines));
    assert.deepEqual(result, ok({ checked: 3, aborted: "shape" }));
    assert.match(lines.at(-1) ?? "", /^Refused: None of the 2 aged Clerk users has a teachers row/);
    assert.equal(lines.some((l) => l.startsWith("  user_")), false);
    assertUntouched(clerk, db, true);
    assertNothingPersonal(lines);
  });

  it("high share: over half of 10 or more aged users with no row aborts with nothing changed", async () => {
    const users = Array.from({ length: 10 }, (_, i) => clerkUser(`user_${i}`, 30));
    const clerk = fakeClerk(users);
    const db = fakeDb({ user_0: "teacher", user_1: "teacher", user_2: "self_learner", user_3: null });
    const lines: string[] = [];
    const result = await runSweep(apply(["user_0", "user_1", "user_2", "user_3", "user_4", "user_5", "user_6"]), deps(clerk, db, lines));
    assert.equal(result.aborted, "shape");
    assert.match(lines.at(-1) ?? "", /6 of 10 aged Clerk users have no teachers row, over the 50% limit/);
    assertUntouched(clerk, db, true);
  });

  it("exactly half with no row proceeds", async () => {
    const users = Array.from({ length: 10 }, (_, i) => clerkUser(`user_${i}`, 30));
    const clerk = fakeClerk(users);
    const db = fakeDb({ user_0: "teacher", user_1: "teacher", user_2: "teacher", user_3: "teacher", user_4: null });
    const result = await runSweep(apply(["user_4", "user_5", "user_6", "user_7", "user_8", "user_9"]), deps(clerk, db, []));
    assert.deepEqual(result, ok({ checked: 10, candidates: 6, deleted: 6 }));
  });

  it("--apply with a different --expect-count aborts before any delete", async () => {
    for (const count of [2, 4]) {
      const clerk = fakeClerk([clerkUser("user_none", 30), clerkUser("user_null", 20), clerkUser("user_teacher", 20), clerkUser("user_x", 20)]);
      const db = fakeDb({ user_null: null, user_teacher: "teacher" });
      const lines: string[] = [];
      const result = await runSweep({ ...apply(["user_none", "user_null", "user_x"]), expectCount: count }, deps(clerk, db, lines));
      assert.deepEqual(result, ok({ checked: 4, candidates: 3, aborted: "count" }));
      assert.equal(lines.at(-1), `Refused: --expect-count=${count}, but this run found 3. Run the dry run again and check the list. Nothing changed.`);
      assertUntouched(clerk, db, true);
      assert.equal(db.roles.user_null, null);
    }
  });

  it("--apply without the matching --expect-ids aborts before any delete, printing only the two digests", async () => {
    const found = digestOf(["user_none", "user_null", "user_x"]);
    // Same count, different accounts (user_y in place of user_x).
    const other = digestOf(["user_none", "user_null", "user_y"]);
    for (const expectIds of [other, "000000000000"]) {
      const clerk = fakeClerk([clerkUser("user_none", 30), clerkUser("user_null", 20), clerkUser("user_teacher", 20), clerkUser("user_x", 20)]);
      const db = fakeDb({ user_null: null, user_teacher: "teacher" });
      const lines: string[] = [];
      const result = await runSweep({ ...apply(["user_none", "user_null", "user_x"]), expectIds }, deps(clerk, db, lines));
      assert.deepEqual(result, ok({ checked: 4, candidates: 3, aborted: "ids" }));
      assert.equal(lines.at(-1), `Refused: --expect-ids=${expectIds}, but this run's ids digest to ${found}. Run the dry run again and check the list. Nothing changed.`);
      assertUntouched(clerk, db, true);
      assert.equal(db.roles.user_null, null);
    }
    // The matching digest applies.
    const clerk = fakeClerk([clerkUser("user_none", 30), clerkUser("user_null", 20), clerkUser("user_teacher", 20), clerkUser("user_x", 20)]);
    const db = fakeDb({ user_null: null, user_teacher: "teacher" });
    const result = await runSweep(apply(["user_none", "user_null", "user_x"]), deps(clerk, db, []));
    assert.deepEqual(result, ok({ checked: 4, candidates: 3, deleted: 3 }));
  });

  it("the printed --apply command parses back to this run's options and count", async () => {
    const clerk = fakeClerk([clerkUser("user_none", 40), clerkUser("user_teacher", 40)]);
    const db = fakeDb({ user_teacher: "teacher" });
    const lines: string[] = [];
    await runSweep({ ...DRY, minAgeDays: 30, limit: 5 }, deps(clerk, db, lines));
    const command = (lines.at(-1) ?? "").trim();
    assert.ok(command.startsWith("pnpm ops:sweep-roleless-clerk-users "), command);
    assert.deepEqual(parseOptions(command.split(" ").slice(2)), { ...apply(["user_none"]), minAgeDays: 30, limit: 5 });
  });

  it("a dry run with no candidates prints no --apply command", async () => {
    const clerk = fakeClerk([clerkUser("user_teacher", 40)]);
    const db = fakeDb({ user_teacher: "teacher" });
    const lines: string[] = [];
    await runSweep(DRY, deps(clerk, db, lines));
    assert.equal(lines.at(-1), "Dry run: nothing deleted, and nothing to apply.");
    assert.equal(lines.some((l) => l.includes("--apply")), false);
  });
});
