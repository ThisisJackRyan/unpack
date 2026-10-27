"use client";

import { useActionState } from "react";
import { field, primaryButton, secondaryButton } from "@/components/ui";
import { joinClassAction } from "./actions";
import { FIRST_NAME_MAX_LENGTH, LAST_INITIALS_MAX_LENGTH, type JoinState } from "./form-state";

const initialState: JoinState = {};

const label = "text-lg font-semibold text-zinc-900";
const hint = "text-base text-zinc-600";
const error = "text-base font-medium text-red-700";

// One big code field, then the two name fields, then one full-width
// button. `secondary` styles the button down when the page already has a
// primary action (going back to the student's current class).
export function JoinForm({ secondary = false }: { secondary?: boolean }) {
  const [state, formAction, pending] = useActionState(joinClassAction, initialState);
  const errors = state.errors ?? {};
  const values = state.values;

  return (
    <form action={formAction} noValidate className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <label htmlFor="code" className={label}>
          Class code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          required
          maxLength={12}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={values?.code}
          aria-invalid={errors.code ? true : undefined}
          aria-describedby="code-error"
          className={`${field} min-h-16 text-center font-mono text-3xl font-semibold tracking-[0.3em] uppercase`}
        />
        <p id="code-error" aria-live="polite" className={error}>
          {errors.code}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="firstName" className={label}>
          First name
        </label>
        <input
          id="firstName"
          name="firstName"
          type="text"
          required
          maxLength={FIRST_NAME_MAX_LENGTH}
          // Off on purpose: school devices are shared, so the browser
          // shouldn't offer the last student's name.
          autoComplete="off"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={values?.firstName}
          aria-invalid={errors.firstName ? true : undefined}
          aria-describedby="firstName-error"
          className={field}
        />
        <p id="firstName-error" aria-live="polite" className={error}>
          {errors.firstName}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="lastInitials" className={label}>
          First 1 or 2 letters of your last name
        </label>
        <p id="lastInitials-hint" className={hint}>
          For Maya Rodriguez, type Ro.
        </p>
        <input
          id="lastInitials"
          name="lastInitials"
          type="text"
          required
          maxLength={LAST_INITIALS_MAX_LENGTH}
          autoComplete="off"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={values?.lastInitials}
          aria-invalid={errors.lastInitials ? true : undefined}
          aria-describedby="lastInitials-hint lastInitials-error"
          className={`${field} max-w-32`}
        />
        <p id="lastInitials-error" aria-live="polite" className={error}>
          {errors.lastInitials}
        </p>
      </div>

      <p aria-live="polite" className={`${error} empty:hidden`}>
        {errors.form}
      </p>

      <button
        type="submit"
        disabled={pending}
        className={`${secondary ? secondaryButton : primaryButton} min-h-14 w-full text-lg`}
      >
        {pending ? "Joining…" : "Join class"}
      </button>
    </form>
  );
}
