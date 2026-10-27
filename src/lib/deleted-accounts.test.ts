import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createAccountStatement,
  DELETED_ACCOUNT_RETENTION_DAYS,
  hashClerkUserId,
  isDeletedStatement,
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
    for (const s of [recordDeletedStatement("user_test_1"), isDeletedStatement("user_test_1")]) {
      assert.deepEqual(s.params, [hash]);
      assert.equal(s.text.includes("user_test_1"), false);
    }
  });

  it("a repeat delete keeps the first time; the prune drops rows past the retention", () => {
    assert.match(recordDeletedStatement("u").text, /on conflict \(clerk_user_hash\) do nothing/);
    const prune = pruneDeletedStatement();
    assert.match(prune.text, /deleted_at < now\(\) - make_interval\(days => \$1::int\)/);
    assert.equal(prune.params[0], DELETED_ACCOUNT_RETENTION_DAYS);
    assert.equal(DELETED_ACCOUNT_RETENTION_DAYS, 30);
  });

  it("the first-visit creation refuses a listed id in the insert itself and never sets a role", () => {
    const s = createAccountStatement("user_test_1", "Maya Ro", "teacher@example.com");
    assert.match(s.text, /^insert into teachers \(clerk_user_id, name, email\)\nselect \$1::text, \$2::text, \$3::text\nwhere not exists \(select 1 from deleted_clerk_users where clerk_user_hash = \$4::text\)\non conflict \(clerk_user_id\) do update set name = excluded\.name, email = excluded\.email\nreturning id$/);
    assert.deepEqual(s.params, ["user_test_1", "Maya Ro", "teacher@example.com", hashClerkUserId("user_test_1")]);
    assert.equal(/role/.test(s.text), false);
  });
});
