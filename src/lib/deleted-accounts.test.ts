import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  accountLockStatement,
  ACCOUNT_LOCK_SPACE,
  confirmClerkDeletedStatement,
  createAccountStatement,
  createAccountStatements,
  DELETED_ACCOUNT_RETENTION_DAYS,
  hashClerkUserId,
  isDeletedStatement,
  pendingClerkDeletesStatement,
  pruneDeletedStatement,
  recordDeletedStatement,
} from "./deleted-accounts";

describe("deleted accounts list", () => {
  it("stores only a prefixed SHA-256 of the Clerk id", () => {
    const hash = hashClerkUserId("user_test_1");
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, createHash("sha256").update("deleted-clerk-user:user_test_1").digest("hex"));
    assert.notEqual(hash, createHash("sha256").update("user_test_1").digest("hex"));
    assert.notEqual(hashClerkUserId("user_test_2"), hash);
    for (const s of [
      recordDeletedStatement("user_test_1", "pending"),
      recordDeletedStatement("user_test_1", "confirmed"),
      confirmClerkDeletedStatement("user_test_1"),
      isDeletedStatement("user_test_1"),
    ]) {
      assert.deepEqual(s.params, [hash]);
      assert.equal(s.text.includes("user_test_1"), false);
    }
  });

  it("pending never touches an existing row; confirmed confirms a pending row and never un-confirms", () => {
    assert.equal(
      recordDeletedStatement("u", "pending").text,
      "insert into deleted_clerk_users (clerk_user_hash) values ($1::text)\non conflict (clerk_user_hash) do nothing",
    );
    assert.equal(
      recordDeletedStatement("u", "confirmed").text,
      "insert into deleted_clerk_users (clerk_user_hash, clerk_deleted_at) values ($1::text, now())\non conflict (clerk_user_hash) do update\nset clerk_deleted_at = coalesce(deleted_clerk_users.clerk_deleted_at, excluded.clerk_deleted_at)",
    );
    // deleted_at is never in the update: a repeat keeps the first time.
    assert.equal(/[\s(,]deleted_at\b/.test(recordDeletedStatement("u", "confirmed").text), false);
    assert.equal(
      confirmClerkDeletedStatement("u").text,
      "update deleted_clerk_users set clerk_deleted_at = now()\nwhere clerk_user_hash = $1::text and clerk_deleted_at is null",
    );
  });

  it("the prune drops only confirmed rows, counted from the confirmation", () => {
    const prune = pruneDeletedStatement();
    assert.match(prune.text, /where clerk_deleted_at is not null\n    and clerk_deleted_at < now\(\) - make_interval\(days => \$1::int\)\n  order by clerk_deleted_at\n/);
    assert.equal(/\bdeleted_at </.test(prune.text.replace(/clerk_deleted_at/g, "")), false);
    assert.equal(prune.params[0], DELETED_ACCOUNT_RETENTION_DAYS);
    assert.equal(DELETED_ACCOUNT_RETENTION_DAYS, 30);
  });

  it("the ops listing reads only pending rows, hash and deleted_at", () => {
    const s = pendingClerkDeletesStatement();
    assert.equal(
      s.text,
      "select clerk_user_hash, deleted_at from deleted_clerk_users\nwhere clerk_deleted_at is null\norder by deleted_at, clerk_user_hash",
    );
    assert.deepEqual(s.params, []);
  });

  it("the first-visit creation refuses a listed id in the insert itself and never sets a role", () => {
    const s = createAccountStatement("user_test_1", "Maya Ro", "teacher@example.com");
    assert.match(s.text, /^insert into teachers \(clerk_user_id, name, email\)\nselect \$1::text, \$2::text, \$3::text\nwhere not exists \(select 1 from deleted_clerk_users where clerk_user_hash = \$4::text\)\non conflict \(clerk_user_id\) do update set name = excluded\.name, email = excluded\.email\nreturning id$/);
    assert.deepEqual(s.params, ["user_test_1", "Maya Ro", "teacher@example.com", hashClerkUserId("user_test_1")]);
    assert.equal(/role/.test(s.text), false);
  });

  it("the first visit takes the id's account lock (by hash, in its own lock space) before the insert", () => {
    const [lock, insert] = createAccountStatements("user_test_1", "Maya Ro", "teacher@example.com");
    assert.deepEqual(lock, accountLockStatement("user_test_1"));
    assert.equal(lock.text, "select pg_advisory_xact_lock($1::int, hashtext($2::text))");
    assert.deepEqual(lock.params, [ACCOUNT_LOCK_SPACE, hashClerkUserId("user_test_1")]);
    assert.equal(ACCOUNT_LOCK_SPACE, 5);
    assert.equal(JSON.stringify(lock).includes("user_test_1"), false);
    assert.deepEqual(insert, createAccountStatement("user_test_1", "Maya Ro", "teacher@example.com"));
  });
});
