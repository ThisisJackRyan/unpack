"use client";

import { useActionState } from "react";
import { GRADE_LEVELS, gradeLevelLabel } from "@/lib/grade-levels";
import { field, primaryButton } from "@/components/ui";
import { createClass } from "./actions";
import { CLASS_NAME_MAX_LENGTH, type CreateClassState } from "./form-state";

const initialState: CreateClassState = {};

export function NewClassForm() {
  const [state, formAction, pending] = useActionState(
    createClass,
    initialState,
  );
  const errors = state.errors ?? {};

  return (
    <form action={formAction} noValidate className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="name" className="text-base font-semibold text-ink-900">
          Class name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={CLASS_NAME_MAX_LENGTH}
          autoComplete="off"
          defaultValue={state.values?.name}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? "name-error" : undefined}
          className={field}
        />
        <p id="name-error" aria-live="polite" className="text-base text-danger-700">
          {errors.name}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="gradeLevel"
          className="text-base font-semibold text-ink-900"
        >
          Grade level
        </label>
        <select
          id="gradeLevel"
          name="gradeLevel"
          required
          // Remount on each result so the kept value is applied.
          key={state.values?.gradeLevel ?? ""}
          defaultValue={state.values?.gradeLevel ?? ""}
          aria-invalid={errors.gradeLevel ? true : undefined}
          aria-describedby={errors.gradeLevel ? "grade-error" : undefined}
          className={field}
        >
          <option value="" disabled>
            Choose a grade
          </option>
          {GRADE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {gradeLevelLabel(level)}
            </option>
          ))}
        </select>
        <p
          id="grade-error"
          aria-live="polite"
          className="text-base text-danger-700"
        >
          {errors.gradeLevel}
        </p>
      </div>

      <p aria-live="polite" className="text-base text-danger-700 empty:hidden">
        {errors.form}
      </p>

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Creating…" : "Create class"}
      </button>
    </form>
  );
}
