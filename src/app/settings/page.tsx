import type { Metadata } from "next";
import Link from "next/link";
import { RolePicker } from "@/components/role-picker";
import { backLink, card } from "@/components/ui";
import { requireArea } from "@/lib/account";
import { homeFor } from "@/lib/account-role";
import { switchRoleAction } from "./actions";

export const metadata: Metadata = {
  title: "Settings",
};

// Any role can switch here. Nothing is deleted on a switch (see
// switchRoleAction).
export default async function SettingsPage() {
  const account = await requireArea("settings");
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href={homeFor(account.role)} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> Back home
      </Link>
      <h1 className="text-4xl font-semibold tracking-tight text-zinc-950">Settings</h1>
      <div className={`${card} flex flex-col gap-6 rounded-2xl p-6 sm:p-8`}>
        <RolePicker
          action={switchRoleAction}
          legend="Use unpack as"
          submitLabel="Save"
          initialRole={account.role}
          ageConfirmed={account.ageConfirmedAt !== null}
        />
        <p className="border-t border-zinc-200 pt-5 text-base text-zinc-600">
          Switching only changes which home you see. Nothing is deleted: your classes and your own readings stay saved,
          and switching back brings them right back.
        </p>
      </div>
    </div>
  );
}
