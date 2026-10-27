import Link from "next/link";
import { card, primaryButton } from "@/components/ui";

// One view for every reading a student can't open: a bad id, a draft, a
// reading in another class, or a set they aren't allowed. They all look
// the same, so nothing is revealed about which.
export default function StudentNotFound() {
  return (
    <div className={`${card} flex flex-col items-center gap-4 rounded-2xl px-6 py-14 text-center`}>
      <h1 className="text-2xl font-semibold text-zinc-950">We couldn’t find that reading</h1>
      <p className="text-lg text-zinc-600">It may not be ready yet.</p>
      <Link href="/c" className={`${primaryButton} mt-2 min-h-14 px-7 text-lg`}>
        Back to my class
      </Link>
    </div>
  );
}
