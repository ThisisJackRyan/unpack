import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Logo } from "./logo";
import { focusRing } from "./ui";

export type ShellLink = { href: string; label: string };

// The frame for signed-in account pages outside the teacher area: the
// first-run choice, settings, and the self-learner area. A quiet header
// (logo to `homeHref`, optional links, the Clerk menu) and a centered
// column, with the student area's larger type.
export function AccountShell({
  homeHref,
  links = [],
  children,
}: {
  homeHref: string;
  links?: ShellLink[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-ink-50 text-lg text-ink-900">
      <header className="border-b-2 border-ink-200 bg-white">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between gap-4 px-6">
          <Logo href={homeHref} />
          <div className="flex items-center gap-1 sm:gap-2">
            {links.length > 0 && (
              <nav aria-label="Main" className="flex items-center gap-1">
                {links.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={`inline-flex min-h-11 items-center rounded-xl px-3 text-base font-semibold text-ink-700 transition-colors hover:bg-primary-50 hover:text-primary-800 ${focusRing}`}
                  >
                    {l.label}
                  </Link>
                ))}
              </nav>
            )}
            <UserButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 sm:py-14">{children}</main>
    </div>
  );
}
