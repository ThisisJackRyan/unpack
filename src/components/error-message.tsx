import { Children } from "react";

// How every error looks: a tinted red box with a border and an icon, so it
// stands out from hints. Red is for errors (and destructive actions) only.
export function ErrorBox({ children, large = false }: { children: React.ReactNode; large?: boolean }) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-2xl border-2 border-danger-300 bg-danger-50 font-semibold text-danger-800 ${large ? "px-4 py-3 text-lg" : "px-3.5 py-2.5 text-base"}`}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        className={`shrink-0 fill-danger-700 ${large ? "mt-0.5 h-6 w-6" : "mt-px h-5 w-5"}`}
      >
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 5a1.4 1.4 0 0 1 1.4 1.5l-.4 5a1 1 0 0 1-2 0l-.4-5A1.4 1.4 0 0 1 12 7Zm0 9.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z" />
      </svg>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

// A field or form error. The wrapper is always in the page (hidden while
// empty), so a screen reader hears the message when it appears: politely
// by default, or right away with `alert` (role="alert"). Point a field's
// aria-describedby at `id`.
export function ErrorMessage({
  id,
  alert = false,
  large = false,
  children,
}: {
  id?: string;
  alert?: boolean;
  large?: boolean;
  children?: React.ReactNode;
}) {
  const shown = Children.toArray(children).some((c) => c !== "");
  return (
    <div id={id} {...(alert ? { role: "alert" } : { "aria-live": "polite" as const })} className="empty:hidden">
      {shown && <ErrorBox large={large}>{children}</ErrorBox>}
    </div>
  );
}
