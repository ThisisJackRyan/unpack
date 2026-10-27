import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { focusRing } from "@/components/ui";
import { getOrCreateTeacher } from "@/lib/teacher";

// Guards the whole teacher area on the server: no role goes to /welcome,
// a self-learner to /learn (every page and action checks again through
// getOrCreateTeacher).
export default async function TeacherLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await getOrCreateTeacher();
  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between px-6">
          <Link
            href="/teacher"
            className={`rounded-lg text-xl font-semibold tracking-tight text-zinc-950 ${focusRing}`}
          >
            unpack
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className={`inline-flex min-h-11 items-center rounded-lg px-3 text-base font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 ${focusRing}`}
            >
              Settings
            </Link>
            <UserButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10 sm:py-14">
        {children}
      </main>
    </div>
  );
}
