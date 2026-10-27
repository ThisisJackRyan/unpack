import type { Reading } from "@/db/schema";
import { pill } from "./ui";

// Draft is a neutral zinc pill; Published uses the indigo accent.
export function ReadingStatusBadge({ status }: { status: Reading["status"] }) {
  return status === "published" ? (
    <span className={`${pill} bg-primary-50 text-primary-700 text-sm`}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-primary-600" />
      Published
    </span>
  ) : (
    <span className={`${pill} bg-ink-100 text-ink-700 text-sm`}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ink-400" />
      Draft
    </span>
  );
}
