import Link from "next/link";
import { focusRing, primaryButton, secondaryButton } from "@/components/ui";

// The public landing page. "Get started" goes to /home, which Clerk
// protects (signed out: sign in or sign up first), then sends each account
// to its home: /welcome to choose, /teacher, or /learn. Students don't
// sign in: they join with a class code.
export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 text-zinc-900">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-10 px-6 py-16">
        <div className="flex flex-col gap-4">
          <p className="text-xl font-semibold tracking-tight text-indigo-700">unpack</p>
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-950 sm:text-5xl">
            Read it. Answer in your own words. Show you really tried.
          </h1>
          <p className="max-w-xl text-lg text-zinc-600">
            Paste any article or text and get a few questions about it. Your answers get a quick check for effort,
            with friendly tips when you need another go.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link href="/home" className={`${primaryButton} min-h-14 px-8 text-lg`}>
            Get started
          </Link>
          <Link href="/sign-in" className={`${secondaryButton} min-h-14 px-8 text-lg`}>
            Sign in
          </Link>
        </div>
        <p className="text-base text-zinc-600">
          Joining a class?{" "}
          <Link
            href="/join"
            className={`rounded font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900 ${focusRing}`}
          >
            Enter your class code
          </Link>
        </p>
      </main>
    </div>
  );
}
