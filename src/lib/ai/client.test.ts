import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getEffortCheckModel, getQuestionModel, isQuestionWritingConfigured } from "./client";
import { QuestionWriterError } from "./errors";
import { DEFAULT_AI_MODEL } from "./settings";

// Placeholder values only; nothing here is a real key or token.
const KEY = "test-gateway-key-should-never-be-logged";
const TOKEN = "test-oidc-token-should-never-be-logged";
const VARS = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "VERCEL", "AI_MODEL", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY"];

describe("client", () => {
  const saved: Record<string, string | undefined> = {};
  const errors: unknown[][] = [];
  const consoleError = console.error;
  beforeEach(() => {
    for (const key of VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    errors.length = 0;
    console.error = (...args: unknown[]) => errors.push(args);
  });
  afterEach(() => {
    console.error = consoleError;
    for (const key of VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("with nothing set: not configured, a loud log naming the setup, and a not_configured error", () => {
    process.env.ANTHROPIC_API_KEY = KEY;
    assert.equal(isQuestionWritingConfigured(), false);
    assert.throws(getQuestionModel, (e: unknown) => e instanceof QuestionWriterError && e.kind === "not_configured");
    assert.throws(getEffortCheckModel, (e: unknown) => e instanceof QuestionWriterError && e.kind === "not_configured");
    assert.equal(errors.length, 3);
    for (const args of errors) {
      assert.match(String(args[0]), /AI Gateway is not set up: no AI_GATEWAY_API_KEY and no Vercel OIDC token/);
      assert.equal(JSON.stringify(args).includes(KEY), false);
    }
  });

  it("with a key: configured, the default model, and nothing logged", () => {
    process.env.AI_GATEWAY_API_KEY = KEY;
    assert.equal(isQuestionWritingConfigured(), true);
    const model = getQuestionModel();
    assert.equal(model.model, DEFAULT_AI_MODEL);
    assert.equal(typeof model.create, "function");
    assert.equal(JSON.stringify(model).includes(KEY), false);
    assert.equal(errors.length, 0);
  });

  it("with OIDC from the env or on Vercel: configured", () => {
    process.env.VERCEL_OIDC_TOKEN = TOKEN;
    assert.equal(isQuestionWritingConfigured(), true);
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.VERCEL = "1";
    assert.equal(isQuestionWritingConfigured(), true);
    assert.equal(getEffortCheckModel().model, DEFAULT_AI_MODEL);
    assert.equal(errors.length, 0);
  });

  it("reads the model per call: AI_MODEL, then the legacy ANTHROPIC_MODEL", () => {
    process.env.AI_GATEWAY_API_KEY = KEY;
    process.env.ANTHROPIC_MODEL = "claude-opus-5-5";
    assert.equal(getQuestionModel().model, "anthropic/claude-opus-5.5");
    process.env.AI_MODEL = "anthropic/claude-haiku-5.5";
    assert.equal(getQuestionModel().model, "anthropic/claude-haiku-5.5");
  });
});
