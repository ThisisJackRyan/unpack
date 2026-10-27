import { randomInt } from "node:crypto";

// Server-only: join codes are short, uppercase, and avoid look-alike
// characters (0/O, 1/I/L) so students can read them off a projector.

export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;

const JOIN_CODE_CONSTRAINT = "classes_join_code_unique";
const MAX_ATTEMPTS = 5;

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

// Normalizes a code typed by a student: uppercase, spaces and dashes removed.
export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}

export class JoinCodeExhaustedError extends Error {
  constructor() {
    super(`Could not generate a unique join code in ${MAX_ATTEMPTS} attempts`);
    this.name = "JoinCodeExhaustedError";
  }
}

// Postgres unique violation (23505) on classes.join_code. Drizzle wraps the
// driver error, so walk the cause chain.
function isJoinCodeConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (code === "23505" && constraint === JOIN_CODE_CONSTRAINT) return true;
    current = cause;
  }
  return false;
}

// Runs `insert` with a fresh code, retrying on a join code collision.
export async function withUniqueJoinCode<T>(
  insert: (joinCode: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await insert(generateJoinCode());
    } catch (error) {
      if (!isJoinCodeConflict(error)) throw error;
    }
  }
  throw new JoinCodeExhaustedError();
}
