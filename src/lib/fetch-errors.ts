// Why fetching or reading an article failed. Kept in its own module (no
// Node imports) so the action can map kinds to messages.
export type FetchArticleErrorKind =
  | "invalid_url"
  | "blocked"
  | "timeout"
  | "too_large"
  | "not_html"
  | "http_error"
  | "extract_failed";

// Carries no part of the link (no host, path, or URL): the failure is
// logged by kind, and by HTTP status for a non-2xx reply.
export class FetchArticleError extends Error {
  readonly kind: FetchArticleErrorKind;
  readonly status: number | undefined;

  constructor(kind: FetchArticleErrorKind, options?: ErrorOptions & { status?: number }) {
    super(`fetch article failed: ${kind}`, options);
    this.name = "FetchArticleError";
    this.kind = kind;
    this.status = options?.status;
  }
}
