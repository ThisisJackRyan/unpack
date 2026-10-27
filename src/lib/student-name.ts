// Characters that look like an apostrophe: right and left single quotes
// (’ ‘, what phones and smart punctuation type), the modifier letter
// apostrophe and turned comma (ʼ ʻ), prime, fullwidth apostrophe, grave,
// and acute accent. The join form only admits some of them, but folding
// all is harmless.
const APOSTROPHES_RE = /[\u2019\u2018\u02BC\u02BB\u2032\uFF07\u0060\u00B4]/g;

// Normalizes one part of a student name for uniqueness checks: Unicode NFC,
// trimmed, lowercased, internal whitespace collapsed to a single space, and
// every apostrophe variant made a straight ', so "D’Andre" and "D'Andre"
// are the same student. Internal spaces are kept (not stripped) so
// "Mary Ann" and "Maryann" stay distinct students. Only for name_key: the
// display values keep what the student typed.
export function normalizeNamePart(s: string): string {
  return s
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(APOSTROPHES_RE, "'")
    .toLocaleLowerCase("en-US");
}

// Builds students.name_key, which is unique per class. The normalized parts
// are joined with a single space, so "Maya", "Ro" and " MAYA", "ro " both
// map to "maya ro", and "D’Andre", "Sm" and "D'Andre", "Sm" both map to
// "d'andre sm". first_name and last_initials keep the display values.
export function studentNameKey(firstName: string, lastInitials: string): string {
  return `${normalizeNamePart(firstName)} ${normalizeNamePart(lastInitials)}`;
}

// Limits for the join form, here (no imports) so the client form can use
// them too. 30 fits real first names, including double ones. The spec
// asks for the first 1 or 2 letters of the last name.
export const FIRST_NAME_MAX_LENGTH = 30;
export const LAST_INITIALS_MAX_LENGTH = 2;
