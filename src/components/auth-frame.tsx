import { ReadingBuddy, Sparkle } from "./illustrations";
import { Logo } from "./logo";

// The frame around Clerk's sign-in and sign-up: the logo header, the page
// tint, and the reading buddy beside the form on wide screens.
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-ink-50 text-ink-900">
      <header className="border-b-2 border-ink-200 bg-white">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center px-6">
          <Logo href="/" />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 items-center justify-center gap-16 px-6 py-12 sm:py-16">
        <div aria-hidden="true" className="relative hidden lg:block">
          <ReadingBuddy className="h-56 w-56" />
          <Sparkle className="absolute -top-6 -right-6 h-14 w-14" />
        </div>
        {children}
      </main>
    </div>
  );
}
