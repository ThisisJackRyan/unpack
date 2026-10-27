import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AI_NOT_CONFIGURED_LOG, resolveAiCredentials, resolveModelId, toGatewayModelId } from "./config";
import { DEFAULT_AI_MODEL } from "./settings";

// Placeholder values only; nothing here is a real key or token.
const KEY = "test-gateway-key";
const TOKEN = "test-oidc-token";

describe("resolveAiCredentials", () => {
  it("uses an API key when one is set, even with OIDC available", () => {
    for (const env of [
      { AI_GATEWAY_API_KEY: KEY },
      { AI_GATEWAY_API_KEY: ` ${KEY}\n` },
      { AI_GATEWAY_API_KEY: KEY, VERCEL_OIDC_TOKEN: TOKEN, VERCEL: "1" },
      { AI_GATEWAY_API_KEY: KEY, NODE_ENV: "production" },
    ]) {
      assert.deepEqual(resolveAiCredentials(env), { method: "api-key", apiKey: KEY });
    }
  });

  it("uses OIDC from VERCEL_OIDC_TOKEN (vercel env pull), in dev or production", () => {
    for (const NODE_ENV of ["development", "production"]) {
      assert.deepEqual(resolveAiCredentials({ VERCEL_OIDC_TOKEN: TOKEN, NODE_ENV }), { method: "oidc", source: "env" });
    }
    assert.deepEqual(resolveAiCredentials({ AI_GATEWAY_API_KEY: "  ", VERCEL_OIDC_TOKEN: TOKEN }), {
      method: "oidc",
      source: "env",
    });
  });

  it("uses OIDC on a Vercel deployment with no env, where the token comes with each request", () => {
    for (const VERCEL_ENV of ["production", "preview"]) {
      assert.deepEqual(resolveAiCredentials({ VERCEL: "1", VERCEL_ENV, NODE_ENV: "production" }), {
        method: "oidc",
        source: "vercel",
      });
    }
  });

  it("is none with neither, in production off Vercel or in local dev", () => {
    for (const env of [
      {},
      { NODE_ENV: "production" },
      { NODE_ENV: "development" },
      { AI_GATEWAY_API_KEY: "", VERCEL_OIDC_TOKEN: " " },
      { VERCEL: "0" },
      // The old key no longer counts: the app calls the gateway only.
      { ANTHROPIC_API_KEY: "test-anthropic-key" },
    ]) {
      assert.deepEqual(resolveAiCredentials(env), { method: "none" });
    }
  });

  it("names the missing setup in the log, with no values", () => {
    assert.match(AI_NOT_CONFIGURED_LOG, /AI_GATEWAY_API_KEY/);
    assert.match(AI_NOT_CONFIGURED_LOG, /OIDC/);
    assert.match(AI_NOT_CONFIGURED_LOG, /vercel env pull/);
    assert.equal(AI_NOT_CONFIGURED_LOG.includes(KEY), false);
  });
});

describe("toGatewayModelId", () => {
  it("maps a bare Anthropic id to the gateway's naming", () => {
    assert.equal(toGatewayModelId("claude-sonnet-5-5"), "anthropic/claude-sonnet-5.5");
    assert.equal(toGatewayModelId("claude-opus-5-5"), "anthropic/claude-opus-5.5");
    assert.equal(toGatewayModelId("claude-haiku-5-5"), "anthropic/claude-haiku-5.5");
    assert.equal(toGatewayModelId("claude-fable-5-1"), "anthropic/claude-fable-5.1");
    assert.equal(toGatewayModelId("claude-sonnet-5"), "anthropic/claude-sonnet-5");
    assert.equal(toGatewayModelId("claude-sonnet-4-5-20250929"), "anthropic/claude-sonnet-4.5");
    assert.equal(toGatewayModelId(" claude-sonnet-5-5 "), "anthropic/claude-sonnet-5.5");
  });

  it("keeps an id that already has a creator", () => {
    assert.equal(toGatewayModelId("anthropic/claude-sonnet-5.5"), "anthropic/claude-sonnet-5.5");
    assert.equal(toGatewayModelId("anthropic/claude-opus-5.5"), "anthropic/claude-opus-5.5");
  });

  it("only prefixes an id in another shape", () => {
    assert.equal(toGatewayModelId("claude-3-5-haiku-20241022"), "anthropic/claude-3-5-haiku-20241022");
    assert.equal(toGatewayModelId("my-model"), "anthropic/my-model");
  });
});

describe("resolveModelId", () => {
  it("defaults to Claude Sonnet 5.5 on the gateway", () => {
    assert.equal(DEFAULT_AI_MODEL, "anthropic/claude-sonnet-5.5");
    assert.equal(resolveModelId({}), DEFAULT_AI_MODEL);
    assert.equal(resolveModelId({ AI_MODEL: " ", ANTHROPIC_MODEL: "" }), DEFAULT_AI_MODEL);
  });

  it("prefers AI_MODEL", () => {
    assert.equal(resolveModelId({ AI_MODEL: "anthropic/claude-opus-5.5" }), "anthropic/claude-opus-5.5");
    assert.equal(
      resolveModelId({ AI_MODEL: "anthropic/claude-haiku-5.5", ANTHROPIC_MODEL: "claude-opus-5-5" }),
      "anthropic/claude-haiku-5.5",
    );
    assert.equal(resolveModelId({ AI_MODEL: "claude-opus-5-5" }), "anthropic/claude-opus-5.5");
  });

  it("still reads the legacy ANTHROPIC_MODEL, bare or with a slash", () => {
    assert.equal(resolveModelId({ ANTHROPIC_MODEL: "claude-opus-5-5" }), "anthropic/claude-opus-5.5");
    assert.equal(resolveModelId({ ANTHROPIC_MODEL: "anthropic/claude-haiku-5.5" }), "anthropic/claude-haiku-5.5");
  });
});
