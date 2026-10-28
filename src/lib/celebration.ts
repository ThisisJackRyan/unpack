// The small celebration on a passed reading (students and self-learners):
// the encouraging line and where the burst's stars land. Pure, so the copy
// and the layout are tested; the component is components/celebration.tsx.

export const FIRST_TRY_LINE = "First try! You really dug into that one.";
export const KEPT_GOING_LINE = "You kept going and got there. That’s how strong readers grow.";

// The line under the banner: a first-try pass, or one after a "not yet".
export function passLine(tryNumber: number | null | undefined): string {
  return tryNumber === 1 ? FIRST_TRY_LINE : KEPT_GOING_LINE;
}

// The burst's timing, in step with --animate-burst and --animate-pop in
// globals.css (celebration.test.ts checks): each star flies for BURST_MS,
// starting up to 3 * BURST_STAGGER_MS late, so the whole burst runs about
// 1.8s, then everything stays still.
export const BURST_MS = 1400;
export const BURST_STAGGER_MS = 120;
export const POP_MS = 900;

export type BurstStar = { x: number; y: number; size: number; delayMs: number; color: "sunny" | "lagoon" | "primary" };

// Eight stars around the center of a 96px box, where the burst ends (and
// where they sit, still, under reduced motion). x and y in px from center.
export const BURST_STARS: BurstStar[] = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * 2 * Math.PI - Math.PI / 2;
  const radius = i % 2 === 0 ? 38 : 30;
  return {
    x: Math.round(Math.cos(angle) * radius),
    y: Math.round(Math.sin(angle) * radius),
    size: i % 2 === 0 ? 16 : 12,
    delayMs: (i % 4) * BURST_STAGGER_MS,
    color: (["sunny", "lagoon", "sunny", "primary"] as const)[i % 4],
  };
});

// Right after a check, the page swaps the answer form for the result in
// place, so a pass can land above the screen. The answer form marks the
// check (this tab only, ids only), and the celebration that mounts next
// for that reading takes the mark and scrolls itself into view. A mark
// older than JUST_CHECKED_MAX_AGE_MS (a check takes up to a minute) is
// ignored, so a later visit doesn't jump.
export const JUST_CHECKED_KEY = "unpack:just-checked";
export const JUST_CHECKED_MAX_AGE_MS = 3 * 60_000;

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function markJustChecked(store: KeyStore | null, readingId: string, now = Date.now()): void {
  try {
    store?.setItem(JUST_CHECKED_KEY, JSON.stringify({ readingId, at: now }));
  } catch {
    // Storage full or blocked: no scroll, the celebration still shows.
  }
}

export function takeJustChecked(store: KeyStore | null, readingId: string, now = Date.now()): boolean {
  try {
    const raw = store?.getItem(JUST_CHECKED_KEY);
    if (!raw) return false;
    const mark = JSON.parse(raw) as { readingId?: unknown; at?: unknown };
    if (mark.readingId !== readingId) return false;
    store?.removeItem(JUST_CHECKED_KEY);
    const age = now - Number(mark.at);
    return age >= 0 && age <= JUST_CHECKED_MAX_AGE_MS;
  } catch {
    return false;
  }
}

// sessionStorage, or null where it's blocked.
export function browserSessionStore(): KeyStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
