import { Logo } from "./logo";

// The student area's frame: a quiet header and a narrow column, with
// larger type than the teacher pages (students start in 2nd grade). The
// header and the column share one width, so the logo lines up with the
// page's left edge; `narrow` is for a single centered card (/join): 28rem
// of content plus the padding.
export function StudentShell({ narrow = false, children }: { narrow?: boolean; children: React.ReactNode }) {
  const width = narrow ? "max-w-[31rem]" : "max-w-2xl";
  return (
    <div className="flex min-h-full flex-1 flex-col bg-ink-50 text-lg text-ink-900">
      <header className="border-b-2 border-ink-200 bg-white">
        <div className={`mx-auto flex h-16 w-full ${width} items-center px-6`}>
          <Logo href="/c" />
        </div>
      </header>
      <main className={`mx-auto w-full ${width} flex-1 px-6 py-10 sm:py-14`}>{children}</main>
    </div>
  );
}
