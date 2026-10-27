import { capBadgeDetail, capBadgeLabel, type CapBadge } from "@/lib/reading-cap";
import { pill } from "./ui";

// A per-student reading near or at its student set limit, on the class
// page's reading list. Almost full is amber (worth a look); full is
// neutral (nothing is lost, the reading page says what to do). Never red.
// The words carry the meaning; the counts follow for screen readers.
export function CapBadge({ badge }: { badge: CapBadge }) {
  const full = badge.level === "full";
  return (
    <span
      title={capBadgeDetail(badge)}
      className={`${pill} ${full ? "bg-zinc-100 text-zinc-700" : "bg-amber-50 text-amber-800"}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${full ? "bg-zinc-500" : "bg-amber-500"}`} />
      {capBadgeLabel(badge.level)}
      <span className="sr-only">: {capBadgeDetail(badge)}</span>
    </span>
  );
}
