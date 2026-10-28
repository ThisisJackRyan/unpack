import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUESTIONS_ERROR_MESSAGE, type StudentReadingView } from "./student-reading-view";
import {
  elapsedMs,
  instanceAgeMs,
  logEvent,
  logPageReady,
  pageReadySource,
  pageRequestKind,
  questionsGenerateReporter,
  type PageReadySource,
} from "./timing-log";

const READING = "6f1c2a52-3c0e-4b8e-9b7a-2f0d1e4c5a6b";

function lines() {
  const out: string[] = [];
  return { out, write: (line: string) => out.push(line), parsed: () => out.map((l) => JSON.parse(l)) };
}

describe("logEvent", () => {
  it("writes one JSON line with the event first and undefined fields left out", () => {
    const { out, write, parsed } = lines();
    logEvent("x.y", { a: 1, b: "two", c: true, d: undefined }, write);
    assert.equal(out.length, 1);
    assert.ok(!out[0].includes("\n"));
    assert.deepEqual(parsed()[0], { event: "x.y", a: 1, b: "two", c: true });
    assert.ok(out[0].startsWith('{"event":"x.y"'));
  });

  it("never throws, even when the writer does", () => {
    assert.doesNotThrow(() =>
      logEvent("x.y", { a: 1 }, () => {
        throw new Error("stdout closed");
      }),
    );
  });
});

describe("elapsedMs", () => {
  it("rounds the clock's difference", () => {
    assert.equal(elapsedMs(100, () => 1_334.6), 1_235);
  });
});

describe("questionsGenerateReporter", () => {
  it("logs questions.generate with exactly the id, enums and numbers", () => {
    const { write, parsed } = lines();
    const report = questionsGenerateReporter({ readingId: READING, mode: "per_student" }, write);
    report({ outcome: "ok", durationMs: 4_210, attempts: 1, httpRequests: 2 });
    assert.deepEqual(parsed(), [
      { event: "questions.generate", readingId: READING, mode: "per_student", outcome: "ok", durationMs: 4_210, attempts: 1, httpRequests: 2 },
    ]);
  });

  it("logs failures too, with the teacher's intent, and leaves out an unknown request count", () => {
    const { write, parsed } = lines();
    const report = questionsGenerateReporter({ readingId: READING, mode: "shared", intent: "regenerate_all" }, write);
    report({ outcome: "timeout", durationMs: 110_000, attempts: 1, httpRequests: 0 });
    report({ outcome: "invalid", durationMs: 9_000, attempts: 2, httpRequests: 0 });
    assert.deepEqual(parsed(), [
      { event: "questions.generate", readingId: READING, mode: "shared", intent: "regenerate_all", outcome: "timeout", durationMs: 110_000, attempts: 1 },
      { event: "questions.generate", readingId: READING, mode: "shared", intent: "regenerate_all", outcome: "invalid", durationMs: 9_000, attempts: 2 },
    ]);
  });
});

describe("pageReadySource", () => {
  const questions: StudentReadingView = { kind: "questions", questions: [{ id: "q1", position: 1, prompt: "Why?" }] };
  const cases: [StudentReadingView, Parameters<typeof pageReadySource>[1], boolean, PageReadySource][] = [
    [questions, "shared", false, "shared"],
    [questions, "per_student", false, "cached"],
    [questions, "per_student", true, "generated"],
    [questions, "self", false, "cached"],
    [questions, "self", true, "generated"],
    [{ kind: "pending", retryAfterMs: 2_000 }, "per_student", false, "pending"],
    [{ kind: "error", message: QUESTIONS_ERROR_MESSAGE }, "shared", false, "error"],
    [{ kind: "unavailable", message: "m" }, "per_student", true, "error"],
    [{ kind: "limit_reached", message: "m" }, "per_student", false, "limited"],
    [{ kind: "throttled", message: "m" }, "per_student", false, "limited"],
    [{ kind: "calls_used_up", message: "m" }, "per_student", false, "limited"],
    [{ kind: "not_found" }, undefined, false, "not_found"],
  ];
  for (const [view, mode, generated, source] of cases) {
    it(`${view.kind}, ${mode}${generated ? ", written now" : ""}: ${source}`, () => {
      assert.equal(pageReadySource(view, mode, generated), source);
    });
  }
});

describe("pageRequestKind", () => {
  it("tells a page load from a client navigation or refresh and a prefetch", () => {
    assert.equal(pageRequestKind(new Headers()), "document");
    assert.equal(pageRequestKind(new Headers({ rsc: "1" })), "rsc");
    assert.equal(pageRequestKind(new Headers({ rsc: "1", "next-router-prefetch": "1" })), "prefetch");
  });
});

describe("logPageReady", () => {
  it("logs questions.page_ready with exactly the fields given", () => {
    const { write, parsed } = lines();
    logPageReady(
      {
        readingId: READING,
        mode: "shared",
        path: "class",
        source: "shared",
        questionsMs: 41,
        totalMs: 180,
        request: "document",
        instanceAgeMs: 900,
      },
      write,
    );
    assert.deepEqual(parsed(), [
      {
        event: "questions.page_ready",
        readingId: READING,
        mode: "shared",
        path: "class",
        source: "shared",
        questionsMs: 41,
        totalMs: 180,
        request: "document",
        instanceAgeMs: 900,
      },
    ]);
  });

  it("leaves out the reading when there is none", () => {
    const { parsed, write } = lines();
    logPageReady({ path: "self", source: "not_found", questionsMs: 0, totalMs: 12, request: "rsc" }, write);
    assert.deepEqual(Object.keys(parsed()[0]), ["event", "path", "source", "questionsMs", "totalMs", "request"]);
  });
});

describe("instanceAgeMs", () => {
  it("is a whole number of milliseconds", () => {
    const age = instanceAgeMs();
    assert.ok(Number.isInteger(age) && age! >= 0);
  });
});
