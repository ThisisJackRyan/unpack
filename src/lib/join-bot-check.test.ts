import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOT_CHECK_FAILED_MESSAGE,
  BOT_CHECK_MISSING_MESSAGE,
  botCheckConfig,
  botCheckMessage,
  botCheckSiteKey,
  TURNSTILE_ACTION,
  TURNSTILE_TOKEN_MAX_LENGTH,
  TURNSTILE_VERIFY_URL,
  verifyJoinBotCheck,
} from "./join-bot-check";

// Cloudflare's public always-pass test keys (documented by Cloudflare for
// local testing; not secrets).
const ON = {
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

type Call = { url: string; init: RequestInit };

function fakeFetch(reply: () => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("botCheckConfig", () => {
  it("is on only when both keys are set", () => {
    assert.deepEqual(botCheckConfig(ON), { status: "on", siteKey: ON.NEXT_PUBLIC_TURNSTILE_SITE_KEY, secretKey: ON.TURNSTILE_SECRET_KEY });
    assert.equal(botCheckSiteKey(ON), ON.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  });

  it("is off when neither is set (or both are blank)", () => {
    assert.deepEqual(botCheckConfig({}), { status: "off" });
    assert.deepEqual(botCheckConfig({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: "" }), { status: "off" });
    assert.equal(botCheckSiteKey({}), null);
  });

  it("is misconfigured with only one key, naming the missing one", () => {
    assert.deepEqual(botCheckConfig({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site" }), {
      status: "misconfigured",
      missing: "TURNSTILE_SECRET_KEY",
    });
    assert.deepEqual(botCheckConfig({ TURNSTILE_SECRET_KEY: "secret" }), {
      status: "misconfigured",
      missing: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    });
    assert.equal(botCheckSiteKey({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site" }), null);
  });
});

describe("verifyJoinBotCheck", () => {
  it("off: passes with no network call", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ success: false }));
    assert.deepEqual(await verifyJoinBotCheck({ token: null }, { env: {}, fetch: fetchFn }), { ok: true, skipped: true });
    assert.equal(calls.length, 0);
  });

  it("misconfigured: refuses with no network call", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ success: true }));
    const logged: Record<string, unknown>[] = [];
    const result = await verifyJoinBotCheck(
      { token: "tok" },
      { env: { TURNSTILE_SECRET_KEY: "s" }, fetch: fetchFn, onFailure: (f) => logged.push(f) },
    );
    assert.deepEqual(result, { ok: false, reason: "misconfigured" });
    assert.equal(calls.length, 0);
    assert.deepEqual(logged, [{ reason: "misconfigured", missing: "NEXT_PUBLIC_TURNSTILE_SITE_KEY" }]);
  });

  it("on, success: posts the secret and token only (no IP) and passes", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ success: true, action: TURNSTILE_ACTION, hostname: "example.com" }));
    assert.deepEqual(await verifyJoinBotCheck({ token: " tok " }, { env: ON, fetch: fetchFn }), { ok: true, skipped: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TURNSTILE_VERIFY_URL);
    assert.equal(calls[0].init.method, "POST");
    const body = calls[0].init.body as URLSearchParams;
    assert.deepEqual([...body.keys()].sort(), ["response", "secret"]);
    assert.equal(body.get("response"), "tok");
    assert.equal(body.get("secret"), ON.TURNSTILE_SECRET_KEY);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it("on, success with the test keys' empty action: passes", async () => {
    const { fetchFn } = fakeFetch(() => json({ success: true, action: "" }));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: ON, fetch: fetchFn }), { ok: true, skipped: false });
  });

  it("on, a token for another action: refuses", async () => {
    const { fetchFn } = fakeFetch(() => json({ success: true, action: "login" }));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: ON, fetch: fetchFn }), { ok: false, reason: "rejected" });
  });

  it("on, success: false: refuses and logs only the error codes", async () => {
    const { fetchFn } = fakeFetch(() => json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    const logged: Record<string, unknown>[] = [];
    const result = await verifyJoinBotCheck({ token: "secret-token" }, { env: ON, fetch: fetchFn, onFailure: (f) => logged.push(f) });
    assert.deepEqual(result, { ok: false, reason: "rejected" });
    assert.deepEqual(logged, [{ reason: "rejected", errorCodes: ["timeout-or-duplicate"] }]);
    assert.doesNotMatch(JSON.stringify(logged), /secret-token|1x0000/);
  });

  it("on, missing or blank token: refuses with no network call", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ success: true }));
    for (const token of [null, undefined, "", "   ", 42]) {
      assert.deepEqual(await verifyJoinBotCheck({ token }, { env: ON, fetch: fetchFn }), { ok: false, reason: "missing_token" });
    }
    assert.equal(calls.length, 0);
  });

  it("on, an overlong token: refuses with no network call", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ success: true }));
    const token = "x".repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1);
    assert.deepEqual(await verifyJoinBotCheck({ token }, { env: ON, fetch: fetchFn }), { ok: false, reason: "rejected" });
    assert.equal(calls.length, 0);
  });

  it("on, network error: refuses", async () => {
    const { fetchFn } = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: ON, fetch: fetchFn }), { ok: false, reason: "unavailable" });
  });

  it("on, timeout: refuses once the signal fires", async () => {
    // A fetch that never answers until its signal aborts, like a hung
    // connection.
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const logged: Record<string, unknown>[] = [];
    const started = Date.now();
    // AbortSignal.timeout's timer doesn't keep Node alive on its own.
    const keepAlive = setTimeout(() => {}, 5_000);
    const result = await verifyJoinBotCheck(
      { token: "tok" },
      { env: ON, fetch: fetchFn, timeoutMs: 20, onFailure: (f) => logged.push(f) },
    );
    clearTimeout(keepAlive);
    assert.deepEqual(result, { ok: false, reason: "unavailable" });
    assert.equal(logged[0].error, "TimeoutError");
    assert.ok(Date.now() - started < 2_000);
  });

  it("on, a reply that isn't JSON: refuses", async () => {
    const { fetchFn } = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: ON, fetch: fetchFn }), { ok: false, reason: "unavailable" });
  });

  it("on, a JSON reply without success: refuses", async () => {
    for (const body of [null, {}, { success: "true" }, []]) {
      const { fetchFn } = fakeFetch(() => json(body));
      assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: ON, fetch: fetchFn }), { ok: false, reason: "rejected" });
    }
  });

  it("on, a 5xx reply: refuses", async () => {
    const { fetchFn } = fakeFetch(() => json({ success: true }, 503));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: ON, fetch: fetchFn }), { ok: false, reason: "unavailable" });
  });
});

describe("botCheckMessage", () => {
  it("asks to finish the check when there was no token, else to try again", () => {
    assert.equal(botCheckMessage("missing_token"), BOT_CHECK_MISSING_MESSAGE);
    assert.equal(botCheckMessage("rejected"), BOT_CHECK_FAILED_MESSAGE);
    assert.equal(botCheckMessage("unavailable"), BOT_CHECK_FAILED_MESSAGE);
    assert.equal(botCheckMessage("misconfigured"), BOT_CHECK_FAILED_MESSAGE);
    for (const m of [BOT_CHECK_MISSING_MESSAGE, BOT_CHECK_FAILED_MESSAGE]) {
      assert.doesNotMatch(m, /'|\u2014/);
    }
  });
});
