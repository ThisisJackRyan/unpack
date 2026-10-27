import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUESTION_WRITE_DEADLINE_MS } from "./ai/settings";
import {
  PENDING_RETRY_AFTER_MS,
  STUDENT_GENERATION_THROTTLED_MESSAGE,
  STUDENT_GENERATION_USED_UP_MESSAGE,
  STUDENT_SETS_LIMITED_MESSAGE,
  type StudentQuestionsResult,
} from "./student-questions-core";
import {
  PENDING_MAX_REFRESHES,
  perStudentView,
  QUESTIONS_ERROR_MESSAGE,
  QUESTIONS_UNAVAILABLE_MESSAGE,
  readingParagraphs,
  sharedView,
  sourceHost,
} from "./student-reading-view";

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
      [{ status: "calls_used_up" }, { kind: "calls_used_up", message: STUDENT_GENERATION_USED_UP_MESSAGE }],
      [{ status: "throttled", retryAt: null }, { kind: "throttled", message: `${STUDENT_GENERATION_THROTTLED_MESSAGE} Try again in a few minutes.` }],
      [
        { status: "error", kind: "not_configured", message: "teacher text" },
        { kind: "unavailable", message: QUESTIONS_UNAVAILABLE_MESSAGE },
      ],
      [
        { status: "error", kind: "failed", message: "teacher text" },
        { kind: "error", message: QUESTIONS_ERROR_MESSAGE },
      ],
      [{ status: "not_found" }, { kind: "not_found" }],
      [{ status: "not_allowed" }, { kind: "not_found" }],
    ];
    for (const [result, view] of cases) assert.deepEqual(perStudentView(result), view, result.status);
  });

  it("tells when the Try again throttle frees up, in the reader's zone", () => {
    const clock = { now: new Date("2026-10-27T14:30:00Z"), timeZone: "UTC", utcLabel: true };
    assert.deepEqual(perStudentView({ status: "throttled", retryAt: new Date("2026-10-27T14:40:00Z") }, clock), {
      kind: "throttled",
      message: "We tried a few times to get your questions ready, so let’s take a short break. You can try again at 2:40 PM UTC.",
    });
  });

  it("out of tries: points the student to the teacher, who can reset it", () => {
    assert.equal(STUDENT_GENERATION_USED_UP_MESSAGE, "We couldn’t get your questions ready. Ask your teacher to let you try again.");
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

describe("PENDING_MAX_REFRESHES", () => {
  it("keeps refreshing past the whole write deadline, with margin", () => {
    assert.equal(PENDING_MAX_REFRESHES, 60);
    assert.ok(PENDING_MAX_REFRESHES * PENDING_RETRY_AFTER_MS >= QUESTION_WRITE_DEADLINE_MS + 10_000);
  });
});

describe("readingParagraphs", () => {
  it("splits on blank lines and keeps single line breaks", () => {
    assert.deepEqual(readingParagraphs("One.\nStill one.\n\n  Two.  \n \n\nThree."), ["One.\nStill one.", "Two.", "Three."]);
    assert.deepEqual(readingParagraphs(""), []);
  });
});

describe("sourceHost", () => {
  it("shows the host without www, or nothing", () => {
    assert.equal(sourceHost("https://www.example.com/a/b?c=1"), "example.com");
    assert.equal(sourceHost("http://news.example.org"), "news.example.org");
    assert.equal(sourceHost(null), null);
    assert.equal(sourceHost("not a url"), null);
  });
});
