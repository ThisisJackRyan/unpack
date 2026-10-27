import Link from "next/link";
import { LogoMark, OpenBook, ReadingBuddy, Sparkle } from "@/components/illustrations";
import { primaryButtonLarge, secondaryButtonLarge, textLink } from "@/components/ui";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth-routes";

// The public landing page. "Get started" goes to our own /sign-up page and
// "Sign in" to /sign-in (Clerk components, not Clerk's hosted pages). Both
// land on /home, which sends each account to its home: /welcome to choose,
// /teacher, or /learn. Students don't sign in: they join with a class code.
export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-ink-50 text-ink-900">
      <main className="mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 items-center gap-12 px-6 py-16 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-xl font-bold tracking-tight text-primary-700">
              <LogoMark className="h-8 w-8" />
              unpack
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-ink-950 sm:text-5xl">
              Read it. Answer in your own words. Show you really tried.
            </h1>
            <p className="max-w-xl text-lg text-ink-600">
              Paste any article or text and get a few questions about it. Your answers get a quick check for effort,
              with friendly tips when you need another go.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href={SIGN_UP_PATH} className={primaryButtonLarge}>
              Get started
            </Link>
            <Link href={SIGN_IN_PATH} className={secondaryButtonLarge}>
              Sign in
            </Link>
          </div>
          <p className="text-lg text-ink-600">
            Joining a class?{" "}
            <Link href="/join" className={textLink}>
              Enter your class code
            </Link>
          </p>
        </div>
        <div aria-hidden="true" className="relative mx-auto flex items-end justify-center rounded-[2.5rem] bg-primary-100 px-6 pt-12 pb-8 sm:px-10 sm:pt-14 sm:pb-10">
          <OpenBook className="h-32 w-40 sm:h-48 sm:w-60" />
          <ReadingBuddy className="-ml-8 h-24 w-24 sm:-ml-10 sm:h-36 sm:w-36" />
          <Sparkle className="absolute top-6 left-8 h-12 w-12" />
          <span className="absolute top-10 right-10 h-4 w-4 rounded-full bg-sunny-400" />
          <span className="absolute bottom-8 left-6 h-3 w-3 rounded-full bg-lagoon-300" />
        </div>
      </main>
    </div>
  );
}
