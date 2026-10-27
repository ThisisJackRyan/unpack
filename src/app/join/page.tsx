import type { Metadata } from "next";
import Link from "next/link";
import { StudentShell } from "@/components/student-shell";
import { card, primaryButtonLarge } from "@/components/ui";
import { botCheckSiteKey } from "@/lib/join-bot-check";
import { getStudentSession } from "@/lib/student-auth";
import { JoinForm } from "./join-form";

export const metadata: Metadata = { title: "Join your class" };

// Anyone can open this. A student who already has a session sees their
// class first, with one button back to it, and the form below to join a
// different class (which switches this browser to the new class).
export default async function JoinPage() {
  const session = await getStudentSession();

  return (
    <StudentShell>
      <div className="mx-auto flex max-w-md flex-col gap-10">
        {session && (
          <section
            aria-labelledby="current-class-heading"
            className={`${card} flex flex-col gap-5 p-6`}
          >
            <h1
              id="current-class-heading"
              className="text-2xl font-semibold tracking-tight break-words text-ink-950"
            >
              You’re in {session.class.name}
            </h1>
            <Link href="/c" className={`${primaryButtonLarge} w-full`}>
              Go to my class
            </Link>
          </section>
        )}

        <section aria-labelledby="join-heading" className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            {session ? (
              <h2 id="join-heading" className="text-2xl font-semibold tracking-tight text-ink-950">
                Join a different class
              </h2>
            ) : (
              <h1 id="join-heading" className="text-4xl font-semibold tracking-tight text-ink-950">
                Join your class
              </h1>
            )}
            <p className="text-lg text-ink-600">
              {session
                ? `This device will leave ${session.class.name} when you join a different class.`
                : "Type the code your teacher gave you."}
            </p>
          </div>
          <div className={`${card} p-6 sm:p-8`}>
            <JoinForm secondary={Boolean(session)} botCheckSiteKey={botCheckSiteKey()} />
          </div>
        </section>
      </div>
    </StudentShell>
  );
}
