// Dates and times in the reader's time zone, for the weekly allowance and
// every limiter's "You can try again at ..." line. Pure (the zone and now
// are passed in), so tests cover the edges; the server-only side that
// reads the zone from the request is request-time-zone.ts. Formatted on
// the server only (pages and actions pass a string), so hydration has
// nothing to disagree with.

const DAY_MS = 24 * 60 * 60 * 1000;

// A time zone name from the request (Vercel's x-vercel-ip-timezone), if
// Intl knows it; else UTC.
export function resolveTimeZone(candidate: string | null | undefined): { timeZone: string; fallback: boolean } {
  if (candidate) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate });
      return { timeZone: candidate, fallback: false };
    } catch {
      // Not a zone Intl knows.
    }
  }
  return { timeZone: "UTC", fallback: true };
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function clockTime(at: Date, timeZone: string, utcLabel: boolean): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  return utcLabel ? `${time} UTC` : time;
}

// "today at 3:15 PM", "tomorrow at 9:00 AM", or "on Friday at 9:00 AM",
// in `timeZone`. `utcLabel` adds " UTC" when we couldn't tell the
// reader's zone.
export function formatNextFree(at: Date, now: Date, timeZone: string, utcLabel = false): string {
  const time = clockTime(at, timeZone, utcLabel);
  const day = dayKey(at, timeZone);
  if (day === dayKey(now, timeZone)) return `today at ${time}`;
  if (day === dayKey(new Date(now.getTime() + DAY_MS), timeZone)) return `tomorrow at ${time}`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at);
  return `on ${weekday} at ${time}`;
}

// What a retry time is told against: now, and the reader's zone (UTC,
// labeled, when we couldn't tell).
export type RetryClock = { now: Date; timeZone: string; utcLabel: boolean };

// The sentence after a limiter's message, from when its window frees the
// next try (the oldest counted attempt plus the window):
// - "You can try again at 2:40 PM." (today; "2:40 PM UTC" when the zone
//   is a guess), "You can try again tomorrow at 9:00 AM.", or "... on
//   Friday at 9:00 AM."
// - "You can try again in a minute." when that is under a minute away
//   (a clock time would read as now), and "You can try again now." once
//   it has passed.
// - "Try again in a few minutes." when the time isn't known (no time, or
//   no clock).
export function retryAtSentence(at: Date | null, clock: RetryClock | null): string {
  if (!at || !clock || Number.isNaN(at.getTime())) return "Try again in a few minutes.";
  const ms = at.getTime() - clock.now.getTime();
  if (ms <= 0) return "You can try again now.";
  if (ms < 60_000) return "You can try again in a minute.";
  const when = formatNextFree(at, clock.now, clock.timeZone, clock.utcLabel);
  return `You can try again ${when.startsWith("today ") ? when.slice("today ".length) : when}.`;
}

// A limiter's message with its retry sentence.
export function withRetryAt(message: string, at: Date | null, clock: RetryClock | null): string {
  return `${message} ${retryAtSentence(at, clock)}`;
}

// A timestamp from a database row (a Date, or a string from the driver).
export function dateFromRow(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
