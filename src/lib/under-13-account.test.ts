import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteTeacherStatements } from "./clerk-webhook";
import { accountLockStatement, hashClerkUserId } from "./deleted-accounts";
import {
  deleteRolelessAccountStatements,
  deleteUnder13Account,
  retryClerkDelete,
  rolelessDeleteOutcome,
  UNDER_13_DELETE_TAG,
  type RolelessDeleteOutcome,
  type Under13DeleteDeps,
} from "./under-13-account";

const CLERK_ID = "user_test_child_1";
const EMAIL = "child@example.invalid";

function spies(opts: { local?: RolelessDeleteOutcome | Error; clerk?: (Error | null)[] } = {}) {
  const calls = { local: [] as string[], clerk: [] as string[], order: [] as string[] };
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const clerkResults = [...(opts.clerk ?? [])];
  const deps: Under13DeleteDeps = {
    deleteLocal: async (id) => {
      calls.local.push(id);
      calls.order.push("local");
      if (opts.local instanceof Error) throw opts.local;
      return opts.local ?? "deleted";
    },
    deleteClerkUser: async (id) => {
      calls.clerk.push(id);
      calls.order.push("clerk");
      const next = clerkResults.shift();
      if (next) throw next;
    },
    log: (level, message, fields) => logs.push({ level, message, fields }),
  };
  return { deps, calls, logs };
}

function clerkError(status: number): Error {
  return Object.assign(new Error(`Clerk ${status} for ${CLERK_ID} ${EMAIL}`), { name: "ClerkAPIResponseError", status });
}

// Nothing that identifies the child, nor any age answer, in any log line.
function assertSafeLogs(logs: { message: string; fields: Record<string, unknown> }[]) {
  for (const line of logs) {
    const text = JSON.stringify(line);
    for (const bad of [CLERK_ID, hashClerkUserId(CLERK_ID), EMAIL, "2015", "birth", "month", "year"]) {
      assert.equal(text.includes(bad), false, `log line has ${bad}: ${text}`);
    }
    assert.equal(line.message, UNDER_13_DELETE_TAG);
  }
}

describe("deleteRolelessAccountStatements", () => {
  it("is the webhook's delete, step for step, limited to a row with no role", () => {
    const texts = deleteRolelessAccountStatements(CLERK_ID).map((s) => s.text);
    const webhook = deleteTeacherStatements(CLERK_ID).map((s) => s.text);
    assert.equal(texts.length, webhook.length);
    assert.deepEqual(deleteRolelessAccountStatements(CLERK_ID)[0], accountLockStatement(CLERK_ID));
    assert.equal(texts[1], "select id, role from teachers where clerk_user_id = $1::text for update");
    assert.match(texts[2], /^delete from classes\nwhere teacher_id in \(select id from teachers where clerk_user_id = \$1::text and role is null\)$/);
    assert.match(texts[3], /^delete from self_readings\nwhere account_id in \(select id from teachers where clerk_user_id = \$1::text and role is null\)$/);
    assert.match(texts[4], /^insert into deleted_clerk_users \(clerk_user_hash\)\nselect \$2::text\nwhere not exists \(select 1 from teachers where clerk_user_id = \$1::text and role is not null\)\non conflict \(clerk_user_hash\) do nothing$/);
    assert.equal(texts[5], webhook[5]);
    assert.equal(texts[6], "delete from teachers where clerk_user_id = $1::text and role is null returning id");
  });

  it("lists only the hash, and never puts the id in the SQL text", () => {
    const statements = deleteRolelessAccountStatements(CLERK_ID);
    assert.deepEqual(statements[4].params, [CLERK_ID, hashClerkUserId(CLERK_ID)]);
    for (const s of statements) assert.equal(s.text.includes(CLERK_ID), false);
  });

  it("reads the outcome: has_role from the locked row, else the account delete's rows", () => {
    assert.equal(rolelessDeleteOutcome([[{}], [{ id: "t", role: "teacher" }], [], [], [], [], []]), "has_role");
    assert.equal(rolelessDeleteOutcome([[{}], [{ id: "t", role: "self_learner" }], [], [], [], [], []]), "has_role");
    assert.equal(rolelessDeleteOutcome([[{}], [{ id: "t", role: null }], [], [], [], [], [{ id: "t" }]]), "deleted");
    assert.equal(rolelessDeleteOutcome([[{}], [], [], [], [], [], []]), "already_gone");
    assert.equal(rolelessDeleteOutcome([]), "already_gone");
  });
});

