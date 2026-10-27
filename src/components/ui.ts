// Shared Tailwind class strings for the teacher area. Indigo is the one
// accent color; everything else is zinc on white.

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600";

export const primaryButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-base font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

export const secondaryButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-5 text-base font-semibold text-zinc-900 transition-colors hover:bg-zinc-50 ${focusRing}`;

// The smaller neutral button for a table row (still a 44px tap target).
export const secondarySmallButton = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

export const backLink = `inline-flex min-h-12 items-center gap-1 rounded-lg text-base font-medium text-zinc-600 hover:text-zinc-900 ${focusRing}`;

export const card = "rounded-xl border border-zinc-200 bg-white";

export const field = `block min-h-12 w-full rounded-xl border bg-white border-zinc-300 px-4 text-lg text-zinc-950 aria-invalid:border-red-600 ${focusRing}`;

export const pill =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium";

// Red is only for destructive actions (and errors): the confirm button of
// a delete, and the row button that opens it.
const dangerFocusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600";

export const dangerButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-red-600 px-5 text-base font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 ${dangerFocusRing}`;

export const dangerGhostButton = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-60 ${dangerFocusRing}`;
