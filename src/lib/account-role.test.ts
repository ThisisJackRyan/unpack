import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGE_REQUIRED_MESSAGE,
  homeFor,
  isAccountRole,
  needsSwitchConfirm,
  parseRoleChoice,
  parseSettingsRoleChoice,
  ROLE_REQUIRED_MESSAGE,
  roleRedirect,
  setRoleOutcome,
  setRoleStatements,
  settingsBackLink,
  SWITCH_CONFIRM_VALUE,
} from "./account-role";

const ID = "00000000-0000-4000-8000-000000000001";

// Mid-month, October 2026 (UTC).
const NOW = new Date("2026-10-15T12:00:00Z");
const fresh = { ageConfirmed: false, ageGated: false, now: NOW };
const OLD_ENOUGH = { birthMonth: "9", birthYear: "2013" };
const UNDER = { birthMonth: "10", birthYear: "2013" };
const NO_AGE = { birthMonth: null, birthYear: null };

describe("parseRoleChoice", () => {
  it("accepts a teacher with no age screen", () => {
    assert.deepEqual(parseRoleChoice({ role: "teacher", ...NO_AGE }, fresh), { ok: true, role: "teacher", confirmAge: false });
  });

  it("ignores any age answer for a teacher (nothing is stored)", () => {
    for (const age of [OLD_ENOUGH, UNDER]) {
      assert.deepEqual(parseRoleChoice({ role: "teacher", ...age }, fresh), { ok: true, role: "teacher", confirmAge: false });
    }
  });

  it("requires a valid month and year for a self-learner, with one generic error", () => {
    for (const age of [NO_AGE, { birthMonth: "", birthYear: "" }, { birthMonth: "9", birthYear: null }, { birthMonth: "13", birthYear: "2000" }]) {
      assert.deepEqual(parseRoleChoice({ role: "self_learner", ...age }, fresh), {
        ok: false,
        errors: { age: AGE_REQUIRED_MESSAGE },
      });
    }
    assert.equal(AGE_REQUIRED_MESSAGE, "Choose a month and a year.");
  });

  it("confirms 13+ from the month after the 13th birthday month", () => {
    assert.deepEqual(parseRoleChoice({ role: "self_learner", ...OLD_ENOUGH }, fresh), {
      ok: true,
      role: "self_learner",
      confirmAge: true,
    });
  });

  it("sets the age gate for an under-13 answer (the birthday month itself counts as under)", () => {
    assert.deepEqual(parseRoleChoice({ role: "self_learner", ...UNDER }, fresh), { ok: false, ageGate: "set" });
  });

  it("with the cookie on the device, refuses self-learner without reading the answer", () => {
    const gated = { ...fresh, ageGated: true };
    for (const age of [OLD_ENOUGH, UNDER, NO_AGE]) {
      assert.deepEqual(parseRoleChoice({ role: "self_learner", ...age }, gated), { ok: false, ageGate: "kept" });
    }
    // Teacher is not age gated (unchanged from PR 13).
    assert.deepEqual(parseRoleChoice({ role: "teacher", ...NO_AGE }, gated), { ok: true, role: "teacher", confirmAge: false });
  });

  it("doesn't ask again when the account confirmed before, cookie or not", () => {
    for (const ageGated of [false, true]) {
      assert.deepEqual(parseRoleChoice({ role: "self_learner", ...NO_AGE }, { ...fresh, ageConfirmed: true, ageGated }), {
        ok: true,
        role: "self_learner",
        confirmAge: false,
      });
    }
  });

  it("refuses a missing or invalid role", () => {
    for (const role of [null, "", "admin", "student", "Teacher", 1]) {
      assert.deepEqual(parseRoleChoice({ role, ...OLD_ENOUGH }, fresh), {
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

describe("parseSettingsRoleChoice (the switch confirm)", () => {
  const teacher = { role: "teacher" as const, ...fresh, ageConfirmed: true };
  const newTeacher = { role: "teacher" as const, ...fresh };
  const learner = { role: "self_learner" as const, ...fresh, ageConfirmed: true };

  it("refuses a teacher's switch to self-learner without the confirm", () => {
    for (const confirmSwitch of [null, "", "no", "YES", "true"]) {
      assert.deepEqual(parseSettingsRoleChoice({ role: "self_learner", ...NO_AGE, confirmSwitch }, teacher), {
        ok: false,
        confirmSwitch: true,
      });
    }
  });

  it("saves a teacher's confirmed switch", () => {
    assert.deepEqual(
      parseSettingsRoleChoice({ role: "self_learner", ...NO_AGE, confirmSwitch: SWITCH_CONFIRM_VALUE }, teacher),
      { ok: true, role: "self_learner", confirmAge: false },
    );
  });

  it("asks for the age screen before the confirm, and still needs it after", () => {
    assert.deepEqual(parseSettingsRoleChoice({ role: "self_learner", ...NO_AGE, confirmSwitch: null }, newTeacher), {
      ok: false,
      errors: { age: AGE_REQUIRED_MESSAGE },
    });
    assert.deepEqual(
      parseSettingsRoleChoice({ role: "self_learner", ...NO_AGE, confirmSwitch: SWITCH_CONFIRM_VALUE }, newTeacher),
      { ok: false, errors: { age: AGE_REQUIRED_MESSAGE } },
    );
    assert.deepEqual(
      parseSettingsRoleChoice({ role: "self_learner", ...OLD_ENOUGH, confirmSwitch: SWITCH_CONFIRM_VALUE }, newTeacher),
      { ok: true, role: "self_learner", confirmAge: true },
    );
  });

  it("the switch path: a teacher picked after an under-13 answer can't switch to self-learner on that device", () => {
    const gatedTeacher = { ...newTeacher, ageGated: true };
    for (const age of [OLD_ENOUGH, UNDER, NO_AGE]) {
      for (const confirmSwitch of [null, SWITCH_CONFIRM_VALUE]) {
        assert.deepEqual(parseSettingsRoleChoice({ role: "self_learner", ...age, confirmSwitch }, gatedTeacher), {
          ok: false,
          ageGate: "kept",
        });
      }
    }
    // An under-13 answer in Settings sets the gate, confirm or not.
    assert.deepEqual(
      parseSettingsRoleChoice({ role: "self_learner", ...UNDER, confirmSwitch: SWITCH_CONFIRM_VALUE }, newTeacher),
      { ok: false, ageGate: "set" },
    );
    // Staying a teacher still saves.
    assert.deepEqual(parseSettingsRoleChoice({ role: "teacher", ...NO_AGE, confirmSwitch: null }, gatedTeacher), {
      ok: true,
      role: "teacher",
      confirmAge: false,
    });
  });

  it("needs no confirm for staying a teacher, switching back, or staying a self-learner", () => {
    assert.deepEqual(parseSettingsRoleChoice({ role: "teacher", ...NO_AGE, confirmSwitch: null }, teacher), {
      ok: true,
      role: "teacher",
      confirmAge: false,
    });
    assert.deepEqual(parseSettingsRoleChoice({ role: "teacher", ...NO_AGE, confirmSwitch: null }, learner), {
      ok: true,
      role: "teacher",
      confirmAge: false,
    });
    assert.deepEqual(parseSettingsRoleChoice({ role: "self_learner", ...NO_AGE, confirmSwitch: null }, learner), {
      ok: true,
      role: "self_learner",
      confirmAge: false,
    });
  });

  it("keeps the role errors", () => {
    assert.deepEqual(parseSettingsRoleChoice({ role: "admin", ...NO_AGE, confirmSwitch: SWITCH_CONFIRM_VALUE }, teacher), {
      ok: false,
      errors: { role: ROLE_REQUIRED_MESSAGE },
    });
  });

  it("needsSwitchConfirm: only teacher to self-learner", () => {
    assert.equal(needsSwitchConfirm("teacher", "self_learner"), true);
    assert.equal(needsSwitchConfirm("teacher", "teacher"), false);
    assert.equal(needsSwitchConfirm("self_learner", "self_learner"), false);
    assert.equal(needsSwitchConfirm("self_learner", "teacher"), false);
    assert.equal(needsSwitchConfirm(null, "self_learner"), false);
    assert.equal(needsSwitchConfirm("teacher", null), false);
  });
});

describe("settingsBackLink", () => {
  it("sends a teacher back to their classes and a self-learner back to /learn", () => {
    assert.deepEqual(settingsBackLink("teacher"), { href: "/teacher", label: "Back to your classes" });
    assert.deepEqual(settingsBackLink("self_learner"), { href: "/learn", label: "Back to your reading" });
    assert.deepEqual(settingsBackLink(null), { href: "/welcome", label: "Back home" });
  });
});
