import { ClerkFailed, ClerkLoading } from "@clerk/nextjs";
import { ErrorBox } from "./error-message";
import { AUTH_LOADING_COPY, type AuthLoadingKind } from "./auth-loading-text";
import { OpenBook } from "./illustrations";
import { card } from "./ui";

// Clerk's sign-in and sign-up forms render nothing until Clerk's script
// has loaded (a few seconds on a slow line), so the page isn't blank: a
// card about the size of Clerk's with a friendly line (a status region)
// while it loads, and an error note if it never does. The book bobs
// gently; under prefers-reduced-motion it stays still.
export function AuthLoading({ kind }: { kind: AuthLoadingKind }) {
  return (
    <>
      <ClerkLoading>
        <div
          role="status"
          className={`${card} flex min-h-96 w-full max-w-[25rem] flex-col items-center justify-center gap-5 px-8 py-12 text-center`}
        >
          <OpenBook className="h-20 w-28 motion-safe:animate-pencil" />
          <p className="font-display text-2xl font-bold text-ink-950">{AUTH_LOADING_COPY[kind]}</p>
          <p className="text-lg text-ink-700">{AUTH_LOADING_COPY.hint}</p>
        </div>
      </ClerkLoading>
      <ClerkFailed>
        <div role="alert" className={`${card} flex w-full max-w-[25rem] flex-col gap-4 px-8 py-10`}>
          <ErrorBox>
            <span className="font-bold">{AUTH_LOADING_COPY.failedTitle}</span> {AUTH_LOADING_COPY.failedBody}
          </ErrorBox>
        </div>
      </ClerkFailed>
    </>
  );
}
