import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { AGE_REQUIRED_MESSAGE, ROLE_SAVE_FAILED_MESSAGE, type AccountRole, type SetRoleOutcome } from "@/lib/account-role";
import { deleteUnder13Account, type RolelessDeleteOutcome } from "@/lib/under-13-account";
import { chooseRoleCore, finishChooseRole, UNDER_13_EXIT_PATH, type ChooseRoleDeps } from "./welcome-core";

// Mid-month, October 2026 (UTC).
const NOW = new Date("2026-10-15T12:00:00Z");
const CLERK_ID = "user_test_welcome_1";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const OLD_ENOUGH = { birthMonth: "9", birthYear: "2013" };
const UNDER = { birthMonth: "10", birthYear: "2013" };

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// Every outside dependency, recording each call. The delete is the real
// deleteUnder13Account over recording fakes, so "called with the id"
// covers both the local delete and Clerk's deleteUser.
function spies(opts: { ageGated?: boolean; local?: RolelessDeleteOutcome; save?: SetRoleOutcome } = {}) {
  const calls = { setAgeGate: 0, save: [] as [string, AccountRole, boolean][], local: [] as string[], clerk: [] as string[], order: [] as string[] };
  const logs: unknown[][] = [];
  const deps: ChooseRoleDeps = {
    account: { id: ACCOUNT_ID, clerkUserId: CLERK_ID, role: null, ageConfirmed: false },
    ageGated: opts.ageGated ?? false,
    now: NOW,
    setAgeGate: async () => {
      calls.setAgeGate++;
      calls.order.push("cookie");
    },
    setAccountRole: async (id, role, confirmAge) => {
      calls.save.push([id, role, confirmAge]);
      return opts.save ?? { status: "saved", role };
    },
    deleteUnder13: (clerkUserId) =>
      deleteUnder13Account(clerkUserId, {
        deleteLocal: async (id) => {
          calls.local.push(id);
          calls.order.push("local");
          return opts.local ?? "deleted";
        },
        deleteClerkUser: async (id) => {
          calls.clerk.push(id);
          calls.order.push("clerk");
        },
        confirmClerkDeleted: async () => {},
        log: (...line) => logs.push(line),
      }),
    logError: (...line) => logs.push(line),
  };
  return { deps, calls, logs };
}

