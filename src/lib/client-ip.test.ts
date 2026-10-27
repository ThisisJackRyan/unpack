import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  clientIpFromHeaders,
  DEV_JOIN_IP_HASH_SECRET,
  hashJoinCode,
  JOIN_IP_HASH_SECRET_PLACEHOLDER,
  hashJoinIp,
  ipRateLimitKey,
  joinIpHashSecret,
  joinIpHashSecretProblem,
  UNKNOWN_IP,
} from "./client-ip";

function getter(headers: Record<string, string>) {
  return (name: string) => headers[name] ?? null;
}

const SECRET = "test-secret-".padEnd(40, "x");

describe("clientIpFromHeaders", () => {
  it("prefers x-vercel-forwarded-for, then x-real-ip, then x-forwarded-for", () => {
    assert.equal(
      clientIpFromHeaders(
        getter({
          "x-vercel-forwarded-for": " 203.0.113.7 , 10.0.0.1",
          "x-real-ip": "10.0.0.9",
          "x-forwarded-for": "10.0.0.8",
        }),
      ),
      "203.0.113.7",
    );
    assert.equal(
      clientIpFromHeaders(getter({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.8" })),
      "203.0.113.9",
    );
    assert.equal(clientIpFromHeaders(getter({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" })), "203.0.113.7");
  });

  it("skips empty headers and falls back to a fixed key", () => {
    assert.equal(
      clientIpFromHeaders(getter({ "x-vercel-forwarded-for": " ", "x-forwarded-for": "203.0.113.7" })),
      "203.0.113.7",
    );
    assert.equal(clientIpFromHeaders(getter({ "x-forwarded-for": " , " })), UNKNOWN_IP);
    assert.equal(clientIpFromHeaders(getter({})), "unknown");
  });

  it("buckets IPv6 to its /64", () => {
    assert.equal(clientIpFromHeaders(getter({ "x-real-ip": "2001:DB8::1" })), "2001:db8:0:0::/64");
  });
});

describe("ipRateLimitKey", () => {
  it("keeps IPv4 as it is, without a port", () => {
    assert.equal(ipRateLimitKey("203.0.113.7"), "203.0.113.7");
    assert.equal(ipRateLimitKey("203.0.113.7:51234"), "203.0.113.7");
  });

  it("puts every address in one IPv6 /64 on one key", () => {
    const key = "2001:db8:1:2::/64";
    for (const ip of [
      "2001:db8:1:2::1",
      "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd",
      "2001:DB8:1:2:ffff::",
      "[2001:db8:1:2::9]:443",
      "[2001:db8:1:2::9]",
      "2001:db8:1:2::1%eth0",
    ]) {
      assert.equal(ipRateLimitKey(ip), key, ip);
    }
    assert.notEqual(ipRateLimitKey("2001:db8:1:3::1"), key);
    assert.equal(ipRateLimitKey("::1"), "0:0:0:0::/64");
    assert.equal(ipRateLimitKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  });

  it("reads IPv4-mapped IPv6 as the IPv4 address", () => {
    assert.equal(ipRateLimitKey("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(ipRateLimitKey("::FFFF:cb00:7107"), "203.0.113.7");
    assert.equal(ipRateLimitKey("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
  });

  it("falls back to the unknown key when junk is empty once the zone id goes", () => {
    for (const junk of ["%eth0:1", "%:", "%25::1", " %x:y "]) {
      assert.equal(ipRateLimitKey(junk), UNKNOWN_IP, junk);
    }
    assert.equal(clientIpFromHeaders(getter({ "x-real-ip": "%eth0:1" })), UNKNOWN_IP);
  });

  it("keeps text that isn't an IP, lowercased", () => {
    assert.equal(ipRateLimitKey("Not-An-IP"), "not-an-ip");
    assert.equal(ipRateLimitKey("1:2:3"), "1:2:3");
    assert.equal(ipRateLimitKey("::ffff:999.0.0.1"), "::ffff:999.0.0.1");
  });
});

describe("joinIpHashSecret", () => {
  it("uses JOIN_IP_HASH_SECRET when set", () => {
    assert.equal(joinIpHashSecret({ NODE_ENV: "production", JOIN_IP_HASH_SECRET: SECRET }), SECRET);
    assert.equal(joinIpHashSecret({ NODE_ENV: "development", JOIN_IP_HASH_SECRET: SECRET }), SECRET);
  });

  it("throws in production without a secret, or with a short one", () => {
    assert.throws(() => joinIpHashSecret({ NODE_ENV: "production" }), /JOIN_IP_HASH_SECRET is missing/);
    assert.throws(() => joinIpHashSecret({ NODE_ENV: "production", JOIN_IP_HASH_SECRET: "" }));
    assert.throws(
      () => joinIpHashSecret({ NODE_ENV: "production", JOIN_IP_HASH_SECRET: "short-secret-value" }),
      (error: Error) => !error.message.includes("short-secret-value"),
    );
    assert.throws(() => joinIpHashSecret({ NODE_ENV: "production", JOIN_IP_HASH_SECRET: "x".repeat(31) }));
    assert.equal(joinIpHashSecret({ NODE_ENV: "production", JOIN_IP_HASH_SECRET: "x".repeat(32) }), "x".repeat(32));
  });

  it("treats VERCEL_ENV=production as production", () => {
    assert.throws(() => joinIpHashSecret({ NODE_ENV: "development", VERCEL_ENV: "production" }), /JOIN_IP_HASH_SECRET/);
    assert.equal(joinIpHashSecret({ VERCEL_ENV: "production", JOIN_IP_HASH_SECRET: SECRET }), SECRET);
    assert.equal(joinIpHashSecret({ NODE_ENV: "development", VERCEL_ENV: "preview" }), DEV_JOIN_IP_HASH_SECRET);
  });

  it("refuses the .env.example placeholder and the dev secret in production, by name only", () => {
    for (const env of [{ NODE_ENV: "production" }, { VERCEL_ENV: "production" }]) {
      for (const value of [JOIN_IP_HASH_SECRET_PLACEHOLDER, DEV_JOIN_IP_HASH_SECRET]) {
        assert.throws(
          () => joinIpHashSecret({ ...env, JOIN_IP_HASH_SECRET: value }),
          (error: Error) => error.message.includes("JOIN_IP_HASH_SECRET") && !error.message.includes(value),
        );
      }
    }
  });

  it("keeps the placeholder in step with .env.example", () => {
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const line = example.split("\n").find((l) => l.startsWith("JOIN_IP_HASH_SECRET="));
    assert.equal(line, `JOIN_IP_HASH_SECRET=${JOIN_IP_HASH_SECRET_PLACEHOLDER}`);
  });

  it("falls back to the dev secret outside production", () => {
    assert.equal(joinIpHashSecret({ NODE_ENV: "development" }), DEV_JOIN_IP_HASH_SECRET);
    assert.equal(joinIpHashSecret({ NODE_ENV: "test" }), DEV_JOIN_IP_HASH_SECRET);
    assert.equal(joinIpHashSecret({}), DEV_JOIN_IP_HASH_SECRET);
  });
});

describe("joinIpHashSecretProblem", () => {
  it("names the variable, never the value, for each unusable secret in production", () => {
    for (const env of [{ NODE_ENV: "production" }, { VERCEL_ENV: "production" }]) {
      for (const [value, message] of [
        [undefined, /missing or shorter than 32/],
        ["", /missing or shorter than 32/],
        ["short-secret-value", /missing or shorter than 32/],
        [JOIN_IP_HASH_SECRET_PLACEHOLDER, /example or dev-only value/],
        [DEV_JOIN_IP_HASH_SECRET, /example or dev-only value/],
      ] as const) {
        const problem = joinIpHashSecretProblem({ ...env, JOIN_IP_HASH_SECRET: value });
        assert.ok(problem, String(value));
        assert.deepEqual(problem.missing, ["JOIN_IP_HASH_SECRET"]);
        assert.match(problem.message, message);
        if (value) assert.ok(!JSON.stringify(problem).includes(value));
        // The throwing backstop says the same thing.
        assert.throws(() => joinIpHashSecret({ ...env, JOIN_IP_HASH_SECRET: value }), { message: problem.message });
      }
    }
  });

  it("is null for a real secret in production, and always outside production", () => {
    assert.equal(joinIpHashSecretProblem({ NODE_ENV: "production", JOIN_IP_HASH_SECRET: SECRET }), null);
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }, { NODE_ENV: "development", VERCEL_ENV: "preview" }]) {
      for (const value of [undefined, "short", JOIN_IP_HASH_SECRET_PLACEHOLDER, DEV_JOIN_IP_HASH_SECRET]) {
        assert.equal(joinIpHashSecretProblem({ ...env, JOIN_IP_HASH_SECRET: value }), null);
      }
    }
  });
});

describe("join key hashes", () => {
  const ip = "203.0.113.7";

  it("hash the IP with HMAC-SHA256, not plain SHA-256", () => {
    const plain = createHash("sha256").update(`join-ip:${ip}`).digest("hex");
    assert.notEqual(hashJoinIp(ip, SECRET), plain);
    assert.match(hashJoinIp(ip, SECRET), /^[0-9a-f]{64}$/);
  });

  it("are deterministic, depend on the secret, and never contain the raw value", () => {
    assert.equal(hashJoinIp(ip, SECRET), hashJoinIp(ip, SECRET));
    assert.notEqual(hashJoinIp(ip, SECRET), hashJoinIp(ip, `${SECRET}y`));
    assert.ok(!hashJoinIp(ip, SECRET).includes(ip));
    assert.notEqual(hashJoinIp(ip, SECRET), hashJoinIp("203.0.113.8", SECRET));
  });

  it("default to the secret from the environment", () => {
    assert.equal(hashJoinIp(ip), hashJoinIp(ip, joinIpHashSecret()));
  });

  it("keep the code key plain SHA-256", () => {
    assert.equal(hashJoinCode("ABC234"), createHash("sha256").update("join-code:ABC234").digest("hex"));
  });

  it("keep IP and code keys apart even for the same text", () => {
    assert.notEqual(hashJoinIp("ABC234"), hashJoinCode("ABC234"));
  });
});
