import { BODY_TEXT_MAX_LENGTH, BODY_TEXT_MIN_LENGTH, normalizeBodyText } from "./validate-reading";

// Keeps the first part of an article that is over the reading length
// limit, for links only (pasted text over the limit is refused, see
// validate-reading.ts). Pure, so it is tested on its own
// (trim-article.test.ts).
//
// Cuts at the last paragraph break ("\n\n") that keeps the text within max.
// If that leaves less than min (the first paragraph alone is over the
// limit, say), it cuts after the last sentence that fits, then at the last
// space, and last of all at the last grapheme boundary within max, so an
// emoji (a ZWJ sequence, a flag), or a letter and its accents, is never
// split. The result is normalized (normalizeBodyText), so it
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

  // One unbroken run of characters: cut at the last grapheme boundary
  // within max (see graphemeBoundaryAtOrBefore).
  return { text: normalizeBodyText(text.slice(0, graphemeBoundaryAtOrBefore(text, max))), trimmed: true };
}

// The last place at or before max where text can be cut without splitting
// a grapheme (a user-perceived character: an emoji ZWJ sequence, a flag's
// two regional indicators, a letter and its combining marks). Whether a
// boundary falls at i depends only on the text up to and including the
// code point at i, so segmenting the first max + 2 UTF-16 units (that
// code point whole, even when it is a surrogate pair) is enough. When one
// grapheme runs past max from the start (pathological stacks of combining
// marks), it cuts at max, still never between the halves of a surrogate
// pair.
export function graphemeBoundaryAtOrBefore(text: string, max: number): number {
  if (text.length <= max) return text.length;
  let end = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { index } of segmenter.segment(text.slice(0, max + 2))) {
    if (index > max) break;
    end = index;
  }
  if (end > 0) return end;
  return /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
}

// Drops paragraphs left at the end of a trimmed text that are headings
// (isHeading: extractArticle matches the article's own headings), so the
// text never ends on a heading with nothing under it. Repeats while the
// last paragraph is a heading, and never drops one if that would leave
// less than min.
export function dropTrailingHeadings(
  text: string,
  isHeading: (paragraph: string) => boolean,
  min: number = BODY_TEXT_MIN_LENGTH,
): string {
  let kept = text;
  for (;;) {
    const at = kept.lastIndexOf("\n\n");
    if (at < 0 || !isHeading(kept.slice(at + 2))) return kept;
    const shorter = normalizeBodyText(kept.slice(0, at));
    if (shorter.length < min) return kept;
    kept = shorter;
  }
}
