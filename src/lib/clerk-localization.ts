import type { ComponentProps } from "react";
import type { ClerkProvider } from "@clerk/nextjs";

type Localization = NonNullable<ComponentProps<typeof ClerkProvider>["localization"]>;

// The account menu button's accessible name. Clerk's UserButton trigger is
// <button aria-label={t(open ? closeUserMenu : openUserMenu)}
// aria-expanded aria-haspopup="dialog">, its avatar inside with an empty
// alt (see avatar-alt.ts). Both keys get the same name: aria-expanded
// already says whether the menu is open.
export const ACCOUNT_MENU_LABEL = "Account menu";

// Set once on the ClerkProvider (src/app/layout.tsx). Clerk merges this
// over its English defaults, so only these keys change.
export const clerkLocalization = {
  userButton: {
    action__openUserMenu: ACCOUNT_MENU_LABEL,
    action__closeUserMenu: ACCOUNT_MENU_LABEL,
  },
} satisfies Localization;
