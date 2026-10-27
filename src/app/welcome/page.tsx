import type { Metadata } from "next";
import { Sparkle } from "@/components/illustrations";
import { RolePicker } from "@/components/role-picker";
import { requireArea } from "@/lib/account";
import { chooseRoleAction } from "./actions";

export const metadata: Metadata = {
  title: "Welcome",
};

// The first-run choice after sign-up. An account that already chose is
// sent to its home.
export default async function WelcomePage() {
  const account = await requireArea("welcome");
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <div className="flex items-center gap-5 rounded-3xl bg-primary-50 px-6 py-6 sm:px-8">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="text-4xl font-bold tracking-tight text-ink-950">Welcome to unpack</h1>
          <p className="text-lg text-ink-700">Pick one to get started. You can change it later in Settings.</p>
        </div>
        <Sparkle className="h-16 w-16 shrink-0 sm:h-20 sm:w-20" />
      </div>
      <RolePicker
        action={chooseRoleAction}
        legend="How will you use unpack?"
        submitLabel="Continue"
        ageConfirmed={account.ageConfirmedAt !== null}
      />
    </div>
  );
}
