import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkJoinLimit,
  JOIN_CODE_LIMIT,
  JOIN_IP_LIMIT,
  JOIN_LIMITED_MESSAGE,
  joinLimitedMessage,
  joinRetryFromRows,
  joinRetryStatement,
  JOIN_PRUNE_BATCH,
  JOIN_WINDOW_MINUTES,
  joinAttemptStatements,
} from "./join-rate-limit";
import type { Statement } from "./link-rate-limit";

const KEYS = { ipHash: "a".repeat(64), codeHash: "b".repeat(64) };

describe("join limit settings", () => {
  it("allows 60 per IP and 100 per code per 10 minutes", () => {
    assert.equal(JOIN_IP_LIMIT, 60);
    assert.equal(JOIN_CODE_LIMIT, 100);
    assert.equal(JOIN_WINDOW_MINUTES, 10);
    assert.equal(
      JOIN_LIMITED_MESSAGE,
      "Lots of people have tried to join from here in the last few minutes, so joining is paused for a bit.",
    );
    assert.equal(joinLimitedMessage("ip"), JOIN_LIMITED_MESSAGE);
    assert.equal(
      joinLimitedMessage("code"),
      "This class code has had lots of tries in the last few minutes, so it’s paused for a bit.",
    );
  });
});

describe("joinRetryStatement", () => {
  it("frees up when the latest of the limited keys' oldest attempts leaves the window", () => {
    const s = joinRetryStatement(KEYS);
    assert.match(s.text, /where \(key_kind = 'ip' and n >= \$4::int\) or \(key_kind = 'code' and n >= \$5::int\)/);
    assert.match(s.text, /\(select max\(oldest\) \+ make_interval\(mins => \$3::int\) from at_limit\) as retry_at/);
    assert.deepEqual(s.params, [KEYS.ipHash, KEYS.codeHash, JOIN_WINDOW_MINUTES, JOIN_IP_LIMIT, JOIN_CODE_LIMIT]);
  });

  it("reads which key is limited (the code first) and the time", () => {
    const at = new Date("2026-10-27T14:40:00Z");
    assert.deepEqual(joinRetryFromRows([[{ code_limited: true, retry_at: at }]]), { by: "code", retryAt: at });
    assert.deepEqual(joinRetryFromRows([[{ code_limited: false, retry_at: "2026-10-27T14:40:00Z" }]]), { by: "ip", retryAt: at });
    assert.deepEqual(joinRetryFromRows([[{ code_limited: false, retry_at: null }]]), { by: "ip", retryAt: null });
    assert.deepEqual(joinRetryFromRows([]), { by: "ip", retryAt: null });
  });
});

describe("joinAttemptStatements", () => {
  const statements = joinAttemptStatements(KEYS);

  it("locks the IP key, then the code key, in separate lock spaces", () => {
    assert.match(statements[0].text, /pg_advisory_xact_lock\(\$1::int, hashtext\(\$2::text\)\)/);
    assert.deepEqual(statements[0].params, [1, KEYS.ipHash]);
    assert.deepEqual(statements[1].params, [2, KEYS.codeHash]);
  });

  it("inserts one row per key only when both are under their limits", () => {
    const insert = statements[2];
    assert.match(insert.text, /insert into join_attempts \(key_kind, key_hash\)/);
    assert.match(insert.text, /\('ip', \$1::text\), \('code', \$2::text\)/);
    assert.match(insert.text, /key_kind = 'ip' and key_hash = \$1::text[\s\S]*< \$4::int/);
    assert.match(insert.text, /key_kind = 'code' and key_hash = \$2::text[\s\S]*< \$5::int/);
    assert.match(insert.text, /returning key_kind/);
    assert.deepEqual(insert.params, [KEYS.ipHash, KEYS.codeHash, 10, 60, 100]);
  });

  it("prunes a batch of expired rows of any key, without waiting", () => {
    const prune = statements[3];
    assert.match(prune.text, /delete from join_attempts/);
    assert.match(prune.text, /created_at < now\(\) - make_interval\(mins => \$1::int\)/);
    assert.match(prune.text, /for update skip locked/);
    assert.deepEqual(prune.params, [JOIN_WINDOW_MINUTES, JOIN_PRUNE_BATCH]);
  });
});

describe("checkJoinLimit", () => {
  function fake(inserted: number) {
    const calls: Statement[][] = [];
    const execute = async (s: Statement[]) => {
      calls.push(s);
      return [[{}], [{}], Array.from({ length: inserted }, () => ({ key_kind: "ip" })), []];
    };
    return { execute, calls };
  }

  it("allows when both rows were recorded", async () => {
    const { execute, calls } = fake(2);
    assert.equal(await checkJoinLimit(KEYS, execute), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 4);
  });

  it("refuses when nothing was recorded", async () => {
    assert.equal(await checkJoinLimit(KEYS, fake(0).execute), false);
  });

  it("fails closed: executor errors propagate", async () => {
    await assert.rejects(
      checkJoinLimit(KEYS, async () => {
        throw new Error("db down");
      }),
      /db down/,
    );
  });
});
