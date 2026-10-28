import type { Instrumentation } from "next";

// Next runs register() once when a server instance starts, before any
// request. It wraps the console so every log line, Next's own uncaught
// error output included, goes through safeErrorFields (see
// src/lib/safe-console.ts). Node.js only: the app has no Edge code (the
// proxy runs on Node.js in Next 16), and the import stays out of any Edge
// bundle because NEXT_RUNTIME is inlined at build time.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installSafeConsole } = await import("./lib/safe-console");
    installSafeConsole();
  }
}

// One more line per uncaught server error, with the route's file pattern
// (like /c/r/[readingId]), never the request's URL, query, headers, or
// cookies. The digest ties it to Next's own line and to the id the
// browser shows.
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { errorLogFields } = await import("./lib/safe-console");
  console.error("onRequestError", {
    ...errorLogFields(error),
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
    renderSource: context.renderSource,
  });
};
