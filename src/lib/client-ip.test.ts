import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientIpFromHeaders, hashJoinCode, hashJoinIp, UNKNOWN_IP } from "./client-ip";

function getter(headers: Record<string, string>) {
  return (name: string) => headers[name] ?? null;
}

describe("clientIpFromHeaders", () => {
  it("takes the first hop of x-forwarded-for", () => {
    assert.equal(
      clientIpFromHeaders(getter({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1", "x-real-ip": "10.0.0.9" })),
      "203.0.113.7",
    );
  });

  it("falls back to x-real-ip, then a fixed key", () => {
    assert.equal(clientIpFromHeaders(getter({ "x-real-ip": "2001:DB8::1" })), "2001:db8::1");
    assert.equal(clientIpFromHeaders(getter({ "x-forwarded-for": " , " })), UNKNOWN_IP);
    assert.equal(clientIpFromHeaders(getter({})), "unknown");
  });
});

describe("join key hashes", () => {
  it("are deterministic SHA-256 hex and never contain the raw value", () => {
    const ip = "203.0.113.7";
    assert.equal(hashJoinIp(ip), hashJoinIp(ip));
    assert.match(hashJoinIp(ip), /^[0-9a-f]{64}$/);
    assert.ok(!hashJoinIp(ip).includes(ip));
    assert.notEqual(hashJoinIp(ip), hashJoinIp("203.0.113.8"));
  });

  it("keep IP and code keys apart even for the same text", () => {
    assert.notEqual(hashJoinIp("ABC234"), hashJoinCode("ABC234"));
  });
});
