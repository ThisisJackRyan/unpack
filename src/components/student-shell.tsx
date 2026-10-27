import Link from "next/link";
import { focusRing } from "./ui";

// The student area's frame: a quiet header and a narrow column, with
// larger type than the teacher pages (students start in 2nd grade).
export function StudentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-ink-50 text-lg text-ink-900">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex h-16 w-full max-w-2xl items-center px-6">
          <Link
            href="/c"
            className={`rounded-lg text-xl font-semibold tracking-tight text-ink-950 ${focusRing}`}
          >
            unpack
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10 sm:py-14">{children}</main>
    </div>
  );
}
