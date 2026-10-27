"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { AGE_CONFIRMED_VALUE, SWITCH_CONFIRM_VALUE, type AccountRole } from "@/lib/account-role";
import type { RoleFormState } from "./role-form-state";
import { primaryButton, secondaryButton } from "./ui";

const errorText = "text-base text-red-700";

const CHOICES: { role: AccountRole; title: string; line: string }[] = [
  { role: "teacher", title: "I’m a teacher", line: "Make a class, share a code, and see who’s done." },
  { role: "self_learner", title: "I’m reading for myself", line: "Read anything you like, then check you really got it." },
];

// Two big selectable cards (real radio buttons, so arrow keys move between
// them and a screen reader hears a radio group), then the age box when
// "reading for myself" is picked, then one button. The age box shows with
// CSS (:has) too, so it works before hydration.
//
// confirmSwitch (/settings, for a teacher): choosing "reading for myself"
// and pressing the button first shows an amber note that the classes stay
// live, with "Switch to reading for myself" (sends the confirm) and "Keep
// teaching". The action refuses the switch without the confirm and asks
// the same way, so the note can't be skipped.
export function RolePicker({
  action,
  legend,
  submitLabel,
  initialRole = null,
  ageConfirmed,
  confirmSwitch = false,
}: {
  action: (state: RoleFormState, formData: FormData) => Promise<RoleFormState>;
  legend: string;
  submitLabel: string;
  initialRole?: AccountRole | null;
  // Confirmed before: no box (a switch back doesn't ask again).
  ageConfirmed: boolean;
  confirmSwitch?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [role, setRole] = useState<string | null>(state.role ?? initialRole);
  const [asking, setAsking] = useState(state.switchConfirm === "ask");
  // After an error the form is reset to its defaults: follow the kept choice.
  const [shown, setShown] = useState(state);
  if (shown !== state) {
    setShown(state);
    if (state.role) setRole(state.role);
    setAsking(state.switchConfirm === "ask");
  }
  const errors = state.errors ?? {};
  const askAge = !ageConfirmed;
  const confirmed = state.switchConfirm === "confirmed";
  const needsConfirm = confirmSwitch && role === "self_learner" && !confirmed;
  const warning = needsConfirm && asking;

  // Focus moves to the note when it opens (the button that opened it is
  // gone), and back to the teacher choice on "Keep teaching".
  const warningHeading = useRef<HTMLHeadingElement>(null);
  const teacherRadio = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (warning) warningHeading.current?.focus();
  }, [warning]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    if (needsConfirm && submitter?.getAttribute("name") !== "confirmSwitch") {
      e.preventDefault();
      setAsking(true);
    }
  }

  function keepTeaching() {
    const radio = teacherRadio.current;
    if (radio) {
      radio.checked = true;
      radio.focus();
    }
    setRole("teacher");
    setAsking(false);
  }

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="group/role flex flex-col gap-6">
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
                ref={c.role === "teacher" ? teacherRadio : undefined}
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

      {warning && (
        <section
          aria-labelledby="switch-warning-title"
          aria-describedby="switch-warning-body"
          className="flex flex-col gap-4 rounded-2xl border border-amber-300 bg-amber-50 p-5"
        >
          <h2
            id="switch-warning-title"
            ref={warningHeading}
            tabIndex={-1}
            className="rounded-lg text-xl font-semibold text-amber-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
          >
            Your classes stay open
          </h2>
          <p id="switch-warning-body" className="text-base text-amber-950">
            While you read for yourself, your classes and join codes stay live. Students can still join with a code
            and keep working on their readings. You can switch back here any time to get to your classes.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              name="confirmSwitch"
              value={SWITCH_CONFIRM_VALUE}
              disabled={pending}
              className={`${primaryButton} min-h-14 px-6 text-lg`}
            >
              {pending ? "Switching…" : "Switch to reading for myself"}
            </button>
            <button
              type="button"
              onClick={keepTeaching}
              disabled={pending}
              className={`${secondaryButton} min-h-14 px-6 text-lg disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Keep teaching
            </button>
          </div>
        </section>
      )}

      {/* Confirmed already, then stopped by another error: the retry keeps it. */}
      {confirmSwitch && confirmed && role === "self_learner" && (
        <input type="hidden" name="confirmSwitch" value={SWITCH_CONFIRM_VALUE} />
      )}

      <p aria-live="polite" className={`${errorText} empty:hidden`}>
        {errors.form}
      </p>

      {!warning && (
        <button type="submit" disabled={pending} className={`${primaryButton} min-h-14 px-8 text-lg sm:self-start`}>
          {pending ? "Saving…" : submitLabel}
        </button>
      )}
    </form>
  );
}
