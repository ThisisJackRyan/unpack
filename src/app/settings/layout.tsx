import { AccountShell } from "@/components/account-shell";
import { requireArea } from "@/lib/account";
import { homeFor } from "@/lib/account-role";

export default async function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const account = await requireArea("settings");
  return <AccountShell homeHref={homeFor(account.role)}>{children}</AccountShell>;
}
