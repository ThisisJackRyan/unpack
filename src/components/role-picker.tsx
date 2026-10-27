"use client";

import { useActionState, useState } from "react";
import { AGE_CONFIRMED_VALUE, type AccountRole } from "@/lib/account-role";
import type { RoleFormState } from "./role-form-state";
import { primaryButton } from "./ui";

const errorText = "text-base text-red-700";

const CHOICES: { role: AccountRole; title: string; line: string }[] = [
  { role: "teacher", title: "I’m a teacher", line: "Make a class, share a code, and see who’s done." },
  { role: "self_learner", title: "I’m reading for myself", line: "Read anything you like, then check you really got it." },
];

// Two big selectable cards (real radio buttons, so arrow keys move between
// them and a screen reader hears a radio group), then the age box when
// "reading for myself" is picked, then one button. The age box shows with
// CSS (:has) too, so it works before hydration.
export function RolePicker({
  action,
  legend,
  submitLabel,
  initialRole = null,
  ageConfirmed,
}: {
  action: (state: RoleFormState, formData: FormData) => Promise<RoleFormState>;
  legend: string;
  submitLabel: string;
  initialRole?: AccountRole | null;
  // Confirmed before: no box (a switch back doesn't ask again).
  ageConfirmed: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [role, setRole] = useState<string | null>(state.role ?? initialRole);
  // After an error the form is reset to its defaults: follow the kept choice.
  const [shown, setShown] = useState(state);
  if (shown !== state) {
    setShown(state);
    if (state.role) setRole(state.role);
  }
  const errors = state.errors ?? {};
  const askAge = !ageConfirmed;

  return (
    <form action={formAction} noValidate className="group/role flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3" aria-describedby={errors.role ? "role-error" : undefined}>
        <legend className="mb-3 text-xl font-semibold text-zinc-950">{legend}</legend>
        {/* Remount on each result so the kept choice is applied. */}
        <div key={`role-${state.role ?? initialRole ?? "none"}`} className="grid gap-3 sm:grid-cols-2">
          {CHOICES.map((c) => (
            <label
              key={c.role}
              className="relative flex min-h-32 cursor-pointer flex-col gap-2 rounded-2xl border-2 border-zinc-200 bg-white p-5 transition-colors hover:border-indigo-300 has-checked:border-indigo-600 has-checked:bg-indigo-50/60 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-indigo-600"
            >
              <input
                type="radio"
                id={`role-${c.role}`}
                name="role"
                value={c.role}
                defaultChecked={(state.role ?? initialRole) === c.role}
                onChange={(e) => setRole(e.currentTarget.value)}
                aria-describedby={`role-${c.role}-line`}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className="absolute top-5 right-5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-zinc-300 bg-white peer-checked:border-indigo-600 peer-checked:bg-indigo-600"
              >
                <span className="h-2 w-2 rounded-full bg-white" />
              </span>
              <span className="pr-10 text-xl font-semibold text-zinc-950">{c.title}</span>
              <span id={`role-${c.role}-line`} className="text-base text-zinc-600">
                {c.line}
              </span>
            </label>
          ))}
        </div>
        <p id="role-error" aria-live="polite" className={`${errorText} empty:hidden`}>
          {errors.role}
        </p>
      </fieldset>

      {askAge && (
        <div
          className={`flex-col gap-2 rounded-2xl border border-zinc-200 bg-white p-5 ${
            role === "self_learner" ? "flex" : "hidden group-has-[#role-self_learner:checked]/role:flex"
          }`}
        >
          <label htmlFor="ageConfirmed" className="flex min-h-12 cursor-pointer items-center gap-3">
            <input
              id="ageConfirmed"
              name="ageConfirmed"
              type="checkbox"
              value={AGE_CONFIRMED_VALUE}
              aria-invalid={errors.age ? true : undefined}
              aria-describedby={errors.age ? "age-hint age-error" : "age-hint"}
              className="h-6 w-6 shrink-0 cursor-pointer rounded accent-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            />
            <span className="text-lg font-semibold text-zinc-950">I’m 13 or older</span>
          </label>
          <p id="age-hint" className="text-base text-zinc-600">
            You need to be 13 or older to read on your own. Younger readers can join a class with a code from their
            teacher.
          </p>
          <p id="age-error" aria-live="polite" className={`${errorText} empty:hidden`}>
            {errors.age}
          </p>
        </div>
      )}

      <p aria-live="polite" className={`${errorText} empty:hidden`}>
        {errors.form}
      </p>

      <button type="submit" disabled={pending} className={`${primaryButton} min-h-14 px-8 text-lg sm:self-start`}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
