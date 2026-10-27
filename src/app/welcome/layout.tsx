import { AccountShell } from "@/components/account-shell";

export default function WelcomeLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AccountShell homeHref="/welcome">{children}</AccountShell>;
}
