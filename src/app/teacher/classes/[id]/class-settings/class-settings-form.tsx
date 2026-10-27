"use client";

import { useActionState, useState } from "react";
import { CLASS_GRADE_HELP, gradeChangeWarning, warnsOnGradeChange } from "@/lib/class-settings";
import { GRADE_LEVELS, gradeLevelLabel, isGradeLevel, type GradeLevel } from "@/lib/grade-levels";
import { CLASS_NAME_MAX_LENGTH } from "@/lib/validate-class";
import { field, primaryButton } from "@/components/ui";
import type { ClassSettingsState } from "./state";

type Action = (state: ClassSettingsState, formData: FormData) => Promise<ClassSettingsState>;

// The class name and grade level, in settings rows like the join code's.
// Not destructive (no student data is touched), so indigo, not red. When
// the teacher picks a different grade and drafts would lose their
// questions, an amber note says how many before they save. One live
// region says what happened.
export function ClassSettingsForm({
  name,
  gradeLevel,
  draftsToClear,
  action,
}: {
  name: string;
  gradeLevel: GradeLevel;
  draftsToClear: number;
  action: Action;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  const [picked, setPicked] = useState<string>(gradeLevel);
  const errors = state.errors ?? {};
  const warn = warnsOnGradeChange(gradeLevel, picked, draftsToClear) && isGradeLevel(picked);

  return (
    <form action={dispatch} noValidate aria-busy={pending} className="flex flex-col divide-y divide-zinc-200">
      <div className="flex flex-col gap-2 py-5 first:pt-0">
        <label htmlFor="class-name" className="text-base font-semibold text-zinc-950">
          Class name
        </label>
        <input
          id="class-name"
          name="name"
          type="text"
          required
          maxLength={CLASS_NAME_MAX_LENGTH}
          autoComplete="off"
          defaultValue={state.values?.name ?? name}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? "class-name-error" : undefined}
          className={field}
        />
        <p id="class-name-error" aria-live="polite" className="text-base text-red-700 empty:hidden">
          {errors.name}
        </p>
      </div>

      <div className="flex flex-col gap-2 py-5">
        <label htmlFor="class-grade" className="text-base font-semibold text-zinc-950">
          Grade level
        </label>
        <p id="class-grade-help" className="text-sm text-zinc-600">
          {CLASS_GRADE_HELP}
        </p>
        <select
          id="class-grade"
          name="gradeLevel"
          required
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          aria-invalid={errors.gradeLevel ? true : undefined}
          aria-describedby={`class-grade-help${warn ? " class-grade-warning" : ""}${errors.gradeLevel ? " class-grade-error" : ""}`}
          className={field}
        >
          {GRADE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {gradeLevelLabel(level)}
            </option>
          ))}
        </select>
        <p id="class-grade-error" aria-live="polite" className="text-base text-red-700 empty:hidden">
          {errors.gradeLevel}
        </p>
        {warn && isGradeLevel(picked) && (
          <p
            id="class-grade-warning"
            className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-base text-amber-950"
          >
            <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-amber-500" />
            <span>{gradeChangeWarning(draftsToClear, picked)}</span>
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p
          aria-live="polite"
          className={`text-base font-medium empty:hidden ${state.error ? "text-red-700" : "text-indigo-900"}`}
        >
          {pending ? "" : (state.error ?? state.message ?? "")}
        </p>
        <button type="submit" disabled={pending} className={`${primaryButton} sm:ml-auto`}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
