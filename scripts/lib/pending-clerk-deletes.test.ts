import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashClerkUserId } from "@/lib/deleted-accounts";
import {
  CLERK_PAGE_SIZE,
  ClerkListError,
  formatMatchReport,
  formatPendingReport,
  HASH_PREFIX_LENGTH,
  listClerkUserIds,
  matchPendingClerkIds,
  parseOptions,
  type FetchLike,
} from "./pending-clerk-deletes";

const NOW = new Date("2026-10-27T12:00:00Z");
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;
const KEY = "sk_test_secret_value";

// A Clerk user object with everything personal Clerk returns.
function clerkUser(id: string) {
  return {
    id,
    first_name: "Ada",
    last_name: "Child",
    username: "ada2015",
    email_addresses: [{ id: "idn_1", email_address: `${id}@example.invalid` }],
    phone_numbers: [{ phone_number: "+15555550100" }],
    birthday: "2015-03-01",
  };
}

function fakeFetch(pages: unknown[][], seen: string[] = []): FetchLike {
  return async (url, init) => {
    seen.push(`${url} ${init.headers.authorization}`);
    const page = pages.shift() ?? [];
    return { ok: true, status: 200, json: async () => page };
  };
}

function assertNothingPersonal(lines: string[]) {
  const text = lines.join("\n");
  assert.equal(EMAIL_LIKE.test(text), false, text);
  for (const bad of ["Ada", "Child", "ada2015", "+1555", "2015-03-01", KEY]) assert.equal(text.includes(bad), false, `${bad} in ${text}`);
}

describe("parseOptions", () => {
  it("takes only --match-clerk and --help", () => {
    assert.deepEqual(parseOptions([]), { matchClerk: false });
    assert.deepEqual(parseOptions(["--match-clerk"]), { matchClerk: true });
    assert.deepEqual(parseOptions(["--help"]), { help: true });
    for (const bad of [["--delete"], ["--confirm"], ["user_1"]]) assert.ok("error" in parseOptions(bad));
  });
});

describe("formatPendingReport", () => {
  it("prints the count and, per row, a hash prefix and the age, nothing else", () => {
    const rows = [
      { clerk_user_hash: hashClerkUserId("user_a"), deleted_at: new Date("2026-08-01T00:00:00Z") },
      { clerk_user_hash: hashClerkUserId("user_b"), deleted_at: "2026-10-26T11:00:00Z" },
    ];
    const lines = formatPendingReport(rows, NOW);
    assert.equal(lines[0], "2 pending Clerk deletes (hash listed, Clerk's delete not confirmed)");
    assert.equal(lines[1], `  ${hashClerkUserId("user_a").slice(0, HASH_PREFIX_LENGTH)}  listed 2026-08-01, 87 days ago`);
    assert.equal(lines[2], `  ${hashClerkUserId("user_b").slice(0, 12)}  listed 2026-10-26, 1 day ago`);
    for (const line of lines) assert.equal(line.includes(hashClerkUserId("user_a")), false, "never the full hash");
    assertNothingPersonal(lines);
    assert.deepEqual(formatPendingReport([], NOW), ["0 pending Clerk deletes (hash listed, Clerk's delete not confirmed)"]);
  });
});

describe("matching Clerk users to pending rows", () => {
  it("returns exactly the ids whose hash is pending", () => {
    const pending = new Set([hashClerkUserId("user_b"), hashClerkUserId("user_gone")]);
    assert.deepEqual(matchPendingClerkIds(["user_a", "user_b", "user_c"], pending), ["user_b"]);
    // The raw id or an unprefixed hash never matches.
    assert.deepEqual(matchPendingClerkIds(["user_a"], new Set(["user_a"])), []);
    assert.deepEqual(matchPendingClerkIds([], pending), []);
  });

  it("the report prints ids and prefixes only, and the pending rows Clerk no longer has", () => {
    const pending = new Set([hashClerkUserId("user_b"), hashClerkUserId("user_gone")]);
    const lines = formatMatchReport(["user_b"], pending);
    assert.equal(lines[0], "1 Clerk user still exists for a pending row (delete each in the Clerk dashboard):");
    assert.equal(lines[1], `  user_b  (row ${hashClerkUserId("user_b").slice(0, 12)})`);
    assert.equal(lines[2], "1 pending row has no Clerk user (already gone in Clerk; kept, hash only):");
    assert.equal(lines[3], `  ${hashClerkUserId("user_gone").slice(0, 12)}`);
    assertNothingPersonal(lines);
  });
});

describe("listClerkUserIds", () => {
  it("pages until a short page, reads only ids, and sends the key only as the bearer token", async () => {
    const seen: string[] = [];
    const ids = await listClerkUserIds(fakeFetch([[clerkUser("user_1"), clerkUser("user_2")], [clerkUser("user_3")]], seen), KEY, 2);
    assert.deepEqual(ids, ["user_1", "user_2", "user_3"]);
    assert.deepEqual(seen, [
      `https://api.clerk.com/v1/users?limit=2&offset=0&order_by=%2Bcreated_at Bearer ${KEY}`,
      `https://api.clerk.com/v1/users?limit=2&offset=2&order_by=%2Bcreated_at Bearer ${KEY}`,
    ]);
    assert.equal(CLERK_PAGE_SIZE, 500);
  });

  it("accepts a {data: [...]} body, and a full last page ends on the next empty one", async () => {
    const pages: unknown[] = [{ data: [clerkUser("user_1")] }, { data: [] }];
    const fetchFn: FetchLike = async () => ({ ok: true, status: 200, json: async () => pages.shift() });
    assert.deepEqual(await listClerkUserIds(fetchFn, KEY, 1), ["user_1"]);
  });

  it("a failed request throws with the status only (no body, no key)", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ message: "a@b.c" }] }) });
    await assert.rejects(listClerkUserIds(fetchFn, KEY), (error: unknown) => {
      assert.ok(error instanceof ClerkListError);
      assert.equal(error.message, "Clerk users list failed: HTTP 401");
      return true;
    });
  });
});
