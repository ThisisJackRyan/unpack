import Link from "next/link";
import { focusRing, primaryButtonLarge, secondaryButtonLarge } from "@/components/ui";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth-routes";

// The public landing page. "Get started" goes to our own /sign-up page and
// "Sign in" to /sign-in (Clerk components, not Clerk's hosted pages). Both
// land on /home, which sends each account to its home: /welcome to choose,
// /teacher, or /learn. Students don't sign in: they join with a class code.
export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-ink-50 text-ink-900">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-10 px-6 py-16">
        <div className="flex flex-col gap-4">
          <p className="text-xl font-semibold tracking-tight text-primary-700">unpack</p>
          <h1 className="text-4xl font-semibold tracking-tight text-ink-950 sm:text-5xl">
            Read it. Answer in your own words. Show you really tried.
          </h1>
          <p className="max-w-xl text-lg text-ink-600">
            Paste any article or text and get a few questions about it. Your answers get a quick check for effort,
            with friendly tips when you need another go.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link href={SIGN_UP_PATH} className={`${primaryButtonLarge}`}>
            Get started
          </Link>
          <Link href={SIGN_IN_PATH} className={`${secondaryButtonLarge}`}>
            Sign in
          </Link>
        </div>
        <p className="text-base text-ink-600">
          Joining a class?{" "}
          <Link
            href="/join"
            className={`rounded font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-900 ${focusRing}`}
          >
            Enter your class code
          </Link>
        </p>
      </main>
    </div>
  );
}
