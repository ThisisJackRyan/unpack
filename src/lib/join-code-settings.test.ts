import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JoinCodeExhaustedError } from "./join-code";
import {
  newCodeMessage,
  newCodeStatement,
  newJoinCodeWith,
  setCodeActiveStatement,
  setCodeActiveWith,
} from "./join-code-settings";
import type { Statement } from "./link-rate-limit";

const C = "c1";
const T = "t1";

const conflict = () =>
  Object.assign(new Error("dup"), { code: "23505", constraint: "classes_join_code_unique" });

describe("join code statements", () => {
  it("turns the code on or off only for the owning teacher, in the same statement", () => {
    const s = setCodeActiveStatement(C, T, false);
    assert.match(s.text, /^update classes set code_active = \$3::boolean/);
    assert.match(s.text, /where id = \$1::uuid and teacher_id = \$2::uuid/);
    assert.deepEqual(s.params, [C, T, false]);
  });

  it("replaces the code only for the owning teacher, in the same statement", () => {
    const s = newCodeStatement(C, T, "ABC234");
    assert.match(s.text, /^update classes set join_code = \$3::text/);
    assert.match(s.text, /where id = \$1::uuid and teacher_id = \$2::uuid/);
    assert.deepEqual(s.params, [C, T, "ABC234"]);
  });
});

describe("setCodeActiveWith", () => {
  it("saves the asked-for value", async () => {
    const execute = async (s: Statement[]) => [[{ code_active: s[0].params[2] }]];
    assert.deepEqual(await setCodeActiveWith(C, T, false, execute), { status: "saved", active: false });
    assert.deepEqual(await setCodeActiveWith(C, T, true, execute), { status: "saved", active: true });
  });

  it("is not_found when no row matched (another teacher's class)", async () => {
    assert.deepEqual(await setCodeActiveWith(C, "other", true, async () => [[]]), { status: "not_found" });
  });
});

describe("newJoinCodeWith", () => {
  it("saves a fresh code", async () => {
    const execute = async (s: Statement[]) => [[{ join_code: s[0].params[2] }]];
    assert.deepEqual(await newJoinCodeWith(C, T, execute, { generate: () => "NEW234" }), { status: "saved", code: "NEW234" });
  });

  it("retries a code another class has", async () => {
    const codes = ["TAKEN2", "FRESH3"];
    const conflicts: unknown[] = [];
    const execute = async (s: Statement[]) => {
      if (s[0].params[2] === "TAKEN2") throw conflict();
      return [[{ join_code: s[0].params[2] }]];
    };
    const result = await newJoinCodeWith(C, T, execute, { generate: () => codes.shift()!, onConflict: (e) => conflicts.push(e) });
    assert.deepEqual(result, { status: "saved", code: "FRESH3" });
    assert.equal(conflicts.length, 1);
  });

  it("gives up after 5 collisions", async () => {
    const execute = async () => {
      throw conflict();
    };
    await assert.rejects(newJoinCodeWith(C, T, execute), JoinCodeExhaustedError);
  });

  it("is not_found for another teacher's class, and other errors propagate", async () => {
    assert.deepEqual(await newJoinCodeWith(C, "other", async () => [[]]), { status: "not_found" });
    await assert.rejects(
      newJoinCodeWith(C, T, async () => {
        throw Object.assign(new Error("down"), { code: "57P01" });
      }),
      /down/,
    );
  });

  it("says the old code stopped working", () => {
    assert.equal(newCodeMessage("ABC234"), "New code ready: ABC234. The old code no longer works.");
  });
});
