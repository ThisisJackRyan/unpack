import Link from "next/link";
import { LogoMark } from "./illustrations";
import { focusRing } from "./ui";

// The "unpack" word with its small mark, linking home. Every header uses it.
export function Logo({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex min-h-11 items-center gap-2 rounded-xl text-xl font-bold tracking-tight text-ink-950 ${focusRing}`}
    >
      <LogoMark className="h-8 w-8" />
      unpack
    </Link>
  );
}
