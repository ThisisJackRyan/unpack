import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STUDENT_SETS_LIMITED_MESSAGE, type StudentQuestionsResult } from "./student-questions-core";
import { perStudentView, QUESTIONS_ERROR_MESSAGE, sharedView } from "./student-reading-view";

const QUESTIONS = [
  { id: "q1", position: 1, prompt: "Why?" },
  { id: "q2", position: 2, prompt: "What do you think?" },
];

describe("perStudentView", () => {
  it("routes every status", () => {
    const cases: [StudentQuestionsResult, unknown][] = [
      [{ status: "ready", questions: QUESTIONS }, { kind: "questions", questions: QUESTIONS }],
      [{ status: "pending", retryAfterMs: 2000 }, { kind: "pending", retryAfterMs: 2000 }],
      [{ status: "limit_reached" }, { kind: "limit_reached", message: STUDENT_SETS_LIMITED_MESSAGE }],
      [
        { status: "error", kind: "not_configured", message: "Question writing isn’t set up yet." },
        { kind: "error", message: QUESTIONS_ERROR_MESSAGE },
      ],
      [{ status: "not_found" }, { kind: "not_found" }],
      [{ status: "not_allowed" }, { kind: "not_found" }],
    ];
    for (const [result, view] of cases) assert.deepEqual(perStudentView(result), view, result.status);
  });

  it("renders not_allowed exactly like not_found", () => {
    assert.deepEqual(perStudentView({ status: "not_allowed" }), perStudentView({ status: "not_found" }));
  });

  it("never shows the teacher-facing error text", () => {
    const view = perStudentView({ status: "error", kind: "busy", message: "teacher text" });
    assert.deepEqual(view, { kind: "error", message: "We couldn’t get your questions ready. Try again in a moment." });
  });
});

describe("sharedView", () => {
  it("shows the shared set, or the error view when it is empty", () => {
    assert.deepEqual(sharedView(QUESTIONS), { kind: "questions", questions: QUESTIONS });
    assert.deepEqual(sharedView([]), { kind: "error", message: QUESTIONS_ERROR_MESSAGE });
  });
});
