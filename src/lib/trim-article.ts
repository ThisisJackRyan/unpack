import { BODY_TEXT_MAX_LENGTH, BODY_TEXT_MIN_LENGTH, normalizeBodyText } from "./validate-reading";

// Keeps the first part of an article that is over the reading length
// limit, for links only (pasted text over the limit is refused, see
// validate-reading.ts). Pure, so it is tested on its own
// (trim-article.test.ts).
//
// Cuts at the last paragraph break ("\n\n") that keeps the text within max.
// If that leaves less than min (the first paragraph alone is over the
// limit, say), it cuts after the last sentence that fits, then at the last
// space, and last of all at max itself, never between the two halves of a
// surrogate pair. The result is normalized (normalizeBodyText), so it
// passes the same checks as a saved body. It is under min only when the
// first max characters hold less than min of text (nearly all spaces), so
// callers still check min after trimming.

export type TrimResult = { text: string; trimmed: boolean };

// A sentence's end: ".", "!", "?" or "…", any closing quotes or brackets,
// then a space or line break.
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s)/g;

export function trimToLimit(
  text: string,
  max: number = BODY_TEXT_MAX_LENGTH,
  min: number = BODY_TEXT_MIN_LENGTH,
): TrimResult {
  if (text.length <= max) return { text, trimmed: false };
  const usable = (end: number) => {
    const cut = normalizeBodyText(text.slice(0, end));
    return cut.length >= min && cut.length <= max ? cut : undefined;
  };

  const paragraph = text.lastIndexOf("\n\n", max);
  const byParagraph = paragraph > 0 ? usable(paragraph) : undefined;
  if (byParagraph) return { text: byParagraph, trimmed: true };

  // The whitespace after a sentence may be the character just past max.
  const head = text.slice(0, max + 1);
  let sentence = -1;
  for (const match of head.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end <= max) sentence = end;
  }
  const bySentence = sentence > 0 ? usable(sentence) : undefined;
  if (bySentence) return { text: bySentence, trimmed: true };

  const space = head.search(/\s\S*$/);
  const byWord = space > 0 ? usable(space) : undefined;
  if (byWord) return { text: byWord, trimmed: true };

  // One unbroken run of characters: cut at max, keeping surrogate pairs whole.
  let end = max;
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { text: normalizeBodyText(text.slice(0, end)), trimmed: true };
}
