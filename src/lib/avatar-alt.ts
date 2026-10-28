// Clerk's avatar image (the account menu button, the account card in its
// menu, and the profile page) has the alt text `${fullName}'s logo`. An
// account without a name (ours sign up with an email code only) gets
// "'s logo". Clerk has no prop or localization key for it, so
// ClerkAvatarAlt (src/components/clerk-avatar-alt.tsx) fixes it in the
// page: the image is decorative there (the menu button has its own label,
// "Account menu", set in src/lib/clerk-localization.ts, and the menu shows
// the email next to it), so its alt becomes empty.

// The alt to use instead, or null to leave it alone.
export function fixedAvatarAlt(alt: string | null): string | null {
  if (alt === null) return null;
  return /^\s*['’]/.test(alt) ? "" : null;
}

// What the fix looks at: Clerk's avatar images (its avatarImage element).
export const CLERK_AVATAR_SELECTOR = "img.cl-avatarImage";
