// Whether this is a production deploy, the one test every production gate
// uses (the join IP hash secret, the join bot check's strictness and
// hostnames, the student session cookie's Secure flag). Production is
// NODE_ENV=production or, on Vercel, VERCEL_ENV=production, so a
// production deployment is held to the rules even if NODE_ENV were ever
// set otherwise. Vercel builds previews with NODE_ENV=production too, so
// Preview counts as production here. Pure (the env is passed in), so tests
// cover every case; env.test.ts checks no other file reads these two
// variables for gating.

export type Env = Partial<Record<string, string | undefined>>;

export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}
