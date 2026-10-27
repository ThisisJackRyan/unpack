// The small celebration on a passed reading (students and self-learners):
// the encouraging line and where the burst's stars land. Pure, so the copy
// and the layout are tested; the component is components/celebration.tsx.

export const FIRST_TRY_LINE = "First try! You really dug into that one.";
export const KEPT_GOING_LINE = "You kept going and got there. That’s how strong readers grow.";

// The line under the banner: a first-try pass, or one after a "not yet".
export function passLine(tryNumber: number | null | undefined): string {
  return tryNumber === 1 ? FIRST_TRY_LINE : KEPT_GOING_LINE;
}

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
    delayMs: (i % 4) * 40,
    color: (["sunny", "lagoon", "sunny", "primary"] as const)[i % 4],
  };
});
