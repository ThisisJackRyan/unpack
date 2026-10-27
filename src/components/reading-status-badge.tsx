import type { Reading } from "@/db/schema";
import { pill } from "./ui";

// Draft is a neutral zinc pill; Published uses the indigo accent.
export function ReadingStatusBadge({ status }: { status: Reading["status"] }) {
  return status === "published" ? (
    <span className={`${pill} bg-indigo-50 text-indigo-700`}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-indigo-600" />
      Published
    </span>
  ) : (
    <span className={`${pill} bg-zinc-100 text-zinc-700`}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-zinc-400" />
      Draft
    </span>
  );
}
