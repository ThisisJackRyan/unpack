"use client";

import { useEffect } from "react";
import { CLERK_AVATAR_SELECTOR, fixedAvatarAlt } from "@/lib/avatar-alt";

function fix(root: ParentNode) {
  for (const img of root.querySelectorAll<HTMLImageElement>(CLERK_AVATAR_SELECTOR)) {
    const alt = fixedAvatarAlt(img.getAttribute("alt"));
    if (alt !== null) img.setAttribute("alt", alt);
  }
}

// Fixes Clerk's "'s logo" avatar alt for accounts with no name (see
// src/lib/avatar-alt.ts), wherever Clerk draws it, including its menus.
// Renders nothing.
export function ClerkAvatarAlt() {
  useEffect(() => {
    fix(document.body);
    const observer = new MutationObserver(() => fix(document.body));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["alt"] });
    return () => observer.disconnect();
  }, []);
  return null;
}
