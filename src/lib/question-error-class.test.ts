import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APICallError } from "ai";
import { GatewayAuthenticationError, GatewayRateLimitError } from "@ai-sdk/gateway";
import {
  QUESTION_ERROR_CLASSES,
  QUESTION_ERROR_MESSAGES,
  questionErrorClass,
  questionErrorKind,
  QuestionWriterError,
  type QuestionErrorKind,
} from "./ai/errors";
import { selfQuestionsView } from "./self-questions-core";
import {
  perStudentView,
  QUESTIONS_ERROR_MESSAGE,
  QUESTIONS_UNAVAILABLE_MESSAGE,
  SELF_QUESTIONS_UNAVAILABLE_MESSAGE,
} from "./student-reading-view";

// Item 18: "service unavailable" (not set up, out of credits) versus
// transient failures (timeout, busy, a one-off error), on every screen
// that shows a question-writing error.

const api = (statusCode: number, data?: unknown) =>
  new APICallError({ message: "x", url: "https://example.test", requestBodyValues: {}, statusCode, data });

const KINDS: QuestionErrorKind[] = ["not_configured", "busy", "timeout", "failed"];

describe("questionErrorClass", () => {
  it("maps every kind: only not_configured is unavailable", () => {
    assert.deepEqual(QUESTION_ERROR_CLASSES, {
      not_configured: "unavailable",
      busy: "transient",
      timeout: "transient",
      failed: "transient",
    });
    for (const kind of KINDS) assert.equal(questionErrorClass(kind), QUESTION_ERROR_CLASSES[kind]);
  });

  it("classes real failures: no credentials, 401, 402 out of credits, 403, 404 are unavailable", () => {
    const unavailable = [
      new QuestionWriterError("not_configured", "no credentials"),
      new GatewayAuthenticationError({ message: "x", statusCode: 401 }),
      api(401),
      api(402),
      api(403),
      api(404),
    ];
    for (const error of unavailable) assert.equal(questionErrorClass(questionErrorKind(error)), "unavailable");
  });

  it("classes timeouts, busy and overloaded replies, and one-off failures as transient", () => {
    const transient = [
      new DOMException("deadline", "TimeoutError"),
      new GatewayRateLimitError({ message: "x", statusCode: 429 }),
      api(429),
      api(529),
      api(500, { error: { type: "overloaded_error" } }),
      api(500),
      api(503),
      api(400),
      new Error("boom"),
    ];
    for (const error of transient) assert.equal(questionErrorClass(questionErrorKind(error)), "transient");
  });
});

describe("question error copy by class", () => {
  it("teacher: the unavailable copy doesn't ask for a retry; transient copy can", () => {
    assert.doesNotMatch(QUESTION_ERROR_MESSAGES.not_configured, /Try again\b/);
    assert.match(QUESTION_ERROR_MESSAGES.not_configured, /check back later/);
    for (const kind of KINDS.filter((k) => questionErrorClass(k) === "transient")) {
      assert.match(QUESTION_ERROR_MESSAGES[kind], /Try again/);
      assert.notEqual(QUESTION_ERROR_MESSAGES[kind], QUESTION_ERROR_MESSAGES.not_configured);
    }
  });

  it("per-student reader: unavailable has no Try again view; transient keeps it", () => {
    for (const kind of KINDS) {
      const view = perStudentView({ status: "error", kind, message: QUESTION_ERROR_MESSAGES[kind] });
      assert.deepEqual(
        view,
        questionErrorClass(kind) === "unavailable"
          ? { kind: "unavailable", message: QUESTIONS_UNAVAILABLE_MESSAGE }
          : { kind: "error", message: QUESTIONS_ERROR_MESSAGE },
        kind,
      );
    }
  });

  it("self-learner reader: unavailable has no Try again view; transient keeps it", () => {
    for (const kind of KINDS) {
      assert.deepEqual(
        selfQuestionsView({ status: "error", kind }),
        questionErrorClass(kind) === "unavailable"
          ? { kind: "unavailable", message: SELF_QUESTIONS_UNAVAILABLE_MESSAGE }
          : { kind: "error", message: QUESTIONS_ERROR_MESSAGE },
        kind,
      );
    }
  });

  it("unavailable copy says come back later, never try again; all copy is clean", () => {
    for (const message of [QUESTIONS_UNAVAILABLE_MESSAGE, SELF_QUESTIONS_UNAVAILABLE_MESSAGE]) {
      assert.match(message, /come back later/);
      assert.doesNotMatch(message, /try again/i);
      assert.notEqual(message, QUESTIONS_ERROR_MESSAGE);
    }
    assert.match(QUESTIONS_ERROR_MESSAGE, /Try again/);
    for (const message of [
      QUESTIONS_UNAVAILABLE_MESSAGE,
      SELF_QUESTIONS_UNAVAILABLE_MESSAGE,
      QUESTIONS_ERROR_MESSAGE,
      ...Object.values(QUESTION_ERROR_MESSAGES),
    ]) {
      assert.ok(!message.includes("'"), message);
      assert.ok(!message.includes("\u2014"), message);
    }
  });
});
