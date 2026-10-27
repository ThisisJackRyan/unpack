import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGE_CONFIRMED_VALUE,
  AGE_REQUIRED_MESSAGE,
  homeFor,
  isAccountRole,
  parseRoleChoice,
  ROLE_REQUIRED_MESSAGE,
  roleRedirect,
  setRoleOutcome,
  setRoleStatements,
} from "./account-role";

const ID = "00000000-0000-4000-8000-000000000001";

describe("parseRoleChoice", () => {
  it("accepts a teacher with no age box", () => {
    assert.deepEqual(parseRoleChoice({ role: "teacher", ageConfirmed: null }), { ok: true, role: "teacher", confirmAge: false });
  });

  it("ignores the age box for a teacher (nothing is stored)", () => {
    assert.deepEqual(parseRoleChoice({ role: "teacher", ageConfirmed: AGE_CONFIRMED_VALUE }), {
      ok: true,
      role: "teacher",
      confirmAge: false,
    });
  });

  it("requires the age box for a self-learner", () => {
    assert.deepEqual(parseRoleChoice({ role: "self_learner", ageConfirmed: null }), {
      ok: false,
      errors: { age: AGE_REQUIRED_MESSAGE },
    });
    assert.deepEqual(parseRoleChoice({ role: "self_learner", ageConfirmed: "on" }), {
      ok: false,
      errors: { age: AGE_REQUIRED_MESSAGE },
    });
    assert.deepEqual(parseRoleChoice({ role: "self_learner", ageConfirmed: AGE_CONFIRMED_VALUE }), {
      ok: true,
      role: "self_learner",
      confirmAge: true,
    });
  });

  it("doesn't ask again when the account confirmed before", () => {
    assert.deepEqual(parseRoleChoice({ role: "self_learner", ageConfirmed: null }, true), {
      ok: true,
      role: "self_learner",
      confirmAge: false,
    });
  });

  it("refuses a missing or invalid role", () => {
    for (const role of [null, "", "admin", "student", "Teacher", 1]) {
      assert.deepEqual(parseRoleChoice({ role, ageConfirmed: AGE_CONFIRMED_VALUE }), {
        ok: false,
        errors: { role: ROLE_REQUIRED_MESSAGE },
      });
    }
    assert.equal(isAccountRole("self_learner"), true);
    assert.equal(isAccountRole("parent"), false);
  });
});

describe("homeFor and roleRedirect", () => {
  it("sends each role home", () => {
    assert.equal(homeFor(null), "/welcome");
    assert.equal(homeFor("teacher"), "/teacher");
    assert.equal(homeFor("self_learner"), "/learn");
  });

  it("sends an account with no role to /welcome from everywhere else", () => {
    assert.equal(roleRedirect("welcome", null), null);
    assert.equal(roleRedirect("teacher", null), "/welcome");
    assert.equal(roleRedirect("learn", null), "/welcome");
    assert.equal(roleRedirect("settings", null), "/welcome");
  });

  it("keeps a self-learner out of the teacher area, and a teacher out of /learn", () => {
    assert.equal(roleRedirect("teacher", "self_learner"), "/learn");
    assert.equal(roleRedirect("learn", "self_learner"), null);
    assert.equal(roleRedirect("learn", "teacher"), "/teacher");
    assert.equal(roleRedirect("teacher", "teacher"), null);
  });

  it("lets any role into settings, and sends a chosen role home from /welcome", () => {
    assert.equal(roleRedirect("settings", "teacher"), null);
    assert.equal(roleRedirect("settings", "self_learner"), null);
    assert.equal(roleRedirect("welcome", "teacher"), "/teacher");
    assert.equal(roleRedirect("welcome", "self_learner"), "/learn");
  });
});

describe("setRoleStatements", () => {
  it("sets role and age in one conditional update, scoped to the account", () => {
    const [update, read] = setRoleStatements(ID, "self_learner", true, true);
    assert.match(update.text, /^update teachers set role = \$2::account_role,/);
    assert.match(update.text, /when \$2::account_role = 'self_learner' and age_confirmed_at is null and \$3::boolean then now\(\)/);
    assert.match(update.text, /where id = \$1::uuid/);
    // First run only when no role is set yet.
    assert.match(update.text, /and \(not \$4::boolean or role is null\)/);
    // No self-learner without a confirmation, now or earlier.
    assert.match(update.text, /and \(\$2::account_role = 'teacher' or age_confirmed_at is not null or \$3::boolean\)/);
    assert.deepEqual(update.params, [ID, "self_learner", true, true]);
    assert.match(read.text, /select role, age_confirmed_at is not null as age_confirmed from teachers where id = \$1::uuid/);
  });

  it("never stores a birthdate or anything but the role and a time", () => {
    const text = setRoleStatements(ID, "teacher", false, false).map((s) => s.text).join("\n");
    assert.equal(/birth|dob|age =/i.test(text), false);
  });
});

describe("setRoleOutcome", () => {
  it("saved when the update matched", () => {
    assert.deepEqual(setRoleOutcome([[{ role: "teacher" }], [{ role: "teacher", age_confirmed: false }]], "teacher", true), {
      status: "saved",
      role: "teacher",
    });
  });

  it("age_required for a self-learner with no confirmation", () => {
    assert.deepEqual(setRoleOutcome([[], [{ role: "teacher", age_confirmed: false }]], "self_learner", false), {
      status: "age_required",
    });
    assert.deepEqual(setRoleOutcome([[], [{ role: null, age_confirmed: false }]], "self_learner", true), {
      status: "age_required",
    });
  });

  it("already_chosen on a first run that lost to another tab", () => {
    assert.deepEqual(setRoleOutcome([[], [{ role: "self_learner", age_confirmed: true }]], "teacher", true), {
      status: "already_chosen",
      role: "self_learner",
    });
    assert.deepEqual(setRoleOutcome([[], [{ role: "teacher", age_confirmed: false }]], "teacher", true), {
      status: "already_chosen",
      role: "teacher",
    });
  });

  it("not_found with no account row", () => {
    assert.deepEqual(setRoleOutcome([[], []], "teacher", false), { status: "not_found" });
  });
});
