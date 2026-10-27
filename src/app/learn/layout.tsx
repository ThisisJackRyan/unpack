import { AccountShell } from "@/components/account-shell";
import { requireSelfLearner } from "@/lib/account";

// Guards the whole self-learner area on the server: no role goes to
// /welcome, a teacher to /teacher (every page and action checks again
// through requireSelfLearner).
export default async function LearnLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireSelfLearner();
  return (
    <AccountShell
      homeHref="/learn"
      links={[
        { href: "/learn/history", label: "History" },
        { href: "/settings", label: "Settings" },
      ]}
    >
      {children}
    </AccountShell>
  );
}
