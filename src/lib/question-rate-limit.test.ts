import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import {
  checkQuestionGenerationLimit,
  QUESTION_GENERATION_LIMIT,
  QUESTION_GENERATION_PRUNE_HOURS,
  QUESTION_GENERATION_WINDOW_MINUTES,
  questionGenerationStatements,
} from "./question-rate-limit";

const TEACHER = "00000000-0000-4000-8000-000000000001";

function fakeExecutor(insertRows: Record<string, unknown>[]) {
  const calls: Statement[][] = [];
  const execute = async (statements: Statement[]) => {
    calls.push(statements);
    return [[{ id: TEACHER }], insertRows, []];
  };
  return { execute, calls };
}

describe("question generation limit settings", () => {
  it("allows 30 generations per 10 minutes and prunes after a day", () => {
    assert.equal(QUESTION_GENERATION_LIMIT, 30);
    assert.equal(QUESTION_GENERATION_WINDOW_MINUTES, 10);
    assert.equal(QUESTION_GENERATION_PRUNE_HOURS, 24);
  });
});

describe("questionGenerationStatements", () => {
  const [lock, insert, prune] = questionGenerationStatements(TEACHER);

  it("locks the teacher row first", () => {
    assert.match(lock.text, /^select id from teachers where id = \$1::uuid for update$/);
    assert.deepEqual(lock.params, [TEACHER]);
  });

  it("inserts only when under the limit in the window", () => {
    assert.match(insert.text, /^insert into question_generation_attempts \(teacher_id\)/);
    assert.match(insert.text, /count\(\*\) from question_generation_attempts/);
    assert.match(insert.text, /make_interval\(mins => \$2::int\)/);
    assert.match(insert.text, /\) < \$3::int/);
    assert.match(insert.text, /returning id$/);
    assert.deepEqual(insert.params, [TEACHER, 10, 30]);
  });

  it("prunes only this teacher's old rows", () => {
    assert.match(prune.text, /^delete from question_generation_attempts/);
    assert.match(prune.text, /teacher_id = \$1::uuid/);
    assert.match(prune.text, /created_at < now\(\) - make_interval\(hours => \$2::int\)/);
    assert.deepEqual(prune.params, [TEACHER, 24]);
  });

  it("never puts the teacher id in the SQL text", () => {
    for (const s of questionGenerationStatements(TEACHER)) {
      assert.equal(s.text.includes(TEACHER), false);
    }
  });
});

describe("checkQuestionGenerationLimit", () => {
  it("allows when the attempt was recorded", async () => {
    const { execute, calls } = fakeExecutor([{ id: "a" }]);
    assert.equal(await checkQuestionGenerationLimit(TEACHER, execute), true);
    assert.deepEqual(calls[0], questionGenerationStatements(TEACHER));
  });

  it("limits when the insert returned no row or the result is missing", async () => {
    assert.equal(await checkQuestionGenerationLimit(TEACHER, fakeExecutor([]).execute), false);
    assert.equal(await checkQuestionGenerationLimit(TEACHER, async () => []), false);
  });

  it("lets executor errors through, so the caller can fail closed", async () => {
    await assert.rejects(
      checkQuestionGenerationLimit(TEACHER, async () => {
        throw new Error("db down");
      }),
      /db down/,
    );
  });

  it("allows exactly 30 in a row against a counting fake", async () => {
    let count = 0;
    const execute = async (statements: Statement[]) => {
      const limit = statements[1].params[2] as number;
      if (count < limit) {
        count++;
        return [[{ id: TEACHER }], [{ id: String(count) }], []];
      }
      return [[{ id: TEACHER }], [], []];
    };
    const results: boolean[] = [];
    for (let i = 0; i < 40; i++) results.push(await checkQuestionGenerationLimit(TEACHER, execute));
    assert.equal(results.filter(Boolean).length, QUESTION_GENERATION_LIMIT);
    assert.ok(results.slice(QUESTION_GENERATION_LIMIT).every((r) => !r));
  });
});
