import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkLinkFetchLimit,
  LINK_FETCH_LIMIT,
  LINK_FETCH_LIMITED_MESSAGE,
  LINK_FETCH_PRUNE_HOURS,
  LINK_FETCH_WINDOW_MINUTES,
  linkFetchStatements,
  type Statement,
} from "./link-rate-limit";

const TEACHER = "00000000-0000-4000-8000-000000000001";

function fakeExecutor(insertRows: Record<string, unknown>[]) {
  const calls: Statement[][] = [];
  const execute = async (statements: Statement[]) => {
    calls.push(statements);
    return [[{ id: TEACHER }], insertRows, []];
  };
  return { execute, calls };
}

describe("link fetch limit settings", () => {
  it("allows 20 fetches per 10 minutes and prunes after a day", () => {
    assert.equal(LINK_FETCH_LIMIT, 20);
    assert.equal(LINK_FETCH_WINDOW_MINUTES, 10);
    assert.equal(LINK_FETCH_PRUNE_HOURS, 24);
    assert.equal(LINK_FETCH_LIMITED_MESSAGE, "Slow down a sec. Try again in a few minutes.");
  });
});

describe("linkFetchStatements", () => {
  const [lock, insert, prune] = linkFetchStatements(TEACHER);

  it("locks the teacher row first", () => {
    assert.match(lock.text, /^select id from teachers where id = \$1::uuid for update$/);
    assert.deepEqual(lock.params, [TEACHER]);
  });

  it("inserts only when under the limit in the window", () => {
    assert.match(insert.text, /^insert into link_fetch_attempts \(teacher_id\)/);
    assert.match(insert.text, /count\(\*\) from link_fetch_attempts/);
    assert.match(insert.text, /make_interval\(mins => \$2::int\)/);
    assert.match(insert.text, /\) < \$3::int/);
    assert.match(insert.text, /returning id$/);
    assert.deepEqual(insert.params, [TEACHER, LINK_FETCH_WINDOW_MINUTES, LINK_FETCH_LIMIT]);
  });

  it("prunes only this teacher's old rows", () => {
    assert.match(prune.text, /^delete from link_fetch_attempts/);
    assert.match(prune.text, /teacher_id = \$1::uuid/);
    assert.match(prune.text, /created_at < now\(\) - make_interval\(hours => \$2::int\)/);
    assert.deepEqual(prune.params, [TEACHER, LINK_FETCH_PRUNE_HOURS]);
  });

  it("never puts the teacher id in the SQL text", () => {
    for (const s of linkFetchStatements(TEACHER)) {
      assert.equal(s.text.includes(TEACHER), false);
    }
  });
});

describe("checkLinkFetchLimit", () => {
  it("allows when the attempt was recorded", async () => {
    const { execute, calls } = fakeExecutor([{ id: "a" }]);
    assert.equal(await checkLinkFetchLimit(TEACHER, execute), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], linkFetchStatements(TEACHER));
  });

  it("limits when the insert returned no row", async () => {
    const { execute } = fakeExecutor([]);
    assert.equal(await checkLinkFetchLimit(TEACHER, execute), false);
  });

  it("limits when the result is missing", async () => {
    assert.equal(await checkLinkFetchLimit(TEACHER, async () => []), false);
  });

  it("lets executor errors through, so the caller can fail closed", async () => {
    await assert.rejects(
      checkLinkFetchLimit(TEACHER, async () => {
        throw Object.assign(new Error("db down"), { code: "57P01" });
      }),
      /db down/,
    );
  });

  it("allows exactly LINK_FETCH_LIMIT in a row against a counting fake", async () => {
    let count = 0;
    const execute = async (statements: Statement[]) => {
      const [, limit] = statements[1].params.slice(1) as number[];
      if (count < limit) {
        count++;
        return [[{ id: TEACHER }], [{ id: String(count) }], []];
      }
      return [[{ id: TEACHER }], [], []];
    };
    const results: boolean[] = [];
    for (let i = 0; i < 25; i++) results.push(await checkLinkFetchLimit(TEACHER, execute));
    assert.equal(results.filter(Boolean).length, LINK_FETCH_LIMIT);
    assert.deepEqual(results.slice(LINK_FETCH_LIMIT), [false, false, false, false, false]);
  });
});
