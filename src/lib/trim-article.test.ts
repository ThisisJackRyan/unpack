import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trimToLimit } from "./trim-article";
import {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_MIN_LENGTH,
  normalizeBodyText,
  validateReadingForm,
} from "./validate-reading";

const MAX = BODY_TEXT_MAX_LENGTH;
const MIN = BODY_TEXT_MIN_LENGTH;

// A paragraph of exactly n characters made of sentences, ending in ".".
function paragraph(n: number, word = "bees"): string {
  const sentence = `The ${word} fly over the field and come back home. `;
  const body = sentence.repeat(Math.ceil(n / sentence.length)).slice(0, n - 1);
  return `${body.replace(/\s$/, "s")}.`;
}

// What every result must be: within the limits, normalized, and accepted
// by the form's own validation as pasted text.
function assertSavable(text: string) {
  assert.ok(text.length <= MAX, `over the limit: ${text.length}`);
  assert.ok(text.length >= MIN, `under the minimum: ${text.length}`);
  assert.equal(normalizeBodyText(text), text);
  const check = validateReadingForm({
    source: "text",
    url: "",
    title: "T",
    bodyText: text,
    gradeLevel: "",
    questionCount: "3",
    questionMode: "shared",
  });
  assert.ok(check.ok, JSON.stringify(!check.ok && check.errors));
}

describe("trimToLimit", () => {
  it("leaves text at the limit untouched", () => {
    const text = `${paragraph(1000)}\n\n${"x".repeat(MAX - 1002)}`;
    assert.equal(text.length, MAX);
    assert.deepEqual(trimToLimit(text), { text, trimmed: false });
    assert.deepEqual(trimToLimit("short"), { text: "short", trimmed: false });
  });

  it("trims one character over the limit, at the last paragraph break", () => {
    const first = paragraph(5000);
    const second = paragraph(5000, "ants");
    const third = paragraph(MAX + 1 - 10_004, "wasps");
    const text = [first, second, third].join("\n\n");
    assert.equal(text.length, MAX + 1);
    const result = trimToLimit(text);
    assert.deepEqual(result, { text: `${first}\n\n${second}`, trimmed: true });
    assertSavable(result.text);
  });

  it("keeps as many whole paragraphs as fit", () => {
    const paras = Array.from({ length: 30 }, (_, i) => paragraph(900, `bee${i}`));
    const result = trimToLimit(paras.join("\n\n"));
    assert.equal(result.trimmed, true);
    // 22 paragraphs of 900 and their 21 breaks are 19,842 characters; a
    // 23rd would pass the limit.
    assert.equal(result.text, paras.slice(0, 22).join("\n\n"));
    assert.ok(paras.slice(0, 23).join("\n\n").length > MAX);
    assertSavable(result.text);
  });

  it("uses a paragraph break that ends exactly at the limit", () => {
    const first = paragraph(MAX);
    const text = `${first}\n\n${paragraph(500, "ants")}`;
    assert.deepEqual(trimToLimit(text), { text: first, trimmed: true });
  });

  it("falls back to the last sentence when the first paragraph alone is over the limit", () => {
    const text = `${paragraph(MAX + 5000)}\n\n${paragraph(300, "ants")}`;
    const result = trimToLimit(text);
    assert.equal(result.trimmed, true);
    assert.match(result.text, /home\.$/);
    assert.ok(text.startsWith(result.text));
    // The last sentence that fits: the next one would go over.
    assert.ok(result.text.length > MAX - 60);
    assertSavable(result.text);
  });

  it("falls back to a sentence when the only paragraph break leaves too little", () => {
    const text = `${"Too short.".padEnd(MIN - 20, " x")}\n\n${paragraph(MAX + 100)}`;
    const result = trimToLimit(text);
    assert.equal(result.trimmed, true);
    assert.match(result.text, /home\.$/);
    assert.ok(result.text.length > MIN);
    assertSavable(result.text);
  });

  it("ends after closing quotes and brackets", () => {
    const sentence = 'She said "the bees came home." ';
    const text = sentence.repeat(Math.ceil((MAX + 100) / sentence.length));
    const result = trimToLimit(text);
    assert.match(result.text, /home\."$/);
    assertSavable(result.text);
  });

  it("falls back to a word break when one sentence is over the limit", () => {
    const text = "bees and ants ".repeat(Math.ceil((MAX + 100) / 14));
    const result = trimToLimit(text);
    assert.equal(result.trimmed, true);
    assert.match(result.text, /^bees and ants [a-z ]*\b(bees|and|ants)$/);
    assert.ok(result.text.length > MAX - 10);
    assertSavable(result.text);
  });

  it("never splits a surrogate pair", () => {
    // An emoji is two UTF-16 units: one unbroken run with the limit falling
    // between the two halves of a pair.
    const text = `a${"🐝".repeat(MAX)}`;
    const result = trimToLimit(text);
    assert.equal(result.trimmed, true);
    assert.equal(result.text.length, MAX - 1);
    assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/);
    assert.equal(Array.from(result.text).at(-1), "🐝");
    // And when the limit falls after a whole pair, the cut is at the limit.
    const even = trimToLimit("🐝".repeat(MAX));
    assert.equal(even.text.length, MAX);
    assert.equal(Array.from(even.text).length, MAX / 2);
  });

  it("never splits a surrogate pair at a word break either", () => {
    const text = "🐝🐝 ".repeat(Math.ceil((MAX + 100) / 5));
    const result = trimToLimit(text);
    assert.match(result.text, /🐝🐝$/u);
    assertSavable(result.text);
  });

  it("is never over the limit or under the minimum, whatever the shape", () => {
    const shapes = [
      paragraph(MAX * 3),
      `${paragraph(150)}\n\n${paragraph(MAX)}`,
      Array.from({ length: 400 }, (_, i) => paragraph(40 + ((i * 37) % 300))).join("\n\n"),
      Array.from({ length: 100 }, () => `- ${paragraph(250)}`).join("\n"),
      "word ".repeat(MAX),
      "x".repeat(MAX * 2),
    ];
    for (const shape of shapes) {
      const result = trimToLimit(normalizeBodyText(shape));
      assert.equal(result.trimmed, true);
      assertSavable(result.text);
    }
  });
});
