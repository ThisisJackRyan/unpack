import "server-only";
import { headers } from "next/headers";
import { resolveTimeZone, type RetryClock } from "./local-time";

// The reader's time zone for dates and times we format on the server (so
// the HTML never disagrees with hydration): Vercel's x-vercel-ip-timezone
// header when it names a zone Intl knows, else UTC (labeled as such).
export async function requestTimeZone(): Promise<{ timeZone: string; fallback: boolean }> {
  return resolveTimeZone((await headers()).get("x-vercel-ip-timezone"));
}

// Now, in the reader's zone, for a limiter's "You can try again at ..."
// (see retryAtSentence).
export async function requestRetryClock(): Promise<RetryClock> {
  const { timeZone, fallback } = await requestTimeZone();
  return { now: new Date(), timeZone, utcLabel: fallback };
}
