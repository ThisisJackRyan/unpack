import assert from "node:assert/strict";
import { test } from "node:test";
import { COPY_STATUS_TEXT } from "./copy-status";

test("copy feedback: visible Copied!, an announcement, and a by-hand fallback", () => {
  assert.equal(COPY_STATUS_TEXT.copiedButton, "Copied!");
  assert.match(COPY_STATUS_TEXT.copiedAnnouncement, /copied/i);
  assert.match(COPY_STATUS_TEXT.failed, /Couldn’t copy/);
  for (const text of Object.values(COPY_STATUS_TEXT)) {
    assert.ok(!text.includes("'"), `straight apostrophe in ${text}`);
    assert.ok(!text.includes("\u2014"), `em dash in ${text}`);
  }
});
