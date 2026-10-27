import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEV_JOIN_IP_HASH_SECRET, JOIN_IP_HASH_SECRET_PLACEHOLDER } from "./client-ip";
import { botCheckMisconfiguredError } from "./join-bot-check";
import { joinConfigBlock } from "./join-config";
import { JOIN_BLOCKED_CONFIG_TAG, logJoinBlockedConfig } from "./validate-join";

// Made-up values that must never show up in a log.
const IP_SECRET = "made-up-ip-hash-secret-".padEnd(44, "q");
const SITE_KEY = "made-up-site-key-value";
const SECRET_KEY = "made-up-turnstile-secret-value";
const KEYS = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET_KEY: SECRET_KEY };
const PROD = { NODE_ENV: "production" };
const READY = { ...PROD, ...KEYS, JOIN_IP_HASH_SECRET: IP_SECRET };

// The one line logJoinBlockedConfig writes for this env, as a string.
function logged(env: Record<string, string | undefined>): { calls: unknown[][]; text: string } {
  const calls: unknown[][] = [];
  const blocked = joinConfigBlock(env);
  if (blocked) logJoinBlockedConfig(blocked, (...args) => calls.push(args));
  return { calls, text: JSON.stringify(calls) };
}

describe("joinConfigBlock", () => {
  it("lets joins through when production is set up, or with the opt-out", () => {
    assert.equal(joinConfigBlock(READY), null);
    assert.equal(joinConfigBlock({ ...PROD, TURNSTILE_DISABLED: "1", JOIN_IP_HASH_SECRET: IP_SECRET }), null);
    assert.equal(joinConfigBlock({ VERCEL_ENV: "production", ...KEYS, JOIN_IP_HASH_SECRET: IP_SECRET }), null);
  });

  it("lets joins through outside production with no setup at all", () => {
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
      assert.equal(joinConfigBlock(env), null);
      assert.equal(joinConfigBlock({ ...env, JOIN_IP_HASH_SECRET: DEV_JOIN_IP_HASH_SECRET }), null);
      assert.equal(joinConfigBlock({ ...env, JOIN_IP_HASH_SECRET: "short" }), null);
    }
  });

  it("blocks on the Turnstile keys with the bot check's own message", () => {
    for (const [env, missing] of [
      [{ ...PROD, JOIN_IP_HASH_SECRET: IP_SECRET }, ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]],
      [{ ...READY, TURNSTILE_SECRET_KEY: undefined }, ["TURNSTILE_SECRET_KEY"]],
      [{ ...READY, NEXT_PUBLIC_TURNSTILE_SITE_KEY: " " }, ["NEXT_PUBLIC_TURNSTILE_SITE_KEY"]],
      // Outside production, one key alone is a typo: blocked too.
      [{ TURNSTILE_SECRET_KEY: SECRET_KEY }, ["NEXT_PUBLIC_TURNSTILE_SITE_KEY"]],
    ] as const) {
      assert.deepEqual(joinConfigBlock(env), { missing, message: botCheckMisconfiguredError([...missing]) });
    }
  });

  it("blocks in production on a missing, short, example, or dev-only JOIN_IP_HASH_SECRET", () => {
    for (const env of [PROD, { VERCEL_ENV: "production" }]) {
      for (const value of [undefined, "", "x".repeat(31), JOIN_IP_HASH_SECRET_PLACEHOLDER, DEV_JOIN_IP_HASH_SECRET]) {
        const blocked = joinConfigBlock({ ...env, ...KEYS, JOIN_IP_HASH_SECRET: value });
        assert.ok(blocked, String(value));
        assert.deepEqual(blocked.missing, ["JOIN_IP_HASH_SECRET"]);
        assert.match(blocked.message, /^JOIN_IP_HASH_SECRET is (missing or shorter than 32|still the example or dev-only value)/);
      }
    }
  });

  it("names everything missing in one block", () => {
    const blocked = joinConfigBlock(PROD);
    assert.ok(blocked);
    assert.deepEqual(blocked.missing, ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "JOIN_IP_HASH_SECRET"]);
    assert.match(blocked.message, /Turnstile/);
    assert.match(blocked.message, /JOIN_IP_HASH_SECRET is missing/);
  });
});

describe("the join_blocked_config log", () => {
  it("is one tagged line with names and the message, never a value", () => {
    const cases = [
      { ...READY, TURNSTILE_SECRET_KEY: undefined },
      { ...READY, NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined },
      { ...READY, JOIN_IP_HASH_SECRET: "short-but-secret" },
      { ...READY, JOIN_IP_HASH_SECRET: JOIN_IP_HASH_SECRET_PLACEHOLDER },
      { ...READY, JOIN_IP_HASH_SECRET: DEV_JOIN_IP_HASH_SECRET },
    ];
    for (const env of cases) {
      const { calls, text } = logged(env);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], JOIN_BLOCKED_CONFIG_TAG);
      assert.deepEqual(Object.keys(calls[0][1] as object).sort(), ["message", "missing"]);
      for (const value of [IP_SECRET, SITE_KEY, SECRET_KEY, "short-but-secret", JOIN_IP_HASH_SECRET_PLACEHOLDER, DEV_JOIN_IP_HASH_SECRET]) {
        assert.ok(!text.includes(value), value);
      }
    }
  });

  it("isn't written when joins can go ahead", () => {
    assert.deepEqual(logged(READY).calls, []);
  });
});
