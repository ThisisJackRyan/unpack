import type { ComponentProps } from "react";
import type { ClerkProvider } from "@clerk/nextjs";

type Localization = NonNullable<ComponentProps<typeof ClerkProvider>["localization"]>;

// The account menu button's accessible name. Clerk's UserButton trigger is
// <button aria-label={t(open ? closeUserMenu : openUserMenu)}
// aria-expanded aria-haspopup="dialog">, its avatar inside with an empty
// alt (see avatar-alt.ts). Both keys get the same name: aria-expanded
// already says whether the menu is open.
export const ACCOUNT_MENU_LABEL = "Account menu";

// The sign-in email code step (the first factor screen after an email
// address, signIn.emailCode). Clerk's default subtitle is "to continue to
// {{applicationName}}"; ours says what to do instead. Sign-up keeps its own
// strings.
export const SIGN_IN_CODE_TITLE = "Check your email";
export const SIGN_IN_CODE_SUBTITLE = "Enter the code we sent to your email";

// Set once on the ClerkProvider (src/app/layout.tsx). Clerk merges this
// over its English defaults, so only these keys change.
export const clerkLocalization = {
  userButton: {
    action__openUserMenu: ACCOUNT_MENU_LABEL,
    action__closeUserMenu: ACCOUNT_MENU_LABEL,
  },
  signIn: {
    emailCode: { title: SIGN_IN_CODE_TITLE, subtitle: SIGN_IN_CODE_SUBTITLE },
  },
} satisfies Localization;
