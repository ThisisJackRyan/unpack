import Link from "next/link";
import { Magnifier } from "@/components/illustrations";
import { card, primaryButtonLarge } from "@/components/ui";

// One view for every reading a student can't open: a bad id, a draft, a
// reading in another class, or a set they aren't allowed. They all look
// the same, so nothing is revealed about which.
export default function StudentNotFound() {
  return (
    <div className={`${card} flex flex-col items-center gap-4 px-6 py-14 text-center`}>
      <Magnifier className="h-24 w-24" />
      <h1 className="text-2xl font-bold text-ink-950">We couldn’t find that reading</h1>
      <p className="text-lg text-ink-700">It may not be ready yet.</p>
      <Link href="/c" className={`${primaryButtonLarge} mt-2`}>
        Back to my class
      </Link>
    </div>
  );
}
