// A Clerk user with no email address, on a first visit. A fixed message:
// never the Clerk id or anything else from Clerk, so safe-error-fields.ts
// can log it as is. In its own module (no imports) so that file can
// import it.
export class ClerkUserNoEmailError extends Error {
  constructor() {
    super("Clerk user has no email address");
    this.name = "ClerkUserNoEmailError";
  }
}
