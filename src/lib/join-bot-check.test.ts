import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOT_CHECK_DISABLED_WARNING,
  BOT_CHECK_FAILED_MESSAGE,
  BOT_CHECK_MISSING_MESSAGE,
  botCheckConfig,
  botCheckMessage,
  botCheckSiteKey,
  expectedHostnames,
  TURNSTILE_ACTION,
  TURNSTILE_TOKEN_MAX_LENGTH,
  TURNSTILE_VERIFY_URL,
  verifyJoinBotCheck,
} from "./join-bot-check";
import { JOIN_BLOCKED_CONFIG_TAG, JOIN_DISABLED_MESSAGE, JOIN_FAILED_MESSAGE, type JoinBlockedConfig } from "./validate-join";

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

// Stand-ins for a real deploy's keys (not Cloudflare test keys, so the
// action and hostname checks apply).
const REAL = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAfakeSiteKey", TURNSTILE_SECRET_KEY: "0x4AAAAfakeSecretKey" };
const PROD = { NODE_ENV: "production" };
const DEV = { NODE_ENV: "development" };
const SITE_ONLY = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: ON.NEXT_PUBLIC_TURNSTILE_SITE_KEY };
const SECRET_ONLY = { TURNSTILE_SECRET_KEY: ON.TURNSTILE_SECRET_KEY };

