// Postgres error checks. Drizzle and the Neon driver can wrap the error,
// so these walk the cause chain (as isNameTakenConflict does).

// A unique violation (23505), on `constraint` when one is given. A 23505
// on any other constraint must not be mistaken for the one asked about.
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const { code, constraint: name, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (code === "23505" && (constraint === undefined || name === constraint)) return true;
    current = cause;
  }
  return false;
}

// Any error with this SQLSTATE code in its cause chain.
export function hasPgCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const { code: found, cause } = current as { code?: unknown; cause?: unknown };
    if (found === code) return true;
    current = cause;
  }
  return false;
}