describe("chooseRoleCore", () => {
  it("an under-13 answer sets the cookie, deletes the account (local, then Clerk, by its id), and redirects to /join", async () => {
    const { deps, calls, logs } = spies();
    const result = await chooseRoleCore(form({ role: "self_learner", ...UNDER }), deps);
    // A redirect, not a state: a returned state would make Next render
    // /welcome again for the deleted account in the same response.
    assert.deepEqual(result, { redirect: "/join" });
    assert.equal(UNDER_13_EXIT_PATH, "/join");
    assert.deepEqual(calls.order, ["cookie", "local", "clerk"]);
    assert.deepEqual(calls.local, [CLERK_ID]);
    assert.deepEqual(calls.clerk, [CLERK_ID]);
    assert.deepEqual(calls.save, []);
    // No id, email, month or year in the logs or the returned state.
    const text = JSON.stringify({ logs, result });
    for (const bad of [CLERK_ID, ACCOUNT_ID, "2013", "October", '"10"']) assert.equal(text.includes(bad), false, bad);
  });

  it("an account that got a role from another tab first is not deleted: the class note only", async () => {
    const { deps, calls } = spies({ local: "has_role" });
    const result = await chooseRoleCore(form({ role: "self_learner", ...UNDER }), deps);
    assert.deepEqual(result, { state: { role: "self_learner", ageGate: true } });
    assert.equal(calls.setAgeGate, 1);
    assert.deepEqual(calls.clerk, []);
  });

  it("with the cookie already set, self-learner is refused and nothing is deleted", async () => {
    const { deps, calls } = spies({ ageGated: true });
    const result = await chooseRoleCore(form({ role: "self_learner", ...OLD_ENOUGH }), deps);
    assert.deepEqual(result, { state: { role: "self_learner", ageGate: true } });
    assert.deepEqual([calls.setAgeGate, calls.local.length, calls.clerk.length, calls.save.length], [0, 0, 0, 0]);
  });

  it("with the cookie set and no role yet, teacher is refused on the server too: nothing saved or deleted", async () => {
    const { deps, calls } = spies({ ageGated: true });
    for (const fields of [{ role: "teacher" }, { role: "teacher", ...OLD_ENOUGH }, {}] as Record<string, string>[]) {
      const result = await chooseRoleCore(form(fields), deps);
      assert.deepEqual(result, { state: { role: fields.role, ageGate: true } });
    }
    assert.deepEqual([calls.setAgeGate, calls.local.length, calls.clerk.length, calls.save.length], [0, 0, 0, 0]);
  });

  it("13+ saves self-learner with the confirmation and goes home; nothing is deleted", async () => {
    const { deps, calls } = spies();
    assert.deepEqual(await chooseRoleCore(form({ role: "self_learner", ...OLD_ENOUGH }), deps), { redirect: "/learn" });
    assert.deepEqual(calls.save, [[ACCOUNT_ID, "self_learner", true]]);
    assert.deepEqual([calls.setAgeGate, calls.local.length, calls.clerk.length], [0, 0, 0]);
  });

  it("teacher saves with no age screen", async () => {
    const { deps, calls } = spies();
    assert.deepEqual(await chooseRoleCore(form({ role: "teacher" }), deps), { redirect: "/teacher" });
    assert.deepEqual(calls.save, [[ACCOUNT_ID, "teacher", false]]);
  });

  it("a missing age answer is the generic error; a failed save is the save error", async () => {
    const missing = spies();
    assert.deepEqual(await chooseRoleCore(form({ role: "self_learner" }), missing.deps), {
      state: { errors: { age: AGE_REQUIRED_MESSAGE }, role: "self_learner" },
    });
    const failed = spies();
    failed.deps.setAccountRole = async () => {
      throw Object.assign(new Error("boom"), { name: "NeonDbError", code: "57P01" });
    };
    assert.deepEqual(await chooseRoleCore(form({ role: "teacher" }), failed.deps), {
      state: { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: "teacher" },
    });
    assert.deepEqual(failed.logs, [["chooseRoleAction: save failed", { name: "NeonDbError", code: "57P01", causes: [], timedOut: false }]]);
  });
});

// Next's redirect() throws; this one records the path and throws the same way.
class Redirected extends Error {
  path: string;
  constructor(path: string) {
    super("NEXT_REDIRECT");
    this.path = path;
  }
}
function fakeRedirect(path: string): never {
  throw new Redirected(path);
}

describe("chooseRoleAction's last step (finishChooseRole)", () => {
  it("an under-13 answer calls redirect(\"/join\") and returns no state", async () => {
    const { deps, calls } = spies();
    const result = await chooseRoleCore(form({ role: "self_learner", ...UNDER }), deps);
    assert.throws(() => finishChooseRole(result, fakeRedirect), (e) => e instanceof Redirected && e.path === "/join");
    assert.deepEqual(calls.clerk, [CLERK_ID]);
  });

  it("a state is returned as is, with no redirect", () => {
    const state = { role: "self_learner", ageGate: true as const };
    assert.equal(finishChooseRole({ state }, fakeRedirect), state);
  });

  it("actions.ts hands chooseRoleCore's result to finishChooseRole with Next's redirect", () => {
    const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
    assert.match(source, /import \{ redirect \} from "next\/navigation";/);
    assert.match(source, /const result = await chooseRoleCore\(formData, \{/);
    assert.match(source, /return finishChooseRole\(result, redirect\);/);
  });
});
