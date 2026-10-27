// Shared Tailwind class strings for the teacher area. Indigo is the one
// accent color; everything else is zinc on white.

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600";

export const primaryButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-base font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

export const secondaryButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-5 text-base font-semibold text-zinc-900 transition-colors hover:bg-zinc-50 ${focusRing}`;

export const backLink = `inline-flex min-h-12 items-center gap-1 rounded-lg text-base font-medium text-zinc-600 hover:text-zinc-900 ${focusRing}`;

export const card = "rounded-xl border border-zinc-200 bg-white";
