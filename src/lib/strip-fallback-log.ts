// reading.strip_fallback: one line per link reading whose text is the
// unstripped page (extractArticle fell back, see STRIP_FALLBACK_MIN_SHARE
// in fetch-article.ts), so we can see how often stripNonProse misreads a
// layout. An info line through logEvent (timing-log.ts), not an error:
// the reading was made from the page as before. Fixed fields only, picked
// by name: the reason (an enum), the path ("class" or "self"), and the new
// reading's id (an app uuid; absent when no reading was saved). Never the
// link or any part of it, the title, the text, or their lengths. Tests
// drive it with a fake writer.

import type { StripFallbackReason } from "./fetch-article";
import { logEvent, type LineWriter } from "./timing-log";

export type StripFallbackLog = {
  reason: StripFallbackReason;
  path: "class" | "self";
  readingId?: string;
};

export function logStripFallback(fields: StripFallbackLog, write?: LineWriter): void {
  logEvent("reading.strip_fallback", { reason: fields.reason, path: fields.path, readingId: fields.readingId }, write);
}
