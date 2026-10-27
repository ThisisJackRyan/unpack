// A limit, not an error: calm amber (never red), a clock, and the words.
// role="status", so a screen reader hears it when it appears. Used for
// every rate-limited state (joining, links, question writing, Try again,
// answer checks); the weekly allowance has its own (src/app/learn/allowance.tsx).
export function LimitNotice({ children, large = false }: { children: React.ReactNode; large?: boolean }) {
  return (
    <div
      role="status"
      className={`flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 text-amber-950 ${large ? "px-5 py-4 text-lg" : "px-4 py-3 text-base"}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className={`shrink-0 text-amber-700 ${large ? "mt-1 h-5 w-5" : "mt-0.5 h-5 w-5"}`}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p>{children}</p>
    </div>
  );
}
