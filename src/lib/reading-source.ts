// Turns a validated add-reading form into the reading's title, text, and
// source link: pasted text as is, or a link fetched (safeFetch, through
// fetchArticle) after the account's link fetch limit allows it. Shared by
// the teacher's add-reading action and the self-learner's new reading
// action, so both read links the same way. Pure flow over injected deps,
// so tests run it with fakes; no Node imports.

import type { StripFallbackReason } from "./fetch-article";
import { FetchArticleError, type FetchArticleErrorKind } from "./fetch-errors";
import { LINK_FETCH_LIMITED_MESSAGE } from "./link-rate-limit";
import { withRetryAt } from "./local-time";
import {
  resolveLinkTitle,
  type ReadingFormData,
  type ReadingFormErrors,
} from "./validate-reading";
import { safeErrorFields, type SafeErrorFields } from "./safe-error-fields";

export const LINK_ERRORS: Record<FetchArticleErrorKind, string> = {
  invalid_url: "Enter a full web link, like https://example.com/story.",
  blocked: "We can’t open that link.",
  timeout: "That page took too long to load.",
  too_large: "That page is too big for us to read.",
  not_html: "That link isn’t a web page. It may be a PDF or other file.",
  http_error: "We couldn’t open that page.",
  extract_failed: "We couldn’t find the article text on that page.",
};

export const SAVE_READING_FAILED_MESSAGE = "We couldn’t save the reading. Please try again.";
export const NO_PAGE_TITLE_MESSAGE = "We couldn’t find a title on that page. Please add one.";

// bodyTrimmed: a linked article over the length limit, of which bodyText
// is the first part (see trim-article.ts). Never true for pasted text.
export type ReadingSource = { title: string; bodyText: string; sourceUrl: string | null; bodyTrimmed: boolean };

// stripFallback: the text is the unstripped page, and why (see
// fetch-article.ts); the create flows log it once the reading exists.
export type FetchedArticle = {
  title: string;
  text: string;
  url: string;
  trimmed: boolean;
  stripFallback?: StripFallbackReason;
};

export type ReadingSourceResult =
  | { ok: true; source: ReadingSource; stripFallback?: StripFallbackReason }
  | {
      ok: false;
      errors: ReadingFormErrors & { form?: string };
      // Shown after a link error as a control that switches to "Paste text".
      suggestText?: string;
      // The link limit (an amber note, not an error), with its retry time.
      limit?: string;
    };

export type ReadingSourceDeps = {
  // Records a link fetch against the account's limit; false at the limit.
  // Throws when the limit can't be checked (we then don't fetch).
  recordLinkFetch: () => Promise<boolean>;
  // The note at the limit, with when the next link frees up (the action
  // reads the time and the reader's zone). Without it, a relative time.
  limitedMessage?: () => Promise<string>;
  fetchArticle: (url: string) => Promise<FetchedArticle>;
  // Safe fields only (kind, status, error names), never any part of the
  // link (host, path, query) or the text.
  log: (message: string, fields: ReadingSourceLogFields) => void;
};

// What the create helpers log: safeErrorFields' output, plus a link
// fetch's kind and HTTP status. Typed, so a raw error here fails tsc.
export type ReadingSourceLogFields = SafeErrorFields & {
  kind?: FetchArticleErrorKind | "http_error";
  status?: number;
};

export async function resolveReadingSource(
  data: ReadingFormData,
  deps: ReadingSourceDeps,
): Promise<ReadingSourceResult> {
  if (data.source === "text") {
    return { ok: true, source: { title: data.title, bodyText: data.bodyText, sourceUrl: null, bodyTrimmed: false } };
  }

  // Counts this attempt, before fetching, whatever the fetch's outcome.
  // Fails closed: if we can't check the limit, we don't fetch.
  let allowed: boolean;
  try {
    allowed = await deps.recordLinkFetch();
  } catch (error) {
    // Safe fields only (safe-error-fields.ts): a query error's message can
    // echo a row.
    deps.log("recordLinkFetch failed", safeErrorFields(error));
    return { ok: false, errors: { form: SAVE_READING_FAILED_MESSAGE } };
  }
  if (!allowed) {
    // Pasted text isn't limited. The time is a nicety: if it can't be
    // read, say a relative time.
    let limit: string;
    try {
      limit = deps.limitedMessage ? await deps.limitedMessage() : withRetryAt(LINK_FETCH_LIMITED_MESSAGE, null, null);
    } catch {
      limit = withRetryAt(LINK_FETCH_LIMITED_MESSAGE, null, null);
    }
    return { ok: false, errors: {}, limit, suggestText: "Paste the text instead." };
  }

  let article: FetchedArticle;
  try {
    article = await deps.fetchArticle(data.url);
  } catch (error) {
    const kind = error instanceof FetchArticleError ? error.kind : "http_error";
    // The kind, the HTTP status of a non-2xx reply, and the safe fields
    // only: no part of the link (host, path, query) and no IPs or stacks.
    const status = error instanceof FetchArticleError ? error.status : undefined;
    deps.log("fetchArticle failed", { kind, ...(status === undefined ? {} : { status }), ...safeErrorFields(error) });
    return {
      ok: false,
      errors: { url: LINK_ERRORS[kind] },
      suggestText: kind === "invalid_url" ? undefined : "Paste the text instead.",
    };
  }
  const title = resolveLinkTitle(data.title, article.title);
  if (!title) return { ok: false, errors: { title: NO_PAGE_TITLE_MESSAGE } };
  // Where the text really came from, after any redirects.
  return {
    ok: true,
    source: { title, bodyText: article.text, sourceUrl: article.url, bodyTrimmed: article.trimmed },
    ...(article.stripFallback ? { stripFallback: article.stripFallback } : {}),
  };
}
