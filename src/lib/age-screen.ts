// The neutral age screen (COPPA): birth month and year, asked before an
// account first reads for itself. Pure logic, so tests cover every edge;
// the actions read the form and the cookie (src/app/welcome/actions.ts,
// src/app/settings/actions.ts).
//
// Rules:
// - The form asks for a birth month and a birth year with two selects, no
//   default, and a year range (this year back YEAR_SPAN years) that gives
//   nothing away. No words on the page say what the answer is for.
// - The answer is checked here, on the server, and then dropped: only "13+
//   confirmed" and when (teachers.age_confirmed_at) are stored. The month
//   and year are never stored, logged, sent back, or put in a cookie, a
//   URL or an error.
// - Conservative: someone born in month M of year Y counts as 13 or older
//   only from the month after M of year Y + 13, so they are 13 for every
//   day of that month whatever their birth day. In the birthday month
//   itself the answer counts as under 13.
// - "Now" is the server's UTC month. That is safe in every time zone: when
//   UTC is already in the month after the birthday month, local time is
//   at worst 12 hours behind, still the last day of the birthday month,
//   when everyone born in it has turned 13.
// - Under 13: the action sets AGE_GATE_COOKIE (value "under", no date or
//   age in it) for AGE_GATE_MAX_AGE_SECONDS, and while it is there the
//   screen isn't asked again on this device (/welcome and /settings
//   alike): the actions refuse self-learner before reading any answer,
//   and an account with no role can't choose teacher either. On /welcome
//   the answer also deletes the account (under-13-account.ts).

export const MIN_AGE = 13;

// The year select: this year back this many years.
export const YEAR_SPAN = 100;

export const AGE_GATE_COOKIE = "unpack_age_gate";
export const AGE_GATE_VALUE = "under";
export const AGE_GATE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function ageGateCookieOptions(production: boolean) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    path: "/",
    maxAge: AGE_GATE_MAX_AGE_SECONDS,
  };
}

export function isAgeGated(cookieValue: string | undefined): boolean {
  return cookieValue === AGE_GATE_VALUE;
}

// The one error for a missing, out-of-range, or future answer. It says
// nothing about the cutoff or the answer.
export const AGE_SCREEN_ERROR = "Choose a month and a year.";

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// The select options, newest first: this year (UTC) back YEAR_SPAN years.
export function birthYearOptions(now: Date): number[] {
  const thisYear = now.getUTCFullYear();
  return Array.from({ length: YEAR_SPAN + 1 }, (_, i) => thisYear - i);
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

// Months counted from year 0, so two (year, month) pairs compare as numbers.
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

export type AgeScreenResult = "old_enough" | "under" | "invalid";

// The raw FormData values (month 1-12, a year from birthYearOptions). A
// month after the current one counts as invalid, like a blank.
export function checkAgeScreen(input: { month: unknown; year: unknown }, now: Date): AgeScreenResult {
  const thisYear = now.getUTCFullYear();
  const month = wholeNumber(input.month, 1, 12);
  const year = wholeNumber(input.year, thisYear - YEAR_SPAN, thisYear);
  if (month === null || year === null) return "invalid";
  const current = monthIndex(thisYear, now.getUTCMonth() + 1);
  const born = monthIndex(year, month);
  if (born > current) return "invalid";
  return current > monthIndex(year + MIN_AGE, month) ? "old_enough" : "under";
}
