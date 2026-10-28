import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DbReadTimeoutError } from "@/db/read-timeout";
import {
  DeadlineError,
  failureKind,
  guardCreate,
  PRE_WRITE_DEADLINE_MS,
  readingSaveFailedState,
  withDeadline,
} from "./create-guard";
import { SAVE_READING_FAILED_MESSAGE } from "./reading-source";

// Stands in for next/navigation's unstable_rethrow.
function rethrowNext(error: unknown) {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
}
const redirectError = () => Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" });
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

describe("guardCreate", () => {
  it("is 10 seconds before the first write", () => assert.equal(PRE_WRITE_DEADLINE_MS, 10_000));

  it("passes a result through", async () => {
    const out = await guardCreate(async () => "ok", () => "failed", { rethrow: rethrowNext, onError: () => assert.fail() });
    assert.equal(out, "ok");
  });

  it("a thrown lookup becomes the failed state, logged", async () => {
    const logged: unknown[] = [];
    const kinds: string[] = [];
    const out = await guardCreate(
      async () => {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
      },
      (kind) => {
        kinds.push(kind);
        return "failed";
      },
      { rethrow: rethrowNext, onError: (e) => logged.push(e) },
    );
    assert.equal(out, "failed");
    assert.deepEqual(kinds, ["failed"]);
    assert.equal(logged.length, 1);
  });

  it("a lookup past the deadline is timed_out, at the deadline", async () => {
    const started = Date.now();
    const kinds: string[] = [];
    const out = await keepingAlive(() =>
      guardCreate(
        async (preWrite) => withDeadline(never<string>(), preWrite),
        (kind) => {
          kinds.push(kind);
          return "timed out";
        },
        { rethrow: rethrowNext, onError: () => {}, deadlineMs: 30 },
      ),
    );
    assert.equal(out, "timed out");
    assert.deepEqual(kinds, ["timed_out"]);
    assert.ok(Date.now() - started < 1_000);
  });

  it("a database read timeout is timed_out too", () => {
    assert.equal(failureKind(new DeadlineError()), "timed_out");
    assert.equal(failureKind(Object.assign(new Error("Error connecting to database"), { sourceError: new DbReadTimeoutError(15_000) })), "timed_out");
    assert.equal(failureKind(new Error("boom")), "failed");
  });

  it("lets Next's redirect through, unlogged", async () => {
    const logged: unknown[] = [];
    await assert.rejects(
      guardCreate(
        async () => {
          throw redirectError();
        },
        () => "failed",
        { rethrow: rethrowNext, onError: (e) => logged.push(e) },
      ),
      (e: unknown) => (e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT") === true,
    );
    assert.deepEqual(logged, []);
  });

  it("a failed reading create keeps every value, with the approved message", () => {
    const values = { source: "text", url: "", title: "Bees", bodyText: "A long text.", gradeLevel: "5", questionCount: "4", questionMode: "" };
    assert.deepEqual(readingSaveFailedState(values), { errors: { form: SAVE_READING_FAILED_MESSAGE }, values });
    assert.equal(SAVE_READING_FAILED_MESSAGE, "We couldn’t save the reading. Please try again.");
  });
});

describe("the create and publish actions", () => {
  const files = {
    self: "src/app/learn/new/actions.ts",
    teacher: "src/app/teacher/classes/[id]/readings/actions.ts",
    questions: "src/app/teacher/classes/[id]/readings/[readingId]/question-actions.ts",
  };

  it("run inside guardCreate, with Next's unstable_rethrow", () => {
    for (const file of Object.values(files)) {
      const source = readFileSync(file, "utf8");
      assert.match(source, /guardCreate\(/, file);
      assert.match(source, /rethrow: unstable_rethrow/, file);
    }
  });

  it("never await the account or class lookups outside the deadline", () => {
    // The account and class lookups are passed to the flows (which wrap
    // them in withDeadline), never awaited in the create actions.
    const self = readFileSync(files.self, "utf8");
    assert.doesNotMatch(self, /await requireSelfLearner\(/);
    assert.match(self, /requireAccount: requireSelfLearner,/);
    const teacher = readFileSync(files.teacher, "utf8");
    const create = teacher.slice(teacher.indexOf("export async function createReading("), teacher.indexOf("export async function updateReading("));
    assert.doesNotMatch(create, /= await (getOrCreateTeacher|getClassForTeacher)\(/);
    assert.match(create, /requireTeacher: getOrCreateTeacher,/);
    for (const flow of ["src/lib/self-reading-create.ts", "src/lib/teacher-reading-create.ts"]) {
      const source = readFileSync(flow, "utf8");
      for (const call of source.match(/await deps\.\w+\(/g) ?? []) {
        // Only the writes (and the fetch, with its own deadline) are awaited bare.
        assert.match(call, /deps\.(createSelfReading|insertReading)\(/, `${flow}: ${call}`);
      }
    }
    const questions = readFileSync(files.questions, "utf8");
    assert.doesNotMatch(questions, /await getOrCreateTeacher\(/);
    assert.match(questions, /withDeadline\(getOrCreateTeacher\(\), preWrite\)/);
    assert.match(questions, /withDeadline\(getReadingForTeacher\(classId, readingId, teacher\.id\), preWrite\)/);
    assert.match(questions, /withDeadline\(listSharedQuestions\(reading\.id\), preWrite\)/);
    // The publish write itself is not bounded.
    assert.match(questions, /if \(!\(await publishReading\(ref\)\)\) return refused\(\);/);
  });
});
