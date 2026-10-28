import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TURNSTILE_RESPONSE_FIELD, verifyJoinBotCheck } from "@/lib/join-bot-check";
import type { Statement } from "@/lib/link-rate-limit";
import { joinClassWith } from "@/lib/student-join-core";
import {
  JOIN_BLOCKED_CONFIG_TAG,
  JOIN_DISABLED_MESSAGE,
  JOIN_FAILED_MESSAGE,
  type JoinBlockedConfig,
} from "@/lib/validate-join";
import { joinClassCore, type JoinCoreDeps } from "./join-core";

// Fake values only, never real keys.
const GOOD_SECRET = "s".repeat(40);
const TURNSTILE_KEYS = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key-for-tests", TURNSTILE_SECRET_KEY: "secret-key-for-tests" };

function form(): FormData {
  const f = new FormData();
  f.set("code", "ABC234");
  f.set("firstName", "Maya");
  f.set("lastInitials", "Ro");
  f.set(TURNSTILE_RESPONSE_FIELD, "token-for-tests");
  return f;
}

// Every outside dependency, recording each call. The DB is the real join
// core (joinClassWith: the rate limits, then the insert) on a recording
// executor, and the bot check is the real verifyJoinBotCheck on a
// recording fetch, so "not called" covers the limiters, the insert, and
// Turnstile's network call.
function spies(env: JoinCoreDeps["env"]) {
  const calls = { bot: 0, fetch: 0, headers: 0, joinClass: 0, retryClock: 0, statements: [] as Statement[][] };
  const blockedLogs: [string, JoinBlockedConfig][] = [];
  const errorLogs: unknown[][] = [];
  const deps: JoinCoreDeps = {
    env,
    verifyBotCheck: (token) => {
      calls.bot++;
      return verifyJoinBotCheck(
        { token },
        {
          env,
          fetch: async () => {
            calls.fetch++;
            return new Response(JSON.stringify({ success: true, action: "join" }), {
              headers: { "content-type": "application/json" },
            });
          },
          logError: () => {},
        },
      );
    },
    requestHeaders: async () => {
      calls.headers++;
      return () => null;
    },
    joinClass: (data, ipHash) => {
      calls.joinClass++;
      return joinClassWith(data, {
        ipHash,
        execute: async (statements) => {
          calls.statements.push(statements);
          throw new Error("test database is down");
        },
      });
    },
    retryClock: async () => {
      calls.retryClock++;
      return { now: new Date(), timeZone: "UTC", utcLabel: true };
    },
    logBlockedConfig: (tag, fields) => blockedLogs.push([tag, fields]),
    logError: (...args) => errorLogs.push(args),
  };
  return { deps, calls, blockedLogs, errorLogs };
}

const BLOCKED: { name: string; env: Record<string, string>; missing: string[] }[] = [
  {
    name: "production, both Turnstile keys missing",
    env: { NODE_ENV: "production", JOIN_IP_HASH_SECRET: GOOD_SECRET },
    missing: ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"],
  },
  {
    name: "production, the Turnstile secret key missing",
    env: { NODE_ENV: "production", JOIN_IP_HASH_SECRET: GOOD_SECRET, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key-for-tests" },
    missing: ["TURNSTILE_SECRET_KEY"],
  },
  {
    name: "VERCEL_ENV=production (NODE_ENV development), Turnstile keys missing",
    env: { NODE_ENV: "development", VERCEL_ENV: "production", JOIN_IP_HASH_SECRET: GOOD_SECRET },
    missing: ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"],
  },
  {
    name: "production, JOIN_IP_HASH_SECRET missing",
    env: { NODE_ENV: "production", ...TURNSTILE_KEYS },
    missing: ["JOIN_IP_HASH_SECRET"],
  },
  {
    name: "production, JOIN_IP_HASH_SECRET shorter than 32 characters",
    env: { NODE_ENV: "production", ...TURNSTILE_KEYS, JOIN_IP_HASH_SECRET: "short-secret-for-tests" },
    missing: ["JOIN_IP_HASH_SECRET"],
  },
  {
    name: "production, everything missing",
    env: { NODE_ENV: "production" },
    missing: ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "JOIN_IP_HASH_SECRET"],
  },
];

describe("joinClassCore: a join blocked by server setup", () => {
  for (const c of BLOCKED) {
    it(`${c.name}: JOIN_DISABLED_MESSAGE, and never the bot check, the rate limits, or the database`, async () => {
      const { deps, calls, blockedLogs, errorLogs } = spies(c.env);
      const result = await joinClassCore(form(), deps);

      assert.deepEqual(result, {
        state: { errors: { form: JOIN_DISABLED_MESSAGE }, values: { code: "ABC234", firstName: "Maya", lastInitials: "Ro" } },
      });
      assert.deepEqual(calls, { bot: 0, fetch: 0, headers: 0, joinClass: 0, retryClock: 0, statements: [] });
      // One tagged log naming the variables, never a value.
      assert.equal(blockedLogs.length, 1);
      assert.equal(blockedLogs[0][0], JOIN_BLOCKED_CONFIG_TAG);
      assert.deepEqual(blockedLogs[0][1].missing, c.missing);
      const logged = JSON.stringify(blockedLogs);
      for (const value of Object.values(c.env).filter((v) => v.length > 10)) assert.equal(logged.includes(value), false);
      assert.deepEqual(errorLogs, []);
    });
  }

  it("a form error still comes first (no setup log for a join that was never valid)", async () => {
    const { deps, calls, blockedLogs } = spies({ NODE_ENV: "production" });
    const f = form();
    f.set("code", "");
    const result = await joinClassCore(f, deps);
    assert.ok("state" in result && result.state.errors?.code);
    assert.deepEqual(blockedLogs, []);
    assert.equal(calls.joinClass + calls.bot, 0);
  });
});

describe("joinClassCore: the same spies do see a join that isn't blocked", () => {
  // Proves the test above isn't passing vacuously: with a good setup the
  // join reaches the bot check, the headers, and the rate limits.
  it("production with every setting: bot check (with its network call), then the rate limits", async () => {
    const { deps, calls, blockedLogs, errorLogs } = spies({ NODE_ENV: "production", ...TURNSTILE_KEYS, JOIN_IP_HASH_SECRET: GOOD_SECRET });
    const result = await joinClassCore(form(), deps);
    assert.deepEqual(blockedLogs, []);
    assert.equal(calls.bot, 1);
    assert.equal(calls.fetch, 1);
    assert.equal(calls.headers, 1);
    assert.equal(calls.joinClass, 1);
    // The first database batch is the rate limits (advisory locks on the
    // IP and code keys), and the fake database is down.
    assert.equal(calls.statements.length, 1);
    assert.match(calls.statements[0][0].text, /pg_advisory_xact_lock/);
    assert.deepEqual(result, {
      state: { errors: { form: JOIN_FAILED_MESSAGE }, values: { code: "ABC234", firstName: "Maya", lastInitials: "Ro" } },
    });
    assert.equal(errorLogs.length, 1);
  });

  it("local dev with no keys: no bot check network call, straight to the rate limits", async () => {
    const { deps, calls, blockedLogs } = spies({ NODE_ENV: "development" });
    await joinClassCore(form(), deps);
    assert.deepEqual(blockedLogs, []);
    assert.equal(calls.fetch, 0);
    assert.equal(calls.joinClass, 1);
    assert.equal(calls.statements.length, 1);
  });
});
