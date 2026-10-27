import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { focusRing } from "@/components/ui";

export default function TeacherLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
          <UserButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10 sm:py-14">
        {children}
      </main>
    </div>
  );
}
