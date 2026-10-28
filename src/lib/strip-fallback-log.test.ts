import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logStripFallback, type StripFallbackLog } from "./strip-fallback-log";

describe("logStripFallback", () => {
  it("writes one JSON line with the event and the fixed fields", () => {
    const lines: string[] = [];
    logStripFallback({ reason: "too_short", path: "self", readingId: "0b7c6c1e-4f8a-4d55-9d1a-3c2a1b0e9f00" }, (line) => lines.push(line));
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [
      { event: "reading.strip_fallback", reason: "too_short", path: "self", readingId: "0b7c6c1e-4f8a-4d55-9d1a-3c2a1b0e9f00" },
    ]);
  });

  it("leaves out a missing id, and never logs an extra property", () => {
    const lines: string[] = [];
    const extra = { reason: "strip_failed", path: "class", url: "https://example.com/a", title: "A title" } as StripFallbackLog;
    logStripFallback(extra, (line) => lines.push(line));
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ event: "reading.strip_fallback", reason: "strip_failed", path: "class" }]);
  });
});
