import { redirect } from "next/navigation";
import { getOrCreateAccount } from "@/lib/account";
import { homeFor } from "@/lib/account-role";

// Where sign-in and sign-up land (NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL
// and NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL) and the landing
// page's button: sends each account to its home (no role yet: /welcome).
export default async function HomeRedirect() {
  const account = await getOrCreateAccount();
  redirect(homeFor(account.role));
}
