import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardCreate, readingSaveFailedState } from "./create-guard";
import { SAVE_READING_FAILED_MESSAGE } from "./reading-source";
import type { ReadingDraft } from "./readings";
import { CLASS_NOT_FOUND_MESSAGE, createTeacherReadingWith, type TeacherCreateDeps, type TeacherCreateResult } from "./teacher-reading-create";
import { readingFormValues, type ReadingFormInput } from "./validate-reading";

const BODY = "The river carried the boat past the mill and into town. ".repeat(5);
const input: ReadingFormInput = {
  source: "text",
  url: "",
  title: "The river",
  bodyText: BODY,
  gradeLevel: "",
  questionCount: "3",
  questionMode: "per_student",
};
const never = <T>() => new Promise<T>(() => {});

// AbortSignal.timeout's timer doesn't keep Node's event loop alive (it is
// unref'd), so a test waiting only on it would end early.
async function keepingAlive<T>(work: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
  }
}
const rethrowNext = (error: unknown) => {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
};

function fakeDb() {
  const db = { readings: [] as ReadingDraft[], linkFetches: 0, failInsert: false };
  const deps: TeacherCreateDeps = {
    requireTeacher: async () => ({ id: "teacher-1" }),
    ownsClass: async () => true,
    recordLinkFetch: async () => {
      db.linkFetches += 1;
      return true;
    },
    linkLimitedMessage: async () => "limited",
    fetchArticle: async (url) => ({ title: "Page", text: BODY, url }),
    insertReading: async (_classId, _teacherId, draft) => {
      if (db.failInsert) throw new Error("fetch failed");
      db.readings.push(draft);
      return { id: `reading-${db.readings.length}` };
    },
    log: () => {},
  };
  return { db, deps };
}

function run(deps: TeacherCreateDeps, deadlineMs = 50): Promise<TeacherCreateResult> {
  return keepingAlive(() =>
    guardCreate(
      (preWrite) => createTeacherReadingWith("class-1", input, preWrite, deps),
      () => ({ state: readingSaveFailedState(readingFormValues(input)) }),
      { rethrow: rethrowNext, onError: () => {}, deadlineMs },
    ),
  );
}

describe("createTeacherReadingWith: a failed create writes no reading", () => {
  it("creates one reading", async () => {
    const { db, deps } = fakeDb();
    const result = await run(deps);
    assert.ok("readingId" in result && result.readingId === "reading-1" && result.draft.questionMode === "per_student");
    assert.equal(db.readings.length, 1);
  });

  const failures: { name: string; over: (deps: TeacherCreateDeps, db: ReturnType<typeof fakeDb>["db"]) => void }[] = [
    { name: "the teacher lookup throws", over: (d) => (d.requireTeacher = async () => Promise.reject(new Error("fetch failed"))) },
    { name: "the teacher lookup passes the deadline", over: (d) => (d.requireTeacher = never) },
    { name: "the class ownership check throws", over: (d) => (d.ownsClass = async () => Promise.reject(new Error("fetch failed"))) },
    { name: "the class ownership check passes the deadline", over: (d) => (d.ownsClass = never) },
    { name: "the insert fails", over: (_d, db) => (db.failInsert = true) },
  ];
  for (const { name, over } of failures) {
    it(`${name}: SAVE_READING_FAILED_MESSAGE, every value kept, no reading`, async () => {
      const { db, deps } = fakeDb();
      over(deps, db);
      const result = await run(deps);
      assert.ok("state" in result);
      assert.equal(result.state.errors?.form, SAVE_READING_FAILED_MESSAGE);
      assert.deepEqual(result.state.values, readingFormValues(input));
      assert.equal(db.readings.length, 0);
      assert.equal(db.linkFetches, 0);
    });
  }

  it("not this teacher's class: the class message, no reading", async () => {
    const { db, deps } = fakeDb();
    deps.ownsClass = async () => false;
    const result = await run(deps);
    assert.ok("state" in result && result.state.errors?.form === CLASS_NOT_FOUND_MESSAGE);
    assert.equal(result.state.values?.bodyText, BODY);
    assert.equal(db.readings.length, 0);
  });
});
