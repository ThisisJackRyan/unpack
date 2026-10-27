// Characters that look like an apostrophe or an ʻokina: straight ('),
// right and left single quotes (’ ‘, what phones and smart punctuation
// type), the modifier letter apostrophe (ʼ), the ʻokina (ʻ, U+02BB), prime,
// fullwidth apostrophe, grave (`), and the spacing acute accent (´). The
// join form only admits some of them, but dropping all is harmless.
const APOSTROPHES_RE = /['\u2019\u2018\u02BC\u02BB\u2032\uFF07\u0060\u00B4]/g;

// Hyphens and dashes, folded to a space: "Jean-Luc" and "Jean Luc" look
// alike on the teacher's list, so they are the same name.
const HYPHENS_RE = /[-\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D]/g;

// Combining diacritical marks (U+0300 to U+036F): the accents NFKD splits
// off Latin, Greek, and Cyrillic letters. Only this block, so the vowel
// signs of scripts like Devanagari, which change the letter, are kept.
const DIACRITICS_RE = /[\u0300-\u036F]/g;

// Folds one part of a student name for uniqueness checks, so names that
// look alike to a teacher collide:
// 1. Apostrophes and ʻokina dropped: "Keʻala" = "Keala", "D’Andre" =
//    "DAndre" = "D'Andre".
// 2. NFKD, then the accents stripped: "Zoë" = "Zoe", "José" = "Jose".
//    (NFKD also folds compatibility forms, like fullwidth letters.)
// 3. Hyphens made spaces: "Jean-Luc" = "Jean Luc".
// 4. Case folded (upper, then lower, so "ß" matches "ss" and a final
//    sigma matches σ), whitespace trimmed and collapsed to one space,
//    and NFC again (so Hangul is whole syllables again).
// Internal spaces are kept, not stripped, so "Mary Ann" and "Maryann"
// stay distinct students. Only for name_key: the display values keep what
// the student typed.
//
// Changing this changes every student's name_key. Existing rows keep
// their old keys until recomputed: run scripts/recompute-name-keys.ts
// (dry run by default) after deploying a change, or two look-alike names
// could both join.
export function normalizeNamePart(s: string): string {
  return s
    .replace(APOSTROPHES_RE, "")
    .normalize("NFKD")
    .replace(DIACRITICS_RE, "")
    .replace(APOSTROPHES_RE, "")
    .replace(HYPHENS_RE, " ")
    .toUpperCase()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

// Builds students.name_key, which is unique per class. The folded parts
// are joined with a single space, so "Maya", "Ro" and " MAYA", "ro " both
// map to "maya ro", and "D’Andre", "Sm" and "DAndre", "Sm" both map to
// "dandre sm".
export function studentNameKey(firstName: string, lastInitials: string): string {
  return `${normalizeNamePart(firstName)} ${normalizeNamePart(lastInitials)}`;
}

// Limits for the join form, here (no imports) so the client form can use
// them too. 30 fits real first names, including double ones. The spec
// asks for the first 1 or 2 letters of the last name.
export const FIRST_NAME_MAX_LENGTH = 30;
export const LAST_INITIALS_MAX_LENGTH = 2;
