import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashClerkUserId } from "@/lib/deleted-accounts";
import type { RolelessDeleteOutcome } from "@/lib/under-13-account";
import { clerkUserRef, listClerkUserIds, listClerkUsers, type FetchLike } from "./pending-clerk-deletes";
import {
  DEFAULT_LIMIT,
  DEFAULT_MIN_AGE_DAYS,
  MAX_LIMIT,
  olderThan,
  parseOptions,
  pickCandidates,
  runSweep,
  sweepLookupStatements,
  type ListedRow,
  type Options,
  type RoleRow,
  type SweepDeps,
} from "./roleless-clerk-sweep";

const NOW = new Date("2026-10-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const KEY = "sk_test_secret_value";
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
  for (const bad of ["Ada", "Child", "ada2015", "+1555", "2015-03-01", "secret-metadata", KEY]) {
    assert.equal(text.includes(bad), false, `${bad} in ${text}`);
  }
}

type Call = { url: string; method: string; auth: string };

// A fake Clerk: GET /v1/users pages through `users`; DELETE /v1/users/{id}
// answers with deleteStatus(id) (200 by default). Every call is recorded.
function fakeClerk(users: unknown[], deleteStatus: (id: string) => number = () => 200) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, auth: init.headers.authorization });
    if (method === "DELETE") {
      const status = deleteStatus(decodeURIComponent(url.split("/").pop() ?? ""));
      return { ok: status >= 200 && status < 300, status, json: async () => ({ errors: [{ message: "x@y.z" }] }) };
    }
    const params = new URL(url).searchParams;
    const offset = Number(params.get("offset"));
    const limit = Number(params.get("limit"));
    return { ok: true, status: 200, json: async () => users.slice(offset, offset + limit) };
  };
  return { fetchFn, calls, deletes: () => calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.url.split("/").pop() ?? "")) };
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
  return { fetchFn: clerk.fetchFn, secretKey: KEY, ...db.deps, print: (line) => lines.push(line), now: NOW, pageSize: 2 };
}

const DRY: Options = { apply: false, minAgeDays: DEFAULT_MIN_AGE_DAYS, limit: DEFAULT_LIMIT };
const APPLY: Options = { ...DRY, apply: true };

