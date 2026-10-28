import { BODY_TEXT_MAX_LENGTH } from "../validate-reading";

// A generated article page over the reading length limit, for the tests of
// trimming long linked articles (no network: the fake fetch extracts this).
export const LONG_ARTICLE_PARAGRAPHS = Array.from(
  { length: Math.ceil(BODY_TEXT_MAX_LENGTH / 900) + 10 },
  (_, i) => `Part ${i + 1}. ${"Rivers carry water, sand, and stones down to the sea. ".repeat(16)}`.trim(),
);

export const LONG_ARTICLE_HTML = `<html><head><title>A very long river story</title></head><body><article>${LONG_ARTICLE_PARAGRAPHS.map(
  (p) => `<p>${p}</p>`,
).join("")}</article></body></html>`;
