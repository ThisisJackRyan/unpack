import { normalizeJoinCode } from "./join-code";
import { FIRST_NAME_MAX_LENGTH, LAST_INITIALS_MAX_LENGTH } from "./student-name";

// Pure validation for the student join form, shared by the server action
// and tests. Only the class code, a first name, and the first 1 or 2
// letters of the last name are collected: nothing else about a student.

export { FIRST_NAME_MAX_LENGTH, LAST_INITIALS_MAX_LENGTH };

// Longer than any real code (6 characters), so a typo with an extra
// character still gets "couldn't find", while pasted junk is refused
// without a database lookup.
const JOIN_CODE_MAX_LENGTH = 12;

export const CLASS_NOT_FOUND_MESSAGE =
  "We couldn’t find that class code. Check it with your teacher.";

// Letters (any alphabet, with accents) plus spaces, hyphens, and
// apostrophes, e.g. "Mary Ann", "Jean-Luc", "D’Andre". Apostrophes may be
// straight ('), curly (’ or ‘, which phones type), or the modifier letter
// (ʼ); studentNameKey treats them all alike. The name must start and end
// with a letter (accents may follow it), so a lone accent, "Mia-", or
// "Mia'" is refused.
const FIRST_NAME_RE = /^\p{L}\p{M}*(?:[\p{L}\p{M} '’‘ʼ-]*\p{L}\p{M}*)?$/u;
const INITIALS_RE = /^[\p{L}\p{M}]+$/u;

export type JoinErrors = {
  code?: string;
  firstName?: string;
  lastInitials?: string;
};

export type JoinValues = { code: string; firstName: string; lastInitials: string };

export type JoinValidation =
  | { ok: true; data: JoinValues; values: JoinValues }
  | { ok: false; errors: JoinErrors; values: JoinValues };

function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFC") : "";
}

// Counts characters as people see them, so "Zoë" is 3 even if typed with
// a combining accent.
function length(s: string): number {
  return [...s].length;
}

// "ro" and "RO" are shown as "Ro", so the teacher's list reads cleanly.
// Matching ignores case anyway (see studentNameKey).
export function formatInitials(initials: string): string {
  const [first = "", ...rest] = [...initials];
  return first.toLocaleUpperCase("en-US") + rest.join("").toLocaleLowerCase("en-US");
}

// Takes raw FormData values. The code is normalized (uppercase, spaces and
// dashes removed); the first name is trimmed with inner spaces collapsed;
// the initials are trimmed and formatted. `values` echoes what the form
// should show again after an error.
export function validateJoin(input: {
  code: unknown;
  firstName: unknown;
  lastInitials: unknown;
}): JoinValidation {
  const code = normalizeJoinCode(text(input.code));
  const firstName = text(input.firstName).trim().replace(/\s+/g, " ");
  const lastInitials = text(input.lastInitials).replace(/\s+/g, "");
  const values = { code, firstName, lastInitials };

  const errors: JoinErrors = {};
  if (!code) {
    errors.code = "Enter your class code.";
  } else if (code.length > JOIN_CODE_MAX_LENGTH || !/^[A-Z0-9]+$/.test(code)) {
    errors.code = CLASS_NOT_FOUND_MESSAGE;
  }

  if (!firstName) {
    errors.firstName = "Enter your first name.";
  } else if (length(firstName) > FIRST_NAME_MAX_LENGTH) {
    errors.firstName = `Keep your first name to ${FIRST_NAME_MAX_LENGTH} letters or less.`;
  } else if (!FIRST_NAME_RE.test(firstName)) {
    errors.firstName = "Use letters only. Spaces, hyphens, and apostrophes are OK.";
  }

  if (!lastInitials) {
    errors.lastInitials = "Enter the first 1 or 2 letters of your last name.";
  } else if (length(lastInitials) > LAST_INITIALS_MAX_LENGTH || !INITIALS_RE.test(lastInitials)) {
    errors.lastInitials = "Use just 1 or 2 letters of your last name.";
  }

  if (errors.code || errors.firstName || errors.lastInitials) {
    return { ok: false, errors, values };
  }
  const data = { code, firstName, lastInitials: formatInitials(lastInitials) };
  return { ok: true, data, values: data };
}