describe("deleteUnder13Account", () => {
  it("deletes locally first, then in Clerk, both with the account's Clerk id", async () => {
    const { deps, calls, logs } = spies();
    assert.equal(await deleteUnder13Account(CLERK_ID, deps), "deleted");
    assert.deepEqual(calls.order, ["local", "clerk"]);
    assert.deepEqual(calls.local, [CLERK_ID]);
    assert.deepEqual(calls.clerk, [CLERK_ID]);
    assert.deepEqual(logs, [{ level: "info", message: UNDER_13_DELETE_TAG, fields: { local: "deleted", clerk: "deleted" } }]);
    assertSafeLogs(logs);
  });

  it("still deletes in Clerk when there was no row (already_gone)", async () => {
    const { deps, calls } = spies({ local: "already_gone" });
    assert.equal(await deleteUnder13Account(CLERK_ID, deps), "deleted");
    assert.deepEqual(calls.clerk, [CLERK_ID]);
  });

  it("never touches an account that has a role: Clerk isn't called", async () => {
    const { deps, calls, logs } = spies({ local: "has_role" });
    assert.equal(await deleteUnder13Account(CLERK_ID, deps), "has_role");
    assert.deepEqual(calls.clerk, []);
    assert.deepEqual(logs[0].fields, { local: "has_role", clerk: "skipped" });
    assertSafeLogs(logs);
  });

  it("fail safe: a local failure still deletes in Clerk (the webhook then removes the row)", async () => {
    const pgError = Object.assign(new Error(`duplicate ${EMAIL}`), { name: "NeonDbError", code: "40001" });
    const { deps, calls, logs } = spies({ local: pgError });
    assert.equal(await deleteUnder13Account(CLERK_ID, deps), "deleted");
    assert.deepEqual(calls.clerk, [CLERK_ID]);
    assert.equal(logs[0].level, "error");
    assert.deepEqual(logs[0].fields, { local: "failed", clerk: "deleted", localError: { name: "NeonDbError", code: "40001", status: undefined } });
    assertSafeLogs(logs);
  });

  it("fail safe: a Clerk failure is tried once more, then logged as an error with no id", async () => {
    const once = spies({ clerk: [clerkError(500)] });
    assert.equal(await deleteUnder13Account(CLERK_ID, once.deps), "deleted");
    assert.equal(once.calls.clerk.length, 2);
    assert.equal(once.logs[0].level, "info");

    const twice = spies({ clerk: [clerkError(500), clerkError(503)] });
    assert.equal(await deleteUnder13Account(CLERK_ID, twice.deps), "deleted");
    assert.equal(twice.calls.clerk.length, 2);
    assert.equal(twice.logs[0].level, "error");
    assert.deepEqual(twice.logs[0].fields, {
      local: "deleted",
      clerk: "failed",
      clerkError: { name: "ClerkAPIResponseError", code: undefined, status: 503 },
    });
    assertSafeLogs(twice.logs);
  });

  it("a 404 from Clerk means already gone: done, no retry", async () => {
    const { deps, calls, logs } = spies({ clerk: [clerkError(404)] });
    assert.equal(await deleteUnder13Account(CLERK_ID, deps), "deleted");
    assert.equal(calls.clerk.length, 1);
    assert.equal(logs[0].level, "info");
  });
});

describe("retryClerkDelete", () => {
  it("deletes in Clerk with the id, logs the tag only, and never throws", async () => {
    const ok = spies();
    await retryClerkDelete(CLERK_ID, ok.deps);
    assert.deepEqual(ok.calls.clerk, [CLERK_ID]);
    assert.deepEqual(ok.logs[0].fields, { retry: "deleted" });

    const failed = spies({ clerk: [clerkError(500)] });
    await retryClerkDelete(CLERK_ID, failed.deps);
    assert.equal(failed.logs[0].level, "error");
    assertSafeLogs([...ok.logs, ...failed.logs]);

    const gone = spies({ clerk: [clerkError(404)] });
    await retryClerkDelete(CLERK_ID, gone.deps);
    assert.deepEqual(gone.logs, []);
  });
});