describe("parseOptions", () => {
  it("is a dry run by default", () => {
    assert.deepEqual(parseOptions([]), { apply: false, minAgeDays: 7, limit: 25 });
    assert.deepEqual(parseOptions(["--help"]), { help: true });
  });

  it("takes --apply, --min-age-days, and --limit", () => {
    assert.deepEqual(parseOptions(["--apply"]), { apply: true, minAgeDays: 7, limit: 25 });
    assert.deepEqual(parseOptions(["--min-age-days=30", "--limit=3", "--apply"]), { apply: true, minAgeDays: 30, limit: 3 });
    assert.deepEqual(parseOptions(["--min-age-days=1"]), { apply: false, minAgeDays: 1, limit: 25 });
    assert.deepEqual(parseOptions([`--limit=${MAX_LIMIT}`]), { apply: false, minAgeDays: 7, limit: MAX_LIMIT });
  });

  it("never goes under the 1 day floor, and refuses a bad number", () => {
    for (const bad of ["0", "-1", "0.5", "1.5", "", "abc", "1e3", " 2"]) {
      assert.ok("error" in parseOptions([`--min-age-days=${bad}`]), bad);
    }
    for (const bad of ["0", "-1", "2.5", "", String(MAX_LIMIT + 1), "x"]) assert.ok("error" in parseOptions([`--limit=${bad}`]), bad);
  });

  it("refuses unknown and repeated arguments", () => {
    for (const bad of [["--delete"], ["--apply=1"], ["--confirm"], ["user_1"], ["--min-age-days"], ["--limit"], ["--apply", "--apply"], ["--limit=2", "--limit=3"]]) {
      assert.ok("error" in parseOptions(bad), bad.join(" "));
    }
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
    assert.deepEqual(result, { checked: 7, candidates: 3, deleted: 0, skippedHasRole: 0, stoppedStatus: null });
    assert.deepEqual(lines, [
      "Checked 7 Clerk users, 5 created and last seen at least 7 days ago.",
      "3 role-less accounts (no teacher or self-learner role):",
      `  user_none  (${hashClerkUserId("user_none").slice(0, 12)})  no app row, last seen 30 days ago`,
      `  user_null  (${hashClerkUserId("user_null").slice(0, 12)})  row with no role, last seen 20 days ago`,
      `  user_pending  (${hashClerkUserId("user_pending").slice(0, 12)})  delete pending, last seen 8 days ago`,
      "Dry run: nothing deleted. --apply would delete up to 3 of these, oldest first (--limit=25).",
    ]);
    assertNothingPersonal(lines);
  });

  it("apply deletes only the candidates, locally first, then in Clerk, then confirms", async () => {
    const clerk = fakeClerk(clerkUsers());
    const db = fakeDb({ user_null: null, user_teacher: "teacher" }, listed());
    const lines: string[] = [];
    const result = await runSweep(APPLY, deps(clerk, db, lines));
    const expected = ["user_none", "user_null", "user_pending"];
    assert.deepEqual(clerk.deletes(), expected);
    assert.ok(clerk.calls.filter((c) => c.method === "DELETE").every((c) => c.url.startsWith("https://api.clerk.com/v1/users/")));
    assert.deepEqual(db.deletedLocal, expected);
    assert.deepEqual(db.confirmed, expected);
    assert.equal(db.roles.user_teacher, "teacher");
    assert.deepEqual(result, { checked: 7, candidates: 3, deleted: 3, skippedHasRole: 0, stoppedStatus: null });
    assert.equal(lines.at(-1), "Deleted 3 accounts; 0 skipped (got a role); 0 left for a later run.");
    assertNothingPersonal(lines);
  });

  it("an old account that was recently active is not a candidate (no lookup, no DELETE)", async () => {
    const clerk = fakeClerk([clerkUser("user_back", 90, { signInDays: 40, activeDays: 6 }), clerkUser("user_signin", 90, { signInDays: 2 })]);
    const db = fakeDb({ user_back: null, user_signin: null });
    const lines: string[] = [];
    const result = await runSweep(APPLY, deps(clerk, db, lines));
    assert.deepEqual(db.lookups, []);
    assert.deepEqual(clerk.deletes(), []);
    assert.deepEqual(db.deletedLocal, []);
    assert.equal(result.candidates, 0);
    assert.equal(lines[0], "Checked 2 Clerk users, 0 created and last seen at least 7 days ago.");
  });

  it("a garbage last_* time is never swept", async () => {
    const user = { ...clerkUser("user_odd", 90), last_active_at: "2026-01-01" };
    const clerk = fakeClerk([user]);
    const db = fakeDb({ user_odd: null });
    const result = await runSweep(APPLY, deps(clerk, db, []));
    assert.equal(result.candidates, 0);
    assert.deepEqual(clerk.deletes(), []);
  });

  it("a 404 from Clerk counts as done", async () => {
    const clerk = fakeClerk([clerkUser("user_gone", 10)], () => 404);
    const db = fakeDb({});
    const result = await runSweep(APPLY, deps(clerk, db, []));
    assert.equal(result.deleted, 1);
    assert.deepEqual(db.confirmed, ["user_gone"]);
  });

  it("honors --limit (oldest first)", async () => {
    const clerk = fakeClerk([clerkUser("user_1", 40), clerkUser("user_2", 30), clerkUser("user_3", 20)]);
    const db = fakeDb({});
    const lines: string[] = [];
    const result = await runSweep({ ...APPLY, limit: 2 }, deps(clerk, db, lines));
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
    const result = await runSweep({ ...APPLY, limit: 1 }, deps(clerk, db, lines));
    assert.deepEqual(clerk.deletes(), ["user_b"]);
    assert.equal(db.roles.user_a, "teacher");
    assert.deepEqual(result, { checked: 2, candidates: 2, deleted: 1, skippedHasRole: 1, stoppedStatus: null });
    assert.ok(lines.includes(`  skipped user_a  (${hashClerkUserId("user_a").slice(0, 12)}): has a role now, nothing changed`));
  });

  it("apply never deletes an aged self-learner, locally or in Clerk", async () => {
    const clerk = fakeClerk([clerkUser("user_self", 400), clerkUser("user_none", 30)]);
    const db = fakeDb({ user_self: "self_learner" });
    const lines: string[] = [];
    const result = await runSweep(APPLY, deps(clerk, db, lines));
    assert.deepEqual(clerk.deletes(), ["user_none"]);
    assert.deepEqual(db.deletedLocal, ["user_none"]);
    assert.equal(db.roles.user_self, "self_learner");
    assert.equal(lines.some((l) => l.includes("user_self")), false);
    assert.deepEqual(result, { checked: 2, candidates: 1, deleted: 1, skippedHasRole: 0, stoppedStatus: null });
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
    const result = await runSweep(APPLY, deps(clerk, db, []));
    assert.deepEqual(clerk.deletes(), []);
    assert.equal(db.roles.user_a, "self_learner");
    assert.deepEqual(result, { checked: 1, candidates: 1, deleted: 0, skippedHasRole: 1, stoppedStatus: null });
  });

  it("stops on the first Clerk error, printing only the status", async () => {
    const clerk = fakeClerk([clerkUser("user_1", 30), clerkUser("user_2", 20), clerkUser("user_3", 10)], (id) => (id === "user_2" ? 500 : 200));
    const db = fakeDb({});
    const lines: string[] = [];
    const result = await runSweep(APPLY, deps(clerk, db, lines));
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
    await assert.rejects(runSweep(APPLY, { ...deps(fakeClerk([]), db, []), fetchFn }), /HTTP 401/);
    assert.deepEqual(db.lookups, []);
    assert.deepEqual(db.deletedLocal, []);
  });

  it("nothing old enough: no lookup at all", async () => {
    const clerk = fakeClerk([clerkUser("user_new", 0)]);
    const db = fakeDb({});
    const result = await runSweep(APPLY, deps(clerk, db, []));
    assert.deepEqual(db.lookups, []);
    assert.equal(result.candidates, 0);
    assert.deepEqual(clerk.deletes(), []);
  });
});
