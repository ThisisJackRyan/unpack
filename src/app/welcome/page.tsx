import type { Metadata } from "next";
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
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-950">Welcome to unpack</h1>
        <p className="text-lg text-zinc-600">Pick one to get started. You can change it later in Settings.</p>
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
