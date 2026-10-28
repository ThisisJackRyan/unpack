// Test-only routes under /qa, for scripts/browser-check-answer-timeout.ts.
// They exist in every build but answer 404 (pages and actions alike)
// unless the server runs with UNPACK_QA_ROUTES=1, which only that script
// sets. Never set it on a deploy. Each QA page and action starts with
// `if (!qaRoutesEnabled()) notFound();` (qa-routes.test.ts checks).

export const QA_ROUTES_ENV = "UNPACK_QA_ROUTES";

export function qaRoutesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[QA_ROUTES_ENV] === "1";
}

// /qa and below.
export function isQaPath(pathname: string): boolean {
  return pathname === "/qa" || pathname.startsWith("/qa/");
}
