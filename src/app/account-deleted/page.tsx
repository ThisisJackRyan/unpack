import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import { card, focusRing, primaryButton } from "@/components/ui";

// Where a deleted Clerk account lands if a session outlived it (see
// src/lib/deleted-accounts.ts): the account is never recreated. Public in
// src/proxy.ts, and it never loads the account, so it can't loop.
export default function AccountDeleted() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 text-lg text-zinc-900">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
        <div className={`${card} flex flex-col gap-4 px-6 py-10 sm:px-10`}>
          <p className="text-xl font-semibold tracking-tight text-indigo-700">unpack</p>
          <h1 className="text-2xl font-semibold text-zinc-950">This account was deleted</h1>
          <p className="text-lg text-zinc-700">
            It can’t be opened again, and its classes and readings were deleted with it. To use unpack again, sign
            out, then sign up with a new account.
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <SignOutButton redirectUrl="/">
              <button type="button" className={`${primaryButton} min-h-14 px-8 text-lg`}>
                Sign out
              </button>
            </SignOutButton>
            <Link
              href="/"
              className={`inline-flex min-h-14 items-center justify-center rounded-xl px-4 text-lg font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900 ${focusRing}`}
            >
              Go to the start page
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
