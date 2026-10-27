import { SignIn } from "@clerk/nextjs";
import { AFTER_AUTH_PATH } from "@/lib/auth-routes";

// After sign-in, /home sends the account to its home (no role yet:
// /welcome). A redirect_url from a protected page still wins.
export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <SignIn fallbackRedirectUrl={AFTER_AUTH_PATH} />
    </main>
  );
}
