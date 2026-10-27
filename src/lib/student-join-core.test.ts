import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashJoinCode } from "./client-ip";
import type { Statement } from "./link-rate-limit";
import {
  isNameTakenConflict,
  joinClassWith,
  joinStudentStatement,
  NAME_TAKEN_MESSAGE,
} from "./student-join-core";
import { hashSessionToken } from "./student-session-token";

const DATA = { code: "ABC234", firstName: "Maya", lastInitials: "Ro" };
const IP = "c".repeat(64);
const TOKEN = "raw-token-value";

function nameClash() {
  return Object.assign(new Error("duplicate key"), {
    code: "23505",
    constraint: "students_class_id_name_key_unique",
  });
}

describe("isNameTakenConflict", () => {
  it("matches 23505 on the per-class name constraint, wrapped or not", () => {
    assert.equal(isNameTakenConflict(nameClash()), true);
    assert.equal(isNameTakenConflict(new Error("query failed", { cause: nameClash() })), true);
    assert.equal(
      isNameTakenConflict(new Error("a", { cause: new Error("b", { cause: nameClash() }) })),
      true,
    );
  });

  it("ignores other constraints, other codes, and non-errors", () => {
    assert.equal(
      isNameTakenConflict({ code: "23505", constraint: "students_session_token_hash_unique" }),
      false,
    );
    assert.equal(isNameTakenConflict({ code: "23503", constraint: "students_class_id_name_key_unique" }), false);
    assert.equal(isNameTakenConflict(new Error("boom")), false);
    assert.equal(isNameTakenConflict(null), false);
    assert.equal(isNameTakenConflict("23505"), false);
  });

  it("has the agreed message", () => {
    assert.equal(NAME_TAKEN_MESSAGE, "Someone already has that name. Add another letter.");
  });
});

describe("joinStudentStatement", () => {
  it("finds the class by code only while the code is on, and stores only the token hash", () => {
    const s = joinStudentStatement(DATA, hashSessionToken(TOKEN));
    assert.match(s.text, /where c\.join_code = \$1::text and c\.code_active/);
    assert.deepEqual(s.params, ["ABC234", "Maya", "Ro", "maya ro", hashSessionToken(TOKEN)]);
    assert.ok(!s.params.includes(TOKEN));
  });
});

// Answers the limit batch (4 statements) and then the insert.
function fakeDb(opts: { allowed?: boolean; inserted?: Record<string, unknown>[]; insertError?: unknown }) {
  const calls: Statement[][] = [];
  const execute = async (statements: Statement[]) => {
    calls.push(statements);
    if (statements.length === 4) {
      return [[{}], [{}], opts.allowed === false ? [] : [{}, {}], []];
    }
    if (opts.insertError) throw opts.insertError;
    return [opts.inserted ?? []];
  };
  return { execute, calls };
}

describe("joinClassWith", () => {
  it("records the attempt first, then joins with a hashed token", async () => {
    const db = fakeDb({ inserted: [{ id: "s1", class_id: "c1" }] });
    const outcome = await joinClassWith(DATA, { execute: db.execute, ipHash: IP, newToken: () => TOKEN });
    assert.deepEqual(outcome, { status: "joined", studentId: "s1", classId: "c1", token: TOKEN });
    assert.equal(db.calls.length, 2);
    assert.deepEqual(db.calls[0][2].params.slice(0, 2), [IP, hashJoinCode("ABC234")]);
    const insertParams = db.calls[1][0].params;
    assert.ok(insertParams.includes(hashSessionToken(TOKEN)));
    assert.ok(!insertParams.includes(TOKEN));
  });

  it("stops before the insert when limited", async () => {
    const db = fakeDb({ allowed: false });
    assert.deepEqual(await joinClassWith(DATA, { execute: db.execute, ipHash: IP }), { status: "limited" });
    assert.equal(db.calls.length, 1);
  });

  it("reports an unknown or turned-off code as class_not_found", async () => {
    const db = fakeDb({ inserted: [] });
    assert.deepEqual(await joinClassWith(DATA, { execute: db.execute, ipHash: IP }), {
      status: "class_not_found",
    });
  });

  it("reports a name clash as name_taken", async () => {
    const db = fakeDb({ insertError: new Error("wrapped", { cause: nameClash() }) });
    assert.deepEqual(await joinClassWith(DATA, { execute: db.execute, ipHash: IP }), { status: "name_taken" });
  });

  it("rethrows any other error", async () => {
    const other = Object.assign(new Error("dup token"), {
      code: "23505",
      constraint: "students_session_token_hash_unique",
    });
    await assert.rejects(
      joinClassWith(DATA, { execute: fakeDb({ insertError: other }).execute, ipHash: IP }),
      /dup token/,
    );
  });
});
