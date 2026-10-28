import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ACCOUNT_MENU_LABEL, clerkLocalization } from "./clerk-localization";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// C3: the account menu button (Clerk's UserButton) is named "Account menu",
// open or closed, through Clerk's own localization keys for its aria-label.
describe("account menu button name", () => {
  it("is Account menu, open or closed", () => {
    assert.equal(ACCOUNT_MENU_LABEL, "Account menu");
    assert.deepEqual(clerkLocalization, {
      userButton: { action__openUserMenu: "Account menu", action__closeUserMenu: "Account menu" },
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
