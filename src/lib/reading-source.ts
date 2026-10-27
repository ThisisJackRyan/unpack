// Turns a validated add-reading form into the reading's title, text, and
// source link: pasted text as is, or a link fetched (safeFetch, through
// fetchArticle) after the account's link fetch limit allows it. Shared by
// the teacher's add-reading action and the self-learner's new reading
// action, so both read links the same way. Pure flow over injected deps,
// so tests run it with fakes; no Node imports.

import { FetchArticleError, type FetchArticleErrorKind } from "./fetch-errors";
import { LINK_FETCH_LIMITED_MESSAGE } from "./link-rate-limit";
import {
  BODY_TEXT_MAX_LENGTH,
  resolveLinkTitle,
  type ReadingFormData,
  type ReadingFormErrors,
} from "./validate-reading";

export const LINK_ERRORS: Record<FetchArticleErrorKind, string> = {
  invalid_url: "Enter a full web link, like https://example.com/story.",
  blocked: "We can’t open that link.",
  timeout: "That page took too long to load.",
  too_large: "That page is too big for us to read.",
  not_html: "That link isn’t a web page. It may be a PDF or other file.",
  http_error: "We couldn’t open that page.",
  extract_failed: "We couldn’t find the article text on that page.",
  too_long: `That article is over ${BODY_TEXT_MAX_LENGTH.toLocaleString("en-US")} characters.`,
};

export const SAVE_READING_FAILED_MESSAGE = "We couldn’t save the reading. Please try again.";
export const NO_PAGE_TITLE_MESSAGE = "We couldn’t find a title on that page. Please add one.";

export type ReadingSource = { title: string; bodyText: string; sourceUrl: string | null };

export type ReadingSourceResult =
  | { ok: true; source: ReadingSource }
  | {
      ok: false;
      errors: ReadingFormErrors & { form?: string };
      // Shown after a link error as a control that switches to "Paste text".
      suggestText?: string;
    };

export type ReadingSourceDeps = {
  // Records a link fetch against the account's limit; false at the limit.
  // Throws when the limit can't be checked (we then don't fetch).
  recordLinkFetch: () => Promise<boolean>;
  fetchArticle: (url: string) => Promise<{ title: string; text: string; url: string }>;
  // Safe fields only (kind, host, error names), never the URL or text.
  log: (message: string, fields: Record<string, unknown>) => void;
};

export async function resolveReadingSource(
  data: ReadingFormData,
  deps: ReadingSourceDeps,
): Promise<ReadingSourceResult> {
  if (data.source === "text") {
    return { ok: true, source: { title: data.title, bodyText: data.bodyText, sourceUrl: null } };
  }

  // Counts this attempt, before fetching, whatever the fetch's outcome.
  // Fails closed: if we can't check the limit, we don't fetch.
  let allowed: boolean;
  try {
    allowed = await deps.recordLinkFetch();
  } catch (error) {
    // Name, code, and message only: a Postgres error's detail can echo a row.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    deps.log("recordLinkFetch failed", { name, code, message });
    return { ok: false, errors: { form: SAVE_READING_FAILED_MESSAGE } };
  }
  if (!allowed) {
    // Pasted text isn't limited.
    return { ok: false, errors: { url: LINK_FETCH_LIMITED_MESSAGE }, suggestText: "Paste the text instead." };
  }

  let article: { title: string; text: string; url: string };
  try {
    article = await deps.fetchArticle(data.url);
  } catch (error) {
    const kind = error instanceof FetchArticleError ? error.kind : "http_error";
    // Kind and host only: no full URL (query strings), IPs, or stacks.
    deps.log("fetchArticle failed", {
      kind,
      host: error instanceof FetchArticleError ? error.host : undefined,
      name: error instanceof Error ? error.name : typeof error,
    });
    return {
      ok: false,
      errors: { url: LINK_ERRORS[kind] },
      suggestText:
        kind === "invalid_url"
          ? undefined
          : kind === "too_long"
            ? "Paste a shorter section instead."
            : "Paste the text instead.",
    };
  }
  const title = resolveLinkTitle(data.title, article.title);
  if (!title) return { ok: false, errors: { title: NO_PAGE_TITLE_MESSAGE } };
  // Where the text really came from, after any redirects.
  return { ok: true, source: { title, bodyText: article.text, sourceUrl: article.url } };
}
