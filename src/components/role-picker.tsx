"use client";

import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { BIRTH_MONTH_FIELD, BIRTH_YEAR_FIELD, SWITCH_CONFIRM_VALUE, type AccountRole } from "@/lib/account-role";
import { MONTH_NAMES } from "@/lib/age-screen";
import { ErrorMessage } from "./error-message";
import { AGE_ERROR_ID, AGE_HINT_ID, ageNote, signOutTo, type RoleFormState } from "./role-form-state";
import { field, primaryButtonLarge, secondaryButtonLarge } from "./ui";

const CHOICES: { role: AccountRole; title: string; line: string }[] = [
  { role: "teacher", title: "I’m a teacher", line: "Make a class, share a code, and see who’s done." },
  { role: "self_learner", title: "I’m reading for myself", line: "Read anything you like, then check you really got it." },
];

// Two big selectable cards (real radio buttons, so arrow keys move between
// them and a screen reader hears a radio group), then the age screen when
// "reading for myself" is picked, then one button. The age screen shows
// with CSS (:has) too, so it works before hydration.
//
// The age screen (see src/lib/age-screen.ts) is two selects, birth month
// and birth year, with no default and nothing on the page about what the
// answer is for. The server checks it. When it says no (now, or the
// cookie from before), the class note with a link to /join takes its
// place, with no way to send self-learner again. On /welcome a fresh
// under-13 answer has deleted the account (state.signOutTo): the note
// stays while the form signs the user out to /join. firstRun (/welcome):
// with the cookie, an account with no role gets only the class note, no
// choices at all (the action refuses teacher too).
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
  ageGated,
  birthYears,
  confirmSwitch = false,
  firstRun = false,
}: {
  action: (state: RoleFormState, formData: FormData) => Promise<RoleFormState>;
  legend: string;
  submitLabel: string;
  initialRole?: AccountRole | null;
  // Confirmed before: no box (a switch back doesn't ask again).
  ageConfirmed: boolean;
  // The age gate cookie is on this device: the class note, no screen.
  ageGated: boolean;
  // The year select's options (birthYearOptions, worked out on the server).
  birthYears: number[];
  confirmSwitch?: boolean;
  // /welcome: the account has no role yet.
  firstRun?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [role, setRole] = useState<string | null>(state.role ?? initialRole);
  const [asking, setAsking] = useState(state.switchConfirm === "ask");
  // Picking a month or year clears the age error, so the hint comes back.
  const [ageErrorCleared, setAgeErrorCleared] = useState(false);
  // After an error the form is reset to its defaults: follow the kept choice.
  const [shown, setShown] = useState(state);
  if (shown !== state) {
    setShown(state);
    if (state.role) setRole(state.role);
    setAsking(state.switchConfirm === "ask");
    setAgeErrorCleared(false);
  }
  const errors = state.errors ?? {};
  const gated = !ageConfirmed && (ageGated || state.ageGate === true);
  const askAge = !ageConfirmed && !gated;
  const leaving = state.signOutTo;
  // Only the class note: nothing left to choose.
  const onlyNote = Boolean(leaving) || (firstRun && gated);
  const gateShown = gated && (role === "self_learner" || onlyNote);
  const ageError = ageErrorCleared ? undefined : errors.age;
  const age = ageNote(ageError);
  const confirmed = state.switchConfirm === "confirmed";
  const needsConfirm = confirmSwitch && role === "self_learner" && !confirmed && !gated;
  const warning = needsConfirm && asking;

  // Focus moves to the note when it opens (the button that opened it is
  // gone), and back to the teacher choice on "Keep teaching".
  const warningHeading = useRef<HTMLHeadingElement>(null);
  const teacherRadio = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (warning) warningHeading.current?.focus();
  }, [warning]);

  // The account is gone: sign out, then /join.
  const { signOut } = useClerk();
  useEffect(() => {
    if (leaving) void signOutTo(leaving, signOut, (path) => window.location.assign(path));
  }, [leaving, signOut]);

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
      {!onlyNote && (
        <fieldset className="flex flex-col gap-3" aria-describedby={errors.role ? "role-error" : undefined}>
          <legend className="mb-3 text-xl font-bold text-ink-950">{legend}</legend>
          {/* Remount on each result so the kept choice is applied. */}
          <div key={`role-${state.role ?? initialRole ?? "none"}`} className="grid gap-3 sm:grid-cols-2">
            {CHOICES.map((c) => (
              <label
                key={c.role}
                className="relative flex min-h-32 cursor-pointer flex-col gap-2 rounded-3xl border-2 border-ink-200 bg-white p-5 shadow-card transition-colors hover:border-primary-300 has-checked:border-primary-600 has-checked:bg-primary-50 has-checked:shadow-lip-primary has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary-600"
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
                  className="absolute top-5 right-5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-ink-400 bg-white peer-checked:border-primary-600 peer-checked:bg-primary-600"
                >
                  <span className="h-2 w-2 rounded-full bg-white" />
                </span>
                <span className="pr-10 text-xl font-bold text-ink-950">{c.title}</span>
                <span id={`role-${c.role}-line`} className="text-lg text-ink-700">
                  {c.line}
                </span>
              </label>
            ))}
          </div>
          <ErrorMessage id="role-error">
            {errors.role}
          </ErrorMessage>
        </fieldset>
      )}

      {askAge && !onlyNote && (
        <fieldset
          className={`flex-col gap-3 rounded-3xl border-2 border-ink-200 bg-white p-5 ${
            role === "self_learner" ? "flex" : "hidden group-has-[#role-self_learner:checked]/role:flex"
          }`}
        >
          <legend className="mb-1 text-lg font-semibold text-ink-950">When were you born?</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={BIRTH_MONTH_FIELD} className="text-base font-semibold text-ink-950">
                Birth month
              </label>
              <select
                id={BIRTH_MONTH_FIELD}
                name={BIRTH_MONTH_FIELD}
                defaultValue=""
                onChange={() => setAgeErrorCleared(true)}
                aria-invalid={ageError ? true : undefined}
                aria-describedby={age.describedBy}
                className={`${field} cursor-pointer text-lg`}
              >
                <option value="" disabled>
                  Month
                </option>
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={BIRTH_YEAR_FIELD} className="text-base font-semibold text-ink-950">
                Birth year
              </label>
              <select
                id={BIRTH_YEAR_FIELD}
                name={BIRTH_YEAR_FIELD}
                defaultValue=""
                onChange={() => setAgeErrorCleared(true)}
                aria-invalid={ageError ? true : undefined}
                aria-describedby={age.describedBy}
                className={`${field} cursor-pointer text-lg`}
              >
                <option value="" disabled>
                  Year
                </option>
                {birthYears.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {/* One note at a time: the error replaces the hint while active.
              The error line stays mounted (empty) so it is announced. */}
          {age.show === "hint" && (
            <p id={AGE_HINT_ID} className="text-base text-ink-700">
              We ask everyone who reads on their own. We don’t save your answer.
            </p>
          )}
          <ErrorMessage id={AGE_ERROR_ID}>
            {ageError}
          </ErrorMessage>
        </fieldset>
      )}

      {/* The class note: polite, so it is read out when it appears. */}
      <div aria-live="polite">
        {gateShown && (
          <section
            aria-labelledby="age-gate-title"
            className="flex flex-col gap-4 rounded-3xl border-2 border-primary-200 bg-primary-50 p-5"
          >
            <h2 id="age-gate-title" className="text-xl font-bold text-ink-950">
              Let’s get you into a class
            </h2>
            <p className="text-base text-ink-700">
              Ask your teacher for a class code, then join their class to read and answer questions. You don’t need an
              account for that.
            </p>
            {leaving ? (
              <p role="status" className="text-base font-semibold text-ink-950">
                Taking you there…
              </p>
            ) : (
              <Link href="/join" className={`${primaryButtonLarge} sm:self-start`}>
                Join with a code
              </Link>
            )}
          </section>
        )}
      </div>

      {warning && (
        <section
          aria-labelledby="switch-warning-title"
          aria-describedby="switch-warning-body"
          className="flex flex-col gap-4 rounded-3xl border-2 border-warning-300 bg-warning-50 p-5"
        >
          <h2
            id="switch-warning-title"
            ref={warningHeading}
            tabIndex={-1}
            className="rounded-lg text-xl font-bold text-warning-950 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-warning-600"
          >
            Your classes stay open
          </h2>
          <p id="switch-warning-body" className="text-base text-warning-950">
            While you read for yourself, your classes and join codes stay live. Students can still join with a code
            and keep working on their readings. You can switch back here any time to get to your classes.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              name="confirmSwitch"
              value={SWITCH_CONFIRM_VALUE}
              disabled={pending}
              className={primaryButtonLarge}
            >
              {pending ? "Switching…" : "Switch to reading for myself"}
            </button>
            <button
              type="button"
              onClick={keepTeaching}
              disabled={pending}
              className={`${secondaryButtonLarge} disabled:cursor-not-allowed disabled:opacity-60`}
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

      <ErrorMessage>
        {errors.form}
      </ErrorMessage>

      {!warning && !gateShown && (
        <button type="submit" disabled={pending} className={`${primaryButtonLarge} sm:self-start`}>
          {pending ? "Saving…" : submitLabel}
        </button>
      )}
    </form>
  );
}
