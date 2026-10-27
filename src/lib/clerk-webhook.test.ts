import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { hashClerkUserId } from "./deleted-accounts";
import type { Statement } from "./link-rate-limit";
import {
  deletedAccountRows,
  deleteTeacherStatements,
  handleClerkEvent,
  handleClerkWebhookRequest,
  teacherProfile,
  type ClerkEvent,
  type WebhookDeps,
} from "./clerk-webhook";

// The real verifier the route uses (its CommonJS build: plain Node can't
// resolve the ESM build's extensionless imports).
const { verifyWebhook } = createRequire(import.meta.url)("@clerk/nextjs/webhooks") as {
  verifyWebhook: (request: Request, options: { signingSecret: string }) => Promise<ClerkEvent>;
};

// A made-up signing secret, in Clerk's whsec_ format. Not a real key.
const SECRET_BYTES = Buffer.from("unpack-test-signing-secret-0000");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function signed(body: string, secretBytes = SECRET_BYTES, headers: Record<string, string> = {}): Request {
  const id = "msg_test_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Request("https://unpack.example.org/api/webhooks/clerk", {
    method: "POST",
    body,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}`, ...headers },
  });
}

const USER = {
  id: "user_test_1",
  first_name: "Maya",
  last_name: "Ro",
  username: null,
  primary_email_address_id: "idn_2",
  email_addresses: [
    { id: "idn_1", email_address: "old@example.com" },
    { id: "idn_2", email_address: "teacher@example.com" },
  ],
};

function fakeDb(rowsFor: (s: Statement) => Record<string, unknown>[] = () => [{ id: "t1" }]) {
  const seen: Statement[] = [];
  const execute = async (statements: Statement[]) => {
    seen.push(...statements);
    return statements.map(rowsFor);
  };
  return { seen, execute };
}

function deps(overrides: Partial<WebhookDeps> = {}) {
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const db = fakeDb();
  const d: WebhookDeps = {
    secret: SECRET,
    verify: (req, secret) => verifyWebhook(req, { signingSecret: secret }),
    execute: db.execute,
    log: (level, message, fields) => logs.push({ level, message, fields }),
    ...overrides,
  };
  return { d, logs, db };
}

describe("teacherProfile", () => {
  it("takes the name from first and last name, and the primary email", () => {
    assert.deepEqual(teacherProfile(USER), { clerkUserId: "user_test_1", name: "Maya Ro", email: "teacher@example.com" });
  });

  it("falls back to the username, then null, and to the first email with no primary", () => {
    assert.deepEqual(
      teacherProfile({ ...USER, first_name: null, last_name: null, username: "mayaro", primary_email_address_id: null }),
      { clerkUserId: "user_test_1", name: "mayaro", email: "old@example.com" },
    );
    assert.equal((teacherProfile({ ...USER, first_name: "", last_name: null, username: null }) as { name: unknown }).name, null);
  });

  it("is missing email with no address at all, and missing id without one", () => {
    assert.deepEqual(teacherProfile({ ...USER, email_addresses: [] }), { missing: "email" });
    assert.deepEqual(teacherProfile({ ...USER, email_addresses: [{ id: "idn_2", email_address: "" }] }), { missing: "email" });
    assert.deepEqual(teacherProfile({ ...USER, id: undefined }), { missing: "id" });
  });
});

describe("handleClerkEvent", () => {
  it("user.created upserts by clerk_user_id, race-safe with the lazy creation", async () => {
    const db = fakeDb();
    assert.equal(await handleClerkEvent({ type: "user.created", data: USER }, db.execute), "upserted");
    assert.equal(db.seen.length, 1);
    assert.match(db.seen[0].text, /^insert into teachers \(clerk_user_id, name, email\)/);
    assert.match(db.seen[0].text, /on conflict \(clerk_user_id\) do update set name = excluded\.name, email = excluded\.email/);
    assert.deepEqual(db.seen[0].params, ["user_test_1", "Maya Ro", "teacher@example.com", hashClerkUserId("user_test_1")]);
    assert.equal(db.seen[0].text.includes("teacher@example.com"), false);
  });

  it("user.created for a deleted account writes nothing and is deleted_account", async () => {
    const db = fakeDb(() => []);
    assert.equal(await handleClerkEvent({ type: "user.created", data: USER }, db.execute), "deleted_account");
    assert.equal(db.seen.length, 1);
    // The deleted list is checked inside the insert itself.
    assert.match(
      db.seen[0].text,
      /select \$1::text, \$2::text, \$3::text\nwhere not exists \(select 1 from deleted_clerk_users where clerk_user_hash = \$4::text\)\non conflict/,
    );
  });

  it("user.updated only updates (never inserts), so a late one can't bring back a deleted teacher", async () => {
    const db = fakeDb();
    const updated = { ...USER, last_name: "Rossi", primary_email_address_id: "idn_1" };
    assert.equal(await handleClerkEvent({ type: "user.updated", data: updated }, db.execute), "updated");
    assert.equal(db.seen.length, 1);
    assert.equal(
      db.seen[0].text,
      "update teachers set name = $2::text, email = $3::text\nwhere clerk_user_id = $1::text and not exists (select 1 from deleted_clerk_users where clerk_user_hash = $4::text)\nreturning id",
    );
    assert.deepEqual(db.seen[0].params, ["user_test_1", "Maya Rossi", "old@example.com", hashClerkUserId("user_test_1")]);
    assert.equal(/insert/i.test(db.seen[0].text), false);
    const gone = fakeDb(() => []);
    assert.equal(await handleClerkEvent({ type: "user.updated", data: updated }, gone.execute), "no_teacher");
    assert.equal(gone.seen.length, 1);
  });

  it("user.deleted deletes the classes, the self-learner readings, then the account, in one batch; a repeat is already_gone", async () => {
    const db = fakeDb();
    assert.equal(await handleClerkEvent({ type: "user.deleted", data: { id: "user_test_1", deleted: true } }, db.execute), "deleted");
    assert.deepEqual(
      db.seen.map((s) => s.text),
      deleteTeacherStatements("user_test_1").map((s) => s.text),
    );
    const [lock, classes, selfReadings, listed, prune, teacher] = db.seen;
    assert.equal(db.seen.length, 6);
    assert.equal(lock.text, "select id from teachers where clerk_user_id = $1::text for update");
    assert.match(classes.text, /^delete from classes\nwhere teacher_id in \(select id from teachers where clerk_user_id = \$1::text\)$/);
    assert.equal(
      selfReadings.text,
      "delete from self_readings\nwhere account_id in (select id from teachers where clerk_user_id = $1::text)",
    );
    assert.equal(teacher.text, "delete from teachers where clerk_user_id = $1::text returning id");
    // Listed in the same batch as the cascade, by hash only.
    assert.match(listed.text, /^insert into deleted_clerk_users \(clerk_user_hash\) values \(\$1::text\)\non conflict \(clerk_user_hash\) do nothing$/);
    assert.deepEqual(listed.params, [hashClerkUserId("user_test_1")]);
    assert.match(prune.text, /^delete from deleted_clerk_users/);
    assert.deepEqual(prune.params, [30, 200]);
    for (const s of [lock, classes, selfReadings, teacher]) assert.deepEqual(s.params, ["user_test_1"]);
    for (const s of db.seen) assert.equal(s.text.includes("user_test_1"), false);
    assert.equal(JSON.stringify([listed.params, prune.params]).includes("user_test_1"), false);
    const gone = fakeDb(() => []);
    assert.equal(await handleClerkEvent({ type: "user.deleted", data: { id: "user_test_1", deleted: true } }, gone.execute), "already_gone");
    // Only the account delete decides the outcome: the class and
    // self-learner deletes return nothing either way.
    const onlyClasses = fakeDb((s) => (s.text.startsWith("delete from teachers") ? [] : [{ id: "x" }]));
    assert.equal(await handleClerkEvent({ type: "user.deleted", data: { id: "user_test_1" } }, onlyClasses.execute), "already_gone");
  });

  it("deleteTeacherStatements locks first, removes the classes and the self-learner readings, then the account row last", () => {
    const texts = deleteTeacherStatements("user_test_1").map((s) => s.text);
    const lock = texts.findIndex((t) => t.endsWith("for update"));
    const classes = texts.findIndex((t) => t.startsWith("delete from classes"));
    const selfReadings = texts.findIndex((t) => t.startsWith("delete from self_readings"));
    const teacher = texts.findIndex((t) => t.startsWith("delete from teachers"));
    assert.equal(lock, 0);
    assert.ok(classes > lock && selfReadings > lock);
    assert.ok(teacher > classes && teacher > selfReadings);
    assert.equal(teacher, texts.length - 1);
    const listed = texts.findIndex((t) => t.startsWith("insert into deleted_clerk_users"));
    assert.ok(listed > lock && listed < teacher);
    // Every self_* table hangs off self_readings or the account row with
    // ON DELETE CASCADE, so these two statements reach all of them.
    assert.equal(texts.filter((t) => /delete from self_(questions|attempts|answers|effort_checks)/.test(t)).length, 0);
  });

  it("deletedAccountRows reads the last statement (the account delete)", () => {
    assert.equal(deletedAccountRows([[{ id: "t" }], [], [], [{ id: "t" }]]), 1);
    assert.equal(deletedAccountRows([[{ id: "t" }], [{ id: "c" }], [{ id: "r" }], []]), 0);
    assert.equal(deletedAccountRows([]), 0);
  });

  it("user.created never sets a role (the account chooses on /welcome)", async () => {
    const db = fakeDb();
    await handleClerkEvent({ type: "user.created", data: USER }, db.execute);
    assert.equal(/role/.test(db.seen[0].text), false);
    const upd = fakeDb();
    await handleClerkEvent({ type: "user.updated", data: USER }, upd.execute);
    assert.equal(/role/.test(upd.seen[0].text), false);
  });

  it("skips a user with no email, or an event with no id, touching nothing", async () => {
    const db = fakeDb();
    assert.equal(await handleClerkEvent({ type: "user.created", data: { ...USER, email_addresses: [] } }, db.execute), "skipped_no_email");
    assert.equal(await handleClerkEvent({ type: "user.updated", data: { ...USER, id: undefined } }, db.execute), "skipped_no_id");
    assert.equal(await handleClerkEvent({ type: "user.deleted", data: {} }, db.execute), "skipped_no_id");
    assert.equal(db.seen.length, 0);
  });

  it("ignores other events", async () => {
    const db = fakeDb();
    assert.equal(await handleClerkEvent({ type: "session.created", data: { id: "sess_1" } }, db.execute), "ignored");
    assert.equal(db.seen.length, 0);
  });
});

describe("handleClerkWebhookRequest (with the real verifier)", () => {
  const body = (type: string, data: unknown = USER) => JSON.stringify({ type, data, object: "event" });

  it("a correctly signed user.created is a 200 and an upsert, logging only type and outcome", async () => {
    const { d, logs, db } = deps();
    const res = await handleClerkWebhookRequest(signed(body("user.created")), d);
    assert.equal(res.status, 200);
    assert.equal(db.seen.length, 1);
    assert.deepEqual(logs, [{ level: "info", message: "clerk webhook", fields: { type: "user.created", outcome: "upserted" } }]);
    const logged = JSON.stringify(logs);
    for (const secret of ["Maya", "teacher@example.com", "user_test_1"]) assert.equal(logged.includes(secret), false);
  });

  it("an unknown event is a 200 and changes nothing", async () => {
    const { d, db } = deps();
    const res = await handleClerkWebhookRequest(signed(body("organization.created", { id: "org_1" })), d);
    assert.equal(res.status, 200);
    assert.equal(db.seen.length, 0);
  });

  it("a bad signature is a 400 with no detail, and touches nothing", async () => {
    const { d, logs, db } = deps();
    const res = await handleClerkWebhookRequest(signed(body("user.deleted"), Buffer.from("some-other-secret-000000000000")), d);
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "Bad request");
    assert.equal(db.seen.length, 0);
    assert.equal(logs.length, 0);
  });

  it("missing svix headers are a 400", async () => {
    const { d, db } = deps();
    const req = new Request("https://unpack.example.org/api/webhooks/clerk", { method: "POST", body: body("user.created") });
    const res = await handleClerkWebhookRequest(req, d);
    assert.equal(res.status, 400);
    assert.equal(db.seen.length, 0);
  });

  it("a tampered body is a 400", async () => {
    const { d, db } = deps();
    const good = signed(body("user.created"));
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: body("user.deleted") });
    assert.equal((await handleClerkWebhookRequest(tampered, d)).status, 400);
    assert.equal(db.seen.length, 0);
  });

  it("no signing secret is a 500 with a loud log and no payload", async () => {
    const { d, logs, db } = deps({ secret: undefined });
    const res = await handleClerkWebhookRequest(signed(body("user.created")), d);
    assert.equal(res.status, 500);
    assert.equal(db.seen.length, 0);
    assert.equal(logs[0].level, "error");
    assert.match(logs[0].message, /CLERK_WEBHOOK_SIGNING_SECRET is not set/);
    assert.equal(JSON.stringify(logs).includes("teacher@example.com"), false);
  });

  it("a database error is a 500 (Clerk retries), logging no row data", async () => {
    const { d, logs } = deps({
      execute: async () => {
        throw Object.assign(new Error('duplicate key value: teacher@example.com'), { code: "XX000" });
      },
    });
    const res = await handleClerkWebhookRequest(signed(body("user.updated")), d);
    assert.equal(res.status, 500);
    assert.deepEqual(logs[0].fields, { type: "user.updated", name: "Error", code: "XX000" });
  });

  it("a user.updated for no teacher (say, after user.deleted) is a 200, logging only type and outcome", async () => {
    const none = fakeDb(() => []);
    const { d, logs } = deps({ execute: none.execute });
    const res = await handleClerkWebhookRequest(signed(body("user.updated")), d);
    assert.equal(res.status, 200);
    assert.equal(none.seen.length, 1);
    assert.deepEqual(logs, [{ level: "info", message: "clerk webhook", fields: { type: "user.updated", outcome: "no_teacher" } }]);
  });

  it("a user.deleted is a 200 with outcome deleted", async () => {
    const { d, logs, db } = deps();
    const res = await handleClerkWebhookRequest(signed(body("user.deleted", { id: "user_test_1", deleted: true })), d);
    assert.equal(res.status, 200);
    assert.equal(db.seen.length, 6);
    assert.deepEqual(logs, [{ level: "info", message: "clerk webhook", fields: { type: "user.deleted", outcome: "deleted" } }]);
  });

  it("a user.created for a deleted account is a 200, so Clerk stops retrying", async () => {
    const none = fakeDb(() => []);
    const { d, logs } = deps({ execute: none.execute });
    const res = await handleClerkWebhookRequest(signed(body("user.created")), d);
    assert.equal(res.status, 200);
    assert.deepEqual(logs, [{ level: "info", message: "clerk webhook", fields: { type: "user.created", outcome: "deleted_account" } }]);
  });
});