describe("botCheckConfig", () => {
  const onConfig = { status: "on", siteKey: ON.NEXT_PUBLIC_TURNSTILE_SITE_KEY, secretKey: ON.TURNSTILE_SECRET_KEY, hostnames: null };
  const BOTH = ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"];

  // Every combination: production or not, by each key set.
  const cases: { name: string; env: Record<string, string>; prod: unknown; nonProd: unknown }[] = [
    {
      name: "no keys",
      env: {},
      prod: { status: "misconfigured", missing: BOTH },
      nonProd: { status: "off", reason: "no_keys" },
    },
    {
      name: "blank keys",
      env: { NEXT_PUBLIC_TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: "" },
      prod: { status: "misconfigured", missing: BOTH },
      nonProd: { status: "off", reason: "no_keys" },
    },
    {
      name: "site key only",
      env: SITE_ONLY,
      prod: { status: "misconfigured", missing: ["TURNSTILE_SECRET_KEY"] },
      nonProd: { status: "misconfigured", missing: ["TURNSTILE_SECRET_KEY"] },
    },
    {
      name: "secret key only",
      env: SECRET_ONLY,
      prod: { status: "misconfigured", missing: ["NEXT_PUBLIC_TURNSTILE_SITE_KEY"] },
      nonProd: { status: "misconfigured", missing: ["NEXT_PUBLIC_TURNSTILE_SITE_KEY"] },
    },
    { name: "both keys", env: ON, prod: onConfig, nonProd: onConfig },
    {
      name: "TURNSTILE_DISABLED=1, no keys",
      env: { TURNSTILE_DISABLED: "1" },
      prod: { status: "off", reason: "disabled", warn: BOT_CHECK_DISABLED_WARNING },
      nonProd: { status: "off", reason: "disabled" },
    },
    {
      name: "TURNSTILE_DISABLED=1, one key",
      env: { ...SITE_ONLY, TURNSTILE_DISABLED: "1" },
      prod: { status: "off", reason: "disabled", warn: BOT_CHECK_DISABLED_WARNING },
      nonProd: { status: "off", reason: "disabled" },
    },
    {
      name: "TURNSTILE_DISABLED=1, both keys",
      env: { ...ON, TURNSTILE_DISABLED: "1" },
      prod: { status: "off", reason: "disabled", warn: BOT_CHECK_DISABLED_WARNING },
      nonProd: { status: "off", reason: "disabled" },
    },
  ];
  for (const c of cases) {
    it(`production, ${c.name}`, () => {
      assert.deepEqual(botCheckConfig({ ...PROD, ...c.env }), c.prod);
      // VERCEL_ENV=production counts as production even if NODE_ENV says otherwise.
      assert.deepEqual(botCheckConfig({ ...DEV, VERCEL_ENV: "production", ...c.env }), c.prod);
    });
    it(`non-production, ${c.name}`, () => {
      assert.deepEqual(botCheckConfig({ ...DEV, ...c.env }), c.nonProd);
      assert.deepEqual(botCheckConfig({ NODE_ENV: "test", ...c.env }), c.nonProd);
      assert.deepEqual(botCheckConfig({ ...DEV, VERCEL_ENV: "preview", ...c.env }), c.nonProd);
      assert.deepEqual(botCheckConfig(c.env), c.nonProd);
    });
  }

  it("TURNSTILE_DISABLED takes exactly \"1\"", () => {
    for (const value of ["true", "yes", "0", " 1", "1 ", ""]) {
      assert.equal(botCheckConfig({ ...PROD, TURNSTILE_DISABLED: value }).status, "misconfigured", value);
      assert.equal(botCheckConfig({ ...DEV, ...ON, TURNSTILE_DISABLED: value }).status, "on", value);
    }
  });

  it("gives the widget a site key only when on", () => {
    assert.equal(botCheckSiteKey(ON), ON.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
    assert.equal(botCheckSiteKey({ ...PROD, ...ON }), ON.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
    assert.equal(botCheckSiteKey({}), null);
    assert.equal(botCheckSiteKey(PROD), null);
    assert.equal(botCheckSiteKey(SITE_ONLY), null);
    assert.equal(botCheckSiteKey({ ...PROD, ...SITE_ONLY }), null);
    assert.equal(botCheckSiteKey({ ...ON, TURNSTILE_DISABLED: "1" }), null);
  });
});

describe("expectedHostnames", () => {
  it("uses TURNSTILE_EXPECTED_HOSTNAMES anywhere, trimmed and lowercased", () => {
    const env = { TURNSTILE_EXPECTED_HOSTNAMES: " Unpack.Example.org, https://www.unpack.example.org/ ,," };
    assert.deepEqual(expectedHostnames(env, REAL.TURNSTILE_SECRET_KEY), ["unpack.example.org", "www.unpack.example.org"]);
    assert.deepEqual(expectedHostnames({ ...PROD, ...env }, REAL.TURNSTILE_SECRET_KEY), [
      "unpack.example.org",
      "www.unpack.example.org",
    ]);
  });

  it("in production with no list, falls back to Vercel's hostnames", () => {
    assert.deepEqual(
      expectedHostnames(
        { ...PROD, VERCEL_PROJECT_PRODUCTION_URL: "unpack.example.org", VERCEL_URL: "unpack-abc123.vercel.app" },
        REAL.TURNSTILE_SECRET_KEY,
      ),
      ["unpack.example.org", "unpack-abc123.vercel.app"],
    );
    assert.deepEqual(expectedHostnames({ ...PROD, VERCEL_URL: "unpack-abc123.vercel.app" }, REAL.TURNSTILE_SECRET_KEY), [
      "unpack-abc123.vercel.app",
    ]);
  });

  it("in production with no list, also accepts the branch URL (a Preview deploy), deduplicated", () => {
    const preview = {
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "unpack.example.org",
      VERCEL_BRANCH_URL: "unpack-git-feat-team.vercel.app",
      VERCEL_URL: "unpack-abc123-team.vercel.app",
    };
    assert.deepEqual(expectedHostnames(preview, REAL.TURNSTILE_SECRET_KEY), [
      "unpack.example.org",
      "unpack-git-feat-team.vercel.app",
      "unpack-abc123-team.vercel.app",
    ]);
    assert.deepEqual(
      expectedHostnames({ ...PROD, VERCEL_BRANCH_URL: "Unpack-Git-Main-Team.vercel.app", VERCEL_URL: "unpack-git-main-team.vercel.app" }, REAL.TURNSTILE_SECRET_KEY),
      ["unpack-git-main-team.vercel.app"],
    );
    assert.deepEqual(
      expectedHostnames({ ...PROD, VERCEL_BRANCH_URL: "unpack-git-feat-team.vercel.app", TURNSTILE_EXPECTED_HOSTNAMES: "preview.example.org" }, REAL.TURNSTILE_SECRET_KEY),
      ["preview.example.org"],
    );
  });

  it("ignores the branch URL outside production with no list", () => {
    assert.equal(expectedHostnames({ ...DEV, VERCEL_BRANCH_URL: "unpack-git-feat-team.vercel.app" }, REAL.TURNSTILE_SECRET_KEY), null);
  });

  it("skips the check in production off Vercel with no list, and outside production with no list", () => {
    assert.equal(expectedHostnames(PROD, REAL.TURNSTILE_SECRET_KEY), null);
    assert.equal(expectedHostnames({ ...DEV, VERCEL_URL: "unpack-abc123.vercel.app" }, REAL.TURNSTILE_SECRET_KEY), null);
  });

  it("skips the check with a Cloudflare test secret, even with a list", () => {
    for (const secret of ["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"]) {
      assert.equal(expectedHostnames({ ...PROD, TURNSTILE_EXPECTED_HOSTNAMES: "unpack.example.org" }, secret), null);
    }
  });
});

describe("verifyJoinBotCheck", () => {
  it("off: passes with no network call", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ success: false }));
    assert.deepEqual(await verifyJoinBotCheck({ token: null }, { env: {}, fetch: fetchFn }), { ok: true, skipped: true });
    assert.equal(calls.length, 0);
  });

  it("misconfigured: refuses with no network call and one tagged error naming the variable", async () => {
    const SECRET_VALUE = "1x0000000000000000000000000000000AA";
    for (const [env, names, message] of [
      [{ TURNSTILE_SECRET_KEY: SECRET_VALUE }, ["NEXT_PUBLIC_TURNSTILE_SITE_KEY"], /NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set/],
      [{ ...PROD, ...SITE_ONLY }, ["TURNSTILE_SECRET_KEY"], /TURNSTILE_SECRET_KEY is not set/],
      [PROD, ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"], /NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are not set/],
    ] as const) {
      const { fetchFn, calls } = fakeFetch(() => json({ success: true }));
      const errors: [string, JoinBlockedConfig][] = [];
      const refused: Record<string, unknown>[] = [];
      const result = await verifyJoinBotCheck(
        { token: "tok" },
        { env, fetch: fetchFn, logError: (tag, fields) => errors.push([tag, fields]), onFailureFields: (f) => refused.push(f) },
      );
      assert.deepEqual(result, { ok: false, reason: "misconfigured" });
      assert.equal(calls.length, 0);
      assert.equal(errors.length, 1);
      const [tag, fields] = errors[0];
      assert.equal(tag, JOIN_BLOCKED_CONFIG_TAG);
      assert.deepEqual(Object.keys(fields).sort(), ["message", "missing"]);
      assert.deepEqual(fields.missing, names);
      assert.match(fields.message, message);
      assert.doesNotMatch(JSON.stringify(errors), /1x0000/);
      assert.deepEqual(refused, []);
    }
  });

  it("misconfigured: logs to console.error by default, once, with no key value", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const site = "site-key-value-should-not-be-logged";
    await verifyJoinBotCheck({ token: "tok" }, { env: { ...PROD, NEXT_PUBLIC_TURNSTILE_SITE_KEY: site } });
    assert.equal(logged.mock.callCount(), 1);
    const args = logged.mock.calls[0].arguments;
    assert.equal(args[0], JOIN_BLOCKED_CONFIG_TAG);
    assert.deepEqual((args[1] as JoinBlockedConfig).missing, ["TURNSTILE_SECRET_KEY"]);
    assert.ok(!JSON.stringify(args).includes(site));
  });

  it("production, no keys: the student is told joining isn’t working right now", async () => {
    const result = await verifyJoinBotCheck({ token: "tok" }, { env: PROD, logError: () => {} });
    assert.ok(!result.ok);
    assert.equal(botCheckMessage(result.reason), JOIN_DISABLED_MESSAGE);
  });

  it("TURNSTILE_DISABLED=1 in production: passes, warns every time, no network call", async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ success: false }));
    const warnings: string[] = [];
    for (const env of [{ ...PROD, TURNSTILE_DISABLED: "1" }, { ...PROD, ...ON, TURNSTILE_DISABLED: "1" }]) {
      assert.deepEqual(await verifyJoinBotCheck({ token: null }, { env, fetch: fetchFn, logWarn: (m) => warnings.push(m) }), {
        ok: true,
        skipped: true,
      });
    }
    assert.deepEqual(warnings, [BOT_CHECK_DISABLED_WARNING, BOT_CHECK_DISABLED_WARNING]);
    assert.equal(calls.length, 0);
  });

  it("TURNSTILE_DISABLED=1 outside production: passes quietly", async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    for (const env of [{ TURNSTILE_DISABLED: "1" }, { ...DEV, ...SITE_ONLY, TURNSTILE_DISABLED: "1" }]) {
      assert.deepEqual(
        await verifyJoinBotCheck({ token: null }, { env, logWarn: (m) => warnings.push(m), logError: (m) => errors.push(m) }),
        { ok: true, skipped: true },
      );
    }
    assert.deepEqual([warnings, errors], [[], []]);
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

  it("on, test secret: an empty or missing action passes", async () => {
    for (const reply of [{ success: true, action: "" }, { success: true }]) {
      const { fetchFn } = fakeFetch(() => json(reply));
      assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: ON, fetch: fetchFn }), { ok: true, skipped: false });
    }
  });

  it("on, real secret: the action must be the join's", async () => {
    const { fetchFn } = fakeFetch(() => json({ success: true, action: TURNSTILE_ACTION, hostname: "anything.example" }));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: REAL, fetch: fetchFn }), { ok: true, skipped: false });
    for (const reply of [{ success: true, action: "" }, { success: true }, { success: true, action: null }]) {
      const { fetchFn: f } = fakeFetch(() => json(reply));
      const logged: Record<string, unknown>[] = [];
      assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env: REAL, fetch: f, onFailureFields: (x) => logged.push(x) }), {
        ok: false,
        reason: "rejected",
      });
      assert.deepEqual(logged, [{ reason: "rejected", errorCodes: ["action-mismatch"] }]);
    }
  });

  it("on, a token for another action: refuses, test secret or not", async () => {
    for (const env of [ON, REAL]) {
      const { fetchFn } = fakeFetch(() => json({ success: true, action: "login" }));
      assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env, fetch: fetchFn }), { ok: false, reason: "rejected" });
    }
  });

  it("on, expected hostnames: a match passes (any case), a mismatch or missing hostname refuses", async () => {
    const env = { ...PROD, ...REAL, TURNSTILE_EXPECTED_HOSTNAMES: "unpack.example.org,www.unpack.example.org" };
    for (const hostname of ["unpack.example.org", "WWW.unpack.example.org"]) {
      const { fetchFn } = fakeFetch(() => json({ success: true, action: TURNSTILE_ACTION, hostname }));
      assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env, fetch: fetchFn }), { ok: true, skipped: false });
    }
    for (const hostname of ["evil.example.com", "", undefined, 42]) {
      const { fetchFn } = fakeFetch(() => json({ success: true, action: TURNSTILE_ACTION, hostname }));
      const logged: Record<string, unknown>[] = [];
      assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env, fetch: fetchFn, onFailureFields: (x) => logged.push(x) }), {
        ok: false,
        reason: "rejected",
      });
      assert.deepEqual(logged[0].errorCodes, ["hostname-mismatch"]);
    }
  });

  it("on, production on Vercel with no list: checks against Vercel's hostnames", async () => {
    const env = { ...PROD, ...REAL, VERCEL_PROJECT_PRODUCTION_URL: "unpack.example.org", VERCEL_URL: "unpack-abc123.vercel.app" };
    const ok = fakeFetch(() => json({ success: true, action: TURNSTILE_ACTION, hostname: "unpack-abc123.vercel.app" }));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env, fetch: ok.fetchFn }), { ok: true, skipped: false });
    const bad = fakeFetch(() => json({ success: true, action: TURNSTILE_ACTION, hostname: "other.vercel.app" }));
    assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env, fetch: bad.fetchFn }), { ok: false, reason: "rejected" });
  });

  it("on, no hostname list (or a test secret): the hostname isn't checked", async () => {
    for (const env of [{ ...PROD, ...REAL }, { ...PROD, ...ON, TURNSTILE_EXPECTED_HOSTNAMES: "unpack.example.org" }]) {
      const action = env.TURNSTILE_SECRET_KEY === REAL.TURNSTILE_SECRET_KEY ? TURNSTILE_ACTION : "";
      const { fetchFn } = fakeFetch(() => json({ success: true, action, hostname: "example.com" }));
      assert.deepEqual(await verifyJoinBotCheck({ token: "tok" }, { env, fetch: fetchFn }), { ok: true, skipped: false });
    }
  });

  it("on, success: false: refuses and logs only the error codes", async () => {
    const { fetchFn } = fakeFetch(() => json({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    const logged: Record<string, unknown>[] = [];
    const result = await verifyJoinBotCheck({ token: "secret-token" }, { env: ON, fetch: fetchFn, onFailureFields: (f) => logged.push(f) });
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
      { env: ON, fetch: fetchFn, timeoutMs: 20, onFailureFields: (f) => logged.push(f) },
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
  it("asks to finish the check when there was no token, says joining is off when misconfigured, else to try again", () => {
    assert.equal(botCheckMessage("missing_token"), BOT_CHECK_MISSING_MESSAGE);
    assert.equal(botCheckMessage("rejected"), BOT_CHECK_FAILED_MESSAGE);
    assert.equal(botCheckMessage("unavailable"), BOT_CHECK_FAILED_MESSAGE);
    assert.equal(botCheckMessage("misconfigured"), JOIN_DISABLED_MESSAGE);
    for (const reason of ["missing_token", "rejected", "unavailable", "misconfigured"] as const) {
      assert.notEqual(botCheckMessage(reason), JOIN_FAILED_MESSAGE, reason);
    }
    for (const m of [BOT_CHECK_MISSING_MESSAGE, BOT_CHECK_FAILED_MESSAGE, JOIN_DISABLED_MESSAGE]) {
      assert.doesNotMatch(m, /'|\u2014/);
    }
  });
});
