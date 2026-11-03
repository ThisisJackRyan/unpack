import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ACCOUNT_MENU_LABEL, clerkLocalization, SIGN_IN_CODE_SUBTITLE, SIGN_IN_CODE_TITLE } from "./clerk-localization";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// C3: the account menu button (Clerk's UserButton) is named "Account menu",
// open or closed, through Clerk's own localization keys for its aria-label.
describe("account menu button name", () => {
  it("is Account menu, open or closed", () => {
    assert.equal(ACCOUNT_MENU_LABEL, "Account menu");
    assert.deepEqual(clerkLocalization.userButton, {
      action__openUserMenu: "Account menu",
      action__closeUserMenu: "Account menu",
    });
  });

  it("is set on the ClerkProvider every UserButton sits under", () => {
    const layout = read("../app/layout.tsx");
    assert.match(layout, /<ClerkProvider\s[^>]*localization=\{clerkLocalization\}/);
    for (const path of ["../app/teacher/layout.tsx", "../components/account-shell.tsx"]) {
      assert.match(read(path), /<UserButton \/>/, path);
    }
  });
});

// The sign-in email code step says what to do, not Clerk's "to continue to
// {{applicationName}}". Only the sign-in code step changes.
describe("sign-in email code step", () => {
  it("is Check your email, Enter the code we sent to your email", () => {
    assert.equal(SIGN_IN_CODE_TITLE, "Check your email");
    assert.equal(SIGN_IN_CODE_SUBTITLE, "Enter the code we sent to your email");
    assert.deepEqual(clerkLocalization.signIn, {
      emailCode: { title: "Check your email", subtitle: "Enter the code we sent to your email" },
    });
  });

  it("leaves every other section on Clerk's defaults", () => {
    assert.deepEqual(Object.keys(clerkLocalization).sort(), ["signIn", "userButton"]);
  });
});
