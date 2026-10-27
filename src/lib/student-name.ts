// Normalizes one part of a student name for uniqueness checks: Unicode NFC,
// trimmed, lowercased, and internal whitespace collapsed to a single space.
// Internal spaces are kept (not stripped) so "Mary Ann" and "Maryann" stay
// distinct students.
export function normalizeNamePart(s: string): string {
  return s
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

// Builds students.name_key, which is unique per class. The normalized parts
// are joined with a single space, so "Maya", "Ro" and " MAYA", "ro " both
// map to "maya ro". first_name and last_initials keep the display values.
export function studentNameKey(firstName: string, lastInitials: string): string {
  return `${normalizeNamePart(firstName)} ${normalizeNamePart(lastInitials)}`;
}

// Limits for the join form, here (no imports) so the client form can use
// them too. 30 fits real first names, including double ones. The spec
// asks for the first 1 or 2 letters of the last name.
export const FIRST_NAME_MAX_LENGTH = 30;
export const LAST_INITIALS_MAX_LENGTH = 2;
