import type { ComponentProps } from "react";
import type { ClerkProvider } from "@clerk/nextjs";

type Appearance = NonNullable<ComponentProps<typeof ClerkProvider>["appearance"]>;

// Clerk's sign-in, sign-up and account menu, in the app's look. Set once on
// the ClerkProvider (src/app/layout.tsx), so every Clerk component shares it.
//
// Clerk works out its hover and tint shades from these, so they're hex,
// copied from the theme tokens in src/app/globals.css (named in the
// comments; src/lib/clerk-appearance.test.ts keeps them in step).
export const CLERK_COLORS = {
  colorPrimary: "#5847e0", // primary-600
  colorPrimaryForeground: "#ffffff", // white
  colorDanger: "#c4262f", // danger-600
  colorSuccess: "#15803d", // success-600
  colorWarning: "#c97a06", // warning-600
  colorNeutral: "#16142a", // ink-950
  colorForeground: "#16142a", // ink-950
  colorMutedForeground: "#47445e", // ink-700
  colorBackground: "#ffffff", // white
  colorInput: "#ffffff", // white
  colorInputForeground: "#16142a", // ink-950
  colorRing: "#5847e0", // primary-600
  colorBorder: "#8a86a1", // ink-400
} as const;

// The elements take Tailwind classes. Clerk's own styles sit in the
// "clerk" CSS layer, below Tailwind's utilities (see the @layer order at
// the top of globals.css), so these win without !important.
export const clerkAppearance: Appearance = {
  cssLayerName: "clerk",
  variables: {
    ...CLERK_COLORS,
    fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
    fontFamilyButtons: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
    fontSize: "1rem",
    borderRadius: "1rem",
  },
  elements: {
    cardBox: "rounded-3xl border-2 border-ink-200 shadow-card",
    headerTitle: "text-2xl font-bold tracking-tight text-ink-950",
    headerSubtitle: "text-base text-ink-700",
    formFieldLabel: "text-base font-semibold text-ink-950",
    formFieldHintText: "text-base text-ink-700",
    formFieldInput: "min-h-12 rounded-2xl text-base",
    otpCodeFieldInput: "text-2xl font-semibold",
    formFieldErrorText: "text-base font-semibold text-danger-800",
    formButtonPrimary: "min-h-12 rounded-2xl text-base font-bold normal-case shadow-lip-primary",
    socialButtonsBlockButton: "min-h-12 rounded-2xl border-2 border-ink-400 text-base font-semibold",
    alternativeMethodsBlockButton: "min-h-12 rounded-2xl border-2 border-ink-400 text-base font-semibold",
    footerActionLink: "font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-900",
    formResendCodeLink: "font-semibold text-primary-700 hover:text-primary-900",
    identityPreviewEditButton: "text-primary-700 hover:text-primary-900",
    dividerText: "text-base text-ink-700",
  },
};
