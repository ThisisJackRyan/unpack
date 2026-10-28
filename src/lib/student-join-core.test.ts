import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashJoinCode } from "./client-ip";
import type { Statement } from "./link-rate-limit";
import {
  isNameTakenConflict,
  joinClassWith,
  joinOutcomeErrors,
  joinStudentStatement,
  NAME_TAKEN_MESSAGE,
} from "./student-join-core";
import { hashSessionToken } from "./student-session-token";
import { CLASS_NOT_FOUND_MESSAGE, JOIN_FAILED_MESSAGE, validateJoin } from "./validate-join";

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
    assert.equal(NAME_TAKEN_MESSAGE, "Someone already has that name. If it’s you, open unpack on the device you joined with. If not, add a letter to your first name.");
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
function fakeDb(opts: { allowed?: boolean; inserted?: Record<string, unknown>[]; insertError?: unknown; retryError?: unknown }) {
  const calls: Statement[][] = [];
  const execute = async (statements: Statement[]) => {
    calls.push(statements);
    if (statements.length === 4) {
      return [[{}], [{}], opts.allowed === false ? [] : [{}, {}], []];
    }
    if (statements[0].text.startsWith("with k as")) {
      if (opts.retryError) throw opts.retryError;
      return [[{ code_limited: true, retry_at: new Date("2026-10-27T14:40:00Z") }]];
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

  it("stops before the insert when limited, with which key and when it frees up", async () => {
    const db = fakeDb({ allowed: false });
    assert.deepEqual(await joinClassWith(DATA, { execute: db.execute, ipHash: IP }), {
      status: "limited",
      retry: { by: "code", retryAt: new Date("2026-10-27T14:40:00Z") },
    });
    assert.equal(db.calls.length, 2);
    assert.ok(db.calls.every((c) => !c.some((s) => s.text.startsWith("insert into students"))));
    // The time is only for the message: if it can't be read, still limited.
    const broken = fakeDb({ allowed: false, retryError: new Error("db down") });
    assert.deepEqual(await joinClassWith(DATA, { execute: broken.execute, ipHash: IP }), {
      status: "limited",
      retry: { by: "ip", retryAt: null },
    });
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

describe("joinOutcomeErrors", () => {
  it("puts an unknown or turned-off code on the code field, with the exact text", () => {
    const errors = joinOutcomeErrors({ status: "class_not_found" });
    assert.deepEqual(errors, { code: CLASS_NOT_FOUND_MESSAGE });
    assert.equal(errors.code, "We couldn\u2019t find that class code. Check it with your teacher.");
    assert.notEqual(errors.code, JOIN_FAILED_MESSAGE);
  });

  it("keeps a taken name on its own field", () => {
    assert.deepEqual(joinOutcomeErrors({ status: "name_taken" }), { lastInitials: NAME_TAKEN_MESSAGE });
  });

  // Codes that pass validateJoin but match no class (or a class whose code
  // is off): the lookup returns no row, never an error, so the student sees
  // the code-field message and not the generic one.
  it("shows the code-field message for every well-formed code that misses", async () => {
    for (const code of ["ZZZZZZ", "abc-234", " a b c 2 3 4 ", "O0I1L0", "A", "ABCDEFGHJKMN"]) {
      const result = validateJoin({ code, firstName: "Maya", lastInitials: "Ro" });
      assert.ok(result.ok, code);
      const db = fakeDb({ inserted: [] });
      const outcome = await joinClassWith(result.data, { execute: db.execute, ipHash: IP });
      assert.equal(outcome.status, "class_not_found", code);
      if (outcome.status !== "class_not_found") continue;
      assert.deepEqual(joinOutcomeErrors(outcome), { code: CLASS_NOT_FOUND_MESSAGE }, code);
      assert.equal(db.calls[1][0].params[0], result.data.code, code);
    }
  });
});
