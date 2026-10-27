import { SignIn } from "@clerk/nextjs";
import { AuthFrame } from "@/components/auth-frame";
import { AuthLoading } from "@/components/auth-loading";
import { AFTER_AUTH_PATH } from "@/lib/auth-routes";

// After sign-in, /home sends the account to its home (no role yet:
// /welcome). A redirect_url from a protected page still wins.
export default function SignInPage() {
  return (
    <AuthFrame>
      <AuthLoading kind="signIn" />
      <SignIn fallbackRedirectUrl={AFTER_AUTH_PATH} />
    </AuthFrame>
  );
}
