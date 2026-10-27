// Why fetching or reading an article failed. Kept in its own module (no
// Node imports) so the action can map kinds to messages.
export type FetchArticleErrorKind =
  | "invalid_url"
  | "blocked"
  | "timeout"
  | "too_large"
  | "not_html"
  | "http_error"
  | "extract_failed"
  | "too_long";

export class FetchArticleError extends Error {
  readonly kind: FetchArticleErrorKind;
  // Host name only, for logs. Never shown to the teacher.
  readonly host: string | undefined;

  constructor(kind: FetchArticleErrorKind, host?: string, options?: ErrorOptions) {
    super(`fetch article failed: ${kind}`, options);
    this.name = "FetchArticleError";
    this.kind = kind;
    this.host = host;
  }
}
