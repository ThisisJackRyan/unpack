// Shared Tailwind class strings, for every area. Tailwind orders same-property
// utilities by name, not by where they sit in a class string, so `pill` and
// `field` leave the text size to the caller. The colors are the theme
// tokens in src/app/globals.css: primary is the one accent for actions;
// ink is the neutral. Buttons are chunky, with a bottom "lip" that presses
// in (the press only moves when motion is allowed).

export const focusRing =
  "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary-600";

const press =
  "transition-colors not-disabled:active:shadow-none motion-safe:not-disabled:active:translate-y-1 motion-safe:transition-[color,background-color,box-shadow,translate]";

export const primaryButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-primary-600 px-6 font-display text-base font-bold text-white shadow-lip-primary hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 ${press} ${focusRing}`;

// The big student action: full height (56px) and larger text. Width and
// alignment are up to the page.
export const primaryButtonLarge = primaryButton.replace("min-h-12", "min-h-14").replace("text-base", "text-lg").replace("px-6", "px-8");

// The same weight as primaryButtonLarge in a second, sunny color, for the
// students' way in ("Join a class") next to the main action.
export const accentButtonLarge = primaryButtonLarge
  .replace("bg-primary-600", "bg-sunny-300")
  .replace("text-white", "text-ink-950")
  .replace("shadow-lip-primary", "shadow-lip-sunny")
  .replace("hover:bg-primary-700", "hover:bg-sunny-400");

export const secondaryButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border-2 border-ink-400 bg-white px-6 font-display text-base font-bold text-ink-900 shadow-lip-ink hover:bg-ink-50 ${press} ${focusRing}`;

export const secondaryButtonLarge = secondaryButton.replace("min-h-12", "min-h-14").replace("text-base", "text-lg").replace("px-6", "px-8");

// The smaller neutral button for a table row (still a 44px tap target).
export const secondarySmallButton = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-ink-400 bg-white px-3 text-base font-semibold text-ink-900 transition-colors hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

export const backLink = `inline-flex min-h-12 items-center gap-1 rounded-xl text-base font-semibold text-primary-700 hover:text-primary-900 ${focusRing}`;

export const card = "rounded-3xl border-2 border-ink-200 bg-white shadow-card";

export const field = `block min-h-12 w-full rounded-2xl border-2 bg-white border-ink-400 px-4 text-ink-950 aria-invalid:border-danger-600 ${focusRing}`;

// Badges and counters: roomy padding, so the words read easily (F7).
export const pill =
  "inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 font-semibold";

// An inline text link in a sentence.
export const textLink = `rounded font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-900 ${focusRing}`;

// Red is only for destructive actions (and errors): the confirm button of
// a delete, and the row button that opens it.
const dangerFocusRing =
  "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-danger-600";

export const dangerButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-danger-600 px-6 font-display text-base font-bold text-white shadow-lip-danger hover:bg-danger-700 disabled:cursor-not-allowed disabled:opacity-60 ${press} ${dangerFocusRing}`;

// The full-size opener of a delete's confirm (the reading delete): red
// text and border on white, so the solid red stays for the confirm.
export const dangerOutlineButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border-2 border-danger-600 bg-white px-6 font-display text-base font-bold text-danger-700 transition-colors hover:bg-danger-50 hover:text-danger-800 disabled:cursor-not-allowed disabled:opacity-60 ${dangerFocusRing}`;

export const dangerGhostButton = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-base font-semibold text-danger-700 transition-colors hover:bg-danger-50 hover:text-danger-800 disabled:cursor-not-allowed disabled:opacity-60 ${dangerFocusRing}`;

// The row of actions on a card (a question's Edit, Regenerate and
// Delete): outlined, 48px tall, one shape for all. Delete is the only red
// one, and it still opens a red confirm.
export const actionButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-ink-400 bg-white px-4 text-base font-semibold text-ink-900 transition-colors hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const dangerActionButton = actionButton
  .replace("border-ink-400", "border-danger-600")
  .replace("text-ink-900", "text-danger-700")
  .replace("hover:bg-ink-50", "hover:bg-danger-50 hover:text-danger-800")
  .replace(focusRing, dangerFocusRing);

// A radio choice as a card (the reading form's Source and Question mode):
// the real radio input stays visible at the start, and the chosen card
// gets a primary border and tint. The focus ring goes on the whole card.
export const optionCard = `flex min-h-14 cursor-pointer gap-3 rounded-2xl border-2 border-ink-400 bg-white px-4 py-3 text-ink-950 transition-colors hover:border-primary-600 hover:bg-primary-50/50 has-checked:border-primary-600 has-checked:bg-primary-50 has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary-600`;

// The radio inside an optionCard: native, so keyboard and screen readers
// get a real radio group; the card shows the focus ring instead.
export const optionRadio = "h-5 w-5 shrink-0 cursor-pointer accent-primary-600 focus-visible:outline-none";

// A quieter second action beside a primary button (the reading form's
// "Save draft"): a real button that reads as a text link, still a 48px
// tap target.
export const quietButton = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-lg font-semibold text-primary-700 underline underline-offset-4 hover:bg-primary-50 hover:text-primary-900 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;
