import type { Metadata } from "next";
import Link from "next/link";
import { RolePicker } from "@/components/role-picker";
import { backLink, card } from "@/components/ui";
import { requireArea } from "@/lib/account";
import { settingsBackLink } from "@/lib/account-role";
import { switchRoleAction } from "./actions";

export const metadata: Metadata = {
  title: "Settings",
};

// Any role can switch here. Nothing is deleted on a switch (see
// switchRoleAction).
export default async function SettingsPage() {
  const account = await requireArea("settings");
  const back = settingsBackLink(account.role);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href={back.href} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> {back.label}
      </Link>
      <h1 className="text-4xl font-bold tracking-tight text-ink-950">Settings</h1>
      <div className={`${card} flex flex-col gap-6 p-6 sm:p-8`}>
        <RolePicker
          action={switchRoleAction}
          legend="Use unpack as"
          submitLabel="Save"
          initialRole={account.role}
          ageConfirmed={account.ageConfirmedAt !== null}
          confirmSwitch={account.role === "teacher"}
        />
        <p className="border-t border-ink-200 pt-5 text-base text-ink-700">
          Switching only changes which home you see. Nothing is deleted: your classes and your own readings stay saved,
          and switching back brings them right back.
        </p>
      </div>
    </div>
  );
}
