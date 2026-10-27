import Link from "next/link";
import { LogoMark } from "./illustrations";
import { focusRing } from "./ui";

// The "unpack" word in two colors with its small open-box mark. The mark
// is hidden from screen readers, so the name read out is just "unpack".
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-2xl font-extrabold tracking-tight">
      <LogoMark className="h-9 w-9" />
      <span>
        <span className="text-primary-700">un</span>
        <span className="text-ink-950">pack</span>
      </span>
    </span>
  );
}

// The wordmark linking home. Every header uses it.
export function Logo({ href }: { href: string }) {
  return (
    <Link href={href} className={`inline-flex min-h-11 items-center rounded-xl ${focusRing}`}>
      <Wordmark />
    </Link>
  );
}
