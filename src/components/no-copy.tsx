"use client";

import { useEffect, useRef, type ComponentProps, type SyntheticEvent } from "react";
import {
  BLOCKED_EVENT_HANDLERS,
  collapsedCaret,
  isBlockedInputType,
  isBlockedShortcut,
  type BlockedHandlerName,
} from "@/lib/anti-copy";

// Copy and paste blocking (see src/lib/anti-copy.ts). A speed bump, not
// security: a determined student can get around it, and the effort check
// is the real gate.

const prevent = (e: SyntheticEvent) => e.preventDefault();

// React props that cancel every blocked event.
const blockedHandlers = Object.fromEntries(
  Object.values(BLOCKED_EVENT_HANDLERS).map((name) => [name, prevent]),
) as Record<BlockedHandlerName, typeof prevent>;

// Text that can't be selected, copied, dragged, or long-pressed for a menu.
// user-select: none stops selection; -webkit-touch-callout: none stops the
// iOS callout; the handlers catch whatever still gets through.
export function NoCopyText({ className, children, ...rest }: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onSelectStart = (e: Event) => e.preventDefault();
    el.addEventListener("selectstart", onSelectStart);
    return () => el.removeEventListener("selectstart", onSelectStart);
  }, []);
  return (
    <div
      {...rest}
      ref={ref}
      {...blockedHandlers}
      draggable={false}
      className={`select-none [-webkit-touch-callout:none] ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

type NoCopyTextareaProps = Omit<ComponentProps<"textarea">, BlockedHandlerName | "onKeyDown" | "ref">;

// A textarea where typing and Backspace work, but paste, drop, cut, copy,
// select all, and the context menu don't, and any range selection
// (mouse, double click, Shift+arrows, long press) collapses to a caret.
// beforeinput is a native listener: React's onBeforeInput doesn't carry
// inputType.
export function NoCopyTextarea(props: NoCopyTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let composing = false;
    const collapse = () => {
      const caret = collapsedCaret(el, composing);
      if (caret !== null) el.setSelectionRange(caret, caret);
    };
    const onBeforeInput = (e: InputEvent) => {
      if (isBlockedInputType(e.inputType)) e.preventDefault();
    };
    const onSelectionChange = () => {
      if (document.activeElement === el) collapse();
    };
    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = () => {
      composing = false;
    };
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("select", collapse);
    el.addEventListener("mouseup", collapse);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("select", collapse);
      el.removeEventListener("mouseup", collapse);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);
  return (
    <textarea
      {...props}
      ref={ref}
      {...blockedHandlers}
      onKeyDown={(e) => {
        if (isBlockedShortcut(e)) e.preventDefault();
      }}
    />
  );
}
