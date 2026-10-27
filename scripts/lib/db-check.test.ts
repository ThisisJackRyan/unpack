import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dbCheckRefusal, isLocalOrTestDatabase, limitConcurrency, limitedFetch } from "./db-check";

const PROXY_URL = "postgres://postgres:postgres@db.localtest.me:4445/unpack_test";

describe("isLocalOrTestDatabase", () => {
  it("accepts local hosts, *.localtest.me, and test database names", () => {
    for (const url of [
      PROXY_URL,
      "postgres://u:p@localhost:5432/unpack",
      "postgresql://u:p@127.0.0.1/unpack",
      "postgres://u:p@[::1]:5432/unpack",
      "postgres://u:p@LOCALHOST/unpack",
      "postgres://u:p@other.localtest.me/unpack",
      "postgres://u:p@ep-cool-1.us-east-2.aws.neon.tech/unpack_test?sslmode=require",
      "postgres://u:p@db.example.org/Test_DB",
    ]) {
      assert.equal(isLocalOrTestDatabase(url), true, url);
    }
  });

  it("refuses a production-like Neon URL and anything else", () => {
    for (const url of [
      "postgresql://user:password@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require",
      "postgres://u:p@ep-cool-1-pooler.us-east-2.aws.neon.tech/unpack?sslmode=require",
      "postgres://u:p@localtest.me.evil.example/unpack",
      "postgres://u:p@notlocalhost/unpack",
      // "test" only counts in the database name, not the host or the user.
      "postgres://test:test@test.neon.tech/unpack",
      "postgres://u:p@ep-1.neon.tech/unpack?options=test",
      "https://localhost/unpack",
      "not a url",
      "",
    ]) {
      assert.equal(isLocalOrTestDatabase(url), false, url);
    }
  });
});

describe("dbCheckRefusal", () => {
  it("runs only with a local or test database and ALLOW_DB_WRITES=1", () => {
    assert.equal(dbCheckRefusal({ DATABASE_URL: PROXY_URL, ALLOW_DB_WRITES: "1" }), null);
    assert.match(dbCheckRefusal({ ALLOW_DB_WRITES: "1" }) ?? "", /DATABASE_URL is not set/);
    assert.match(dbCheckRefusal({ DATABASE_URL: PROXY_URL }) ?? "", /ALLOW_DB_WRITES=1/);
    assert.match(dbCheckRefusal({ DATABASE_URL: PROXY_URL, ALLOW_DB_WRITES: "true" }) ?? "", /ALLOW_DB_WRITES=1/);
  });

  it("refuses a production-like URL without printing any of it", () => {
    const url = "postgresql://owner:s3cret-pass@ep-prod-77.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const message = dbCheckRefusal({ DATABASE_URL: url, ALLOW_DB_WRITES: "1" }) ?? "";
    assert.match(message, /Refusing to run/);
    for (const part of ["s3cret-pass", "owner", "ep-prod-77", "neondb", "neon.tech"]) assert.ok(!message.includes(part), part);
  });

  it("every check script uses the guard first", () => {
    const dir = new URL("../", import.meta.url);
    const scripts = readdirSync(dir).filter((f) => /^check-.*\.ts$/.test(f));
    assert.ok(scripts.length >= 8);
    for (const file of scripts) {
      const text = readFileSync(new URL(file, dir), "utf8");
      assert.match(text, /import \{[^}]*prepareDbCheck[^}]*\} from "\.\/lib\/db-check";/, file);
      const body = text.slice(text.lastIndexOf("\nimport ") + 1);
      const call = body.indexOf("prepareDbCheck(");
      assert.ok(call >= 0, file);
      for (const query of ["getSql(", "neonExecutor(", "await "]) {
        const at = body.indexOf(query);
        assert.ok(at === -1 || at > call, `${file}: ${query} before prepareDbCheck`);
      }
      assert.ok(!/LOCAL_DB_HOSTS|CHECK_CLASS_LIMIT_HOST/.test(text), `${file} has its own guard`);
    }
  });
});

describe("limitConcurrency", () => {
  it("never runs more than max at once, and runs them all", async () => {
    const limit = limitConcurrency(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
          return i;
        }),
      ),
    );
    assert.equal(peak, 3);
    assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => i));
  });

  it("frees the slot when a task throws", async () => {
    const limit = limitConcurrency(1);
    await assert.rejects(limit(async () => Promise.reject(new Error("boom"))));
    assert.equal(await limit(async () => "next"), "next");
  });

  it("limitedFetch holds the slot until the body is read", async () => {
    let active = 0;
    let peak = 0;
    const base = (async () => {
      active++;
      peak = Math.max(peak, active);
      const body = new ReadableStream({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 2));
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
          active--;
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const fetch2 = limitedFetch(limitConcurrency(2), base);
    const bodies = await Promise.all(Array.from({ length: 6 }, () => fetch2("http://x/").then((r) => r.text())));
    assert.deepEqual(bodies, Array(6).fill("{}"));
    assert.equal(peak, 2);
  });
});
