// Checks the answer form's client timeout in a real browser: the real
// AnswerForm, a production build, and headless Chrome. A unit test can't
// see this: in round 1 of PR 20 the 90s give-up resolved on time in the
// fake-timer tests, but React held it back until the server action
// settled (see submitCheck in src/components/answer-form-state.ts).
//
//   pnpm browser:check-answer-timeout [--no-build]
//
// It builds the app (skip with --no-build to reuse .next), starts it on a
// free port with UNPACK_QA_ROUTES=1 so the test-only /qa/answer-timeout
// route exists (src/lib/qa-routes.ts), and drives /usr/bin/google-chrome
// (or CHROME_PATH) over the Chrome DevTools Protocol with Node's own
// WebSocket and fetch: no browser library. The env is dummy values only,
// like the CI build: no database, no model, no real Clerk keys.
//
// Cases:
//   slow      the action takes 10s, the form waits 2s: the no-reply message
//             shows within 2 to 4s while the request is still pending, the
//             button works again, the answers stay; and the late result
//             (which re-renders the page) doesn't replace the message.
//   fast      the action takes 200ms: its result shows, and its
//             revalidatePath re-renders the page with no reload.
//   redirect  the action redirects: the browser lands on the new page.
//   gate      without UNPACK_QA_ROUTES the route is a 404.
// Prints PASS/FAIL lines and exits non-zero on any failure. Chrome and the
// servers are always stopped.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_NO_REPLY_MESSAGE } from "@/components/answer-form-state";

const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const SLOW_MS = 10_000;
const LIMIT_MS = 2_000;

// Dummy values, as in the CI build. The Clerk key is Clerk's documented
// example (example.clerk.accounts.dev), not a real instance.
const DUMMY_ENV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
  CLERK_SECRET_KEY: "sk_test_dummy",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  DATABASE_URL: "postgresql://user:password@localhost:5432/unpack",
  AI_GATEWAY_API_KEY: "dummy",
  NEXT_TELEMETRY_DISABLED: "1",
};

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const children: ChildProcess[] = [];
function start(command: string, args: string[], env: Record<string, string>, log: string[]): ChildProcess {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const keep = (chunk: Buffer) => {
    log.push(chunk.toString());
    if (log.length > 200) log.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    try {
      // The whole group: pnpm and next start, or Chrome and its helpers.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function run(command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

async function startServer(port: number, qa: boolean, log: string[]) {
  start("pnpm", ["exec", "next", "start", "-p", String(port)], {
    ...DUMMY_ENV,
    ...(qa ? { UNPACK_QA_ROUTES: "1" } : {}),
  }, log);
  await waitFor(`next start on ${port}`, 60_000, async () => (await fetch(`http://127.0.0.1:${port}/`)).status > 0);
}

// A minimal CDP client for one page target.
type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
};

function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 0;
    const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      if (msg.id === undefined) return;
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result ?? {});
    });
    ws.addEventListener("error", () => reject(new Error(`CDP connection to ${url} failed`)));
    ws.addEventListener("open", () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            nextId += 1;
            waiting.set(nextId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: nextId, method, params }));
          }),
        close: () => ws.close(),
      }),
    );
  });
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const out = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(`page error: ${JSON.stringify(out.exceptionDetails)}`);
  return (out.result as { value: T }).value;
}

// What the checks read off the page.
type Snapshot = {
  path: string;
  render: number;
  message: string;
  button: string;
  disabled: boolean;
  busy: string | null;
  answers: string[];
  landed: boolean;
};

const SNAPSHOT = `(() => {
  const form = document.querySelector("form");
  const button = form?.querySelector('button[type="submit"]');
  const live = form ? [...form.querySelectorAll('p[aria-live="polite"]')].at(-1) : null;
  return {
    path: location.pathname,
    render: Number(document.querySelector('[data-qa="render"]')?.textContent ?? -1),
    message: live?.textContent ?? "",
    button: button?.textContent ?? "",
    disabled: !!button?.disabled,
    busy: form?.getAttribute("aria-busy") ?? null,
    answers: form ? [...form.querySelectorAll("textarea")].map((t) => t.value) : [],
    landed: !!document.querySelector('[data-qa="landed"]'),
  };
})()`;

const snapshot = (cdp: Cdp) => evaluate<Snapshot>(cdp, SNAPSHOT);

async function open(cdp: Cdp, url: string) {
  // Each case starts with no saved drafts (the last case's answers would
  // be restored over the empty boxes, as they should be).
  await evaluate(cdp, `(() => { try { localStorage.clear(); } catch {} })()`);
  await cdp.send("Page.navigate", { url });
  // Hydrated: React has put its props on the form, so a submit runs the
  // form's handler, not a native GET.
  await waitFor("the hydrated form", 30_000, () =>
    evaluate<boolean>(cdp, `(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactProps")); })()`),
  );
}

const ANSWERS = ["The snow was deep, so they stayed in.", "It ran off because it was scared."];

async function fillAndSubmit(cdp: Cdp): Promise<number> {
  for (const [i, text] of ANSWERS.entries()) {
    await evaluate(cdp, `document.querySelectorAll("form textarea")[${i}].focus()`);
    await cdp.send("Input.insertText", { text });
  }
  const typed = (await snapshot(cdp)).answers;
  if (JSON.stringify(typed) !== JSON.stringify(ANSWERS)) throw new Error(`typing failed: ${JSON.stringify(typed)}`);
  const t0 = Date.now();
  await evaluate(cdp, `document.querySelector('form button[type="submit"]').click()`);
  return t0;
}

async function slowCase(cdp: Cdp, base: string) {
  console.log(`-- slow: action ${SLOW_MS}ms, form waits ${LIMIT_MS}ms`);
  await open(cdp, `${base}/qa/answer-timeout?sleep=${SLOW_MS}&limit=${LIMIT_MS}`);
  const before = await snapshot(cdp);
  const t0 = await fillAndSubmit(cdp);

  const pending = await waitFor("the pending button", 2_000, async () => {
    const s = await snapshot(cdp);
    return s.disabled ? s : undefined;
  });
  check(pending.button === "Checking your answers…" && pending.busy === "true", "slow: pending while the check runs", pending.button);

  const gaveUp = await waitFor("the no-reply message", SLOW_MS, async () => {
    const s = await snapshot(cdp);
    return s.message === CHECK_NO_REPLY_MESSAGE ? s : undefined;
  }).catch(() => undefined);
  const elapsed = Date.now() - t0;
  check(!!gaveUp && elapsed >= LIMIT_MS - 200 && elapsed <= 4_000, "slow: no-reply message shows at the client limit", `${elapsed}ms`);
  check(elapsed < SLOW_MS - 2_000, "slow: shown while the server action is still pending", `${elapsed}ms of ${SLOW_MS}ms`);
  if (!gaveUp) return;
  check(!gaveUp.disabled && gaveUp.button === "Check my answers" && gaveUp.busy === "false", "slow: button enabled again", gaveUp.button);
  check(JSON.stringify(gaveUp.answers) === JSON.stringify(ANSWERS), "slow: typed answers still there");
  const drafted = await evaluate<boolean>(
    cdp,
    `(() => { const all = Object.values(localStorage).join(" "); return ${JSON.stringify(ANSWERS)}.every((a) => all.includes(a)); })()`,
  );
  check(drafted, "slow: answers saved as drafts on the device");
  check(gaveUp.render === before.render, "slow: no re-render yet (the action is still running)", `render ${gaveUp.render}`);

  // The late result revalidates the page, as a counted timeout does: the
  // page re-renders, but the form's message stays.
  const late = await waitFor("the late re-render", SLOW_MS + 8_000, async () => {
    const s = await snapshot(cdp);
    return s.render > before.render ? s : undefined;
  }).catch(() => undefined);
  const lateAt = Date.now() - t0;
  check(!!late && lateAt >= SLOW_MS, "slow: the late result's revalidation re-rendered the page", `${lateAt}ms`);
  await sleep(1_000);
  const after = await snapshot(cdp);
  check(after.message === CHECK_NO_REPLY_MESSAGE, "slow: the late result did not replace the message", after.message);
  check(!after.disabled && JSON.stringify(after.answers) === JSON.stringify(ANSWERS), "slow: still enabled, answers kept after the late result");
}

async function fastCase(cdp: Cdp, base: string) {
  console.log("-- fast: action 200ms");
  await open(cdp, `${base}/qa/answer-timeout?sleep=200&limit=${LIMIT_MS}`);
  const before = await snapshot(cdp);
  const t0 = await fillAndSubmit(cdp);
  const done = await waitFor("the result", 5_000, async () => {
    const s = await snapshot(cdp);
    return s.message.startsWith("QA check finished") ? s : undefined;
  }).catch(() => undefined);
  check(!!done && done.message === "QA check finished after 200 ms, 2 answers.", "fast: the action's result shows", `${Date.now() - t0}ms`);
  if (!done) return;
  check(!done.disabled && done.button === "Check my answers", "fast: button enabled");
  const rerendered = await waitFor("the re-render", 3_000, async () => {
    const s = await snapshot(cdp);
    return s.render > before.render ? s : undefined;
  }).catch(() => undefined);
  check(!!rerendered, "fast: revalidatePath re-rendered the page with no reload");
  check(JSON.stringify(done.answers) === JSON.stringify(ANSWERS), "fast: answers kept");
}

async function redirectCase(cdp: Cdp, base: string) {
  console.log("-- redirect: action 200ms, then redirect");
  await open(cdp, `${base}/qa/answer-timeout?sleep=200&limit=${LIMIT_MS}&redirect=1`);
  await fillAndSubmit(cdp);
  const landed = await waitFor("the redirect", 10_000, async () => {
    const s = await snapshot(cdp);
    return s.landed ? s : undefined;
  }).catch(() => undefined);
  check(!!landed && landed.path === "/qa/answer-timeout/landed", "redirect: navigated to the redirect target", landed?.path ?? "no navigation");
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME} (set CHROME_PATH)`);
  if (!process.argv.includes("--no-build")) {
    console.log("-- next build");
    const code = await run("pnpm", ["exec", "next", "build"], DUMMY_ENV);
    if (code !== 0) throw new Error(`next build exited ${code}`);
  }

  const serverLog: string[] = [];
  const port = await freePort();
  await startServer(port, true, serverLog);
  const base = `http://127.0.0.1:${port}`;
  const qaStatus = (await fetch(`${base}/qa/answer-timeout`)).status;
  if (qaStatus !== 200) throw new Error(`/qa/answer-timeout answered ${qaStatus}:\n${serverLog.join("").slice(-2000)}`);

  const profile = mkdtempSync(join(tmpdir(), "unpack-chrome-"));
  try {
    start(CHROME, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "about:blank",
    ], {}, []);
    const devtools = await waitFor("Chrome's DevTools port", 30_000, async () => {
      const lines = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
      return lines.length >= 2 ? Number(lines[0]) : undefined;
    });
    const targets = (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target in Chrome");
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await slowCase(cdp, base);
    await fastCase(cdp, base);
    await redirectCase(cdp, base);
    cdp.close();

    console.log("-- gate: no UNPACK_QA_ROUTES");
    const offPort = await freePort();
    await startServer(offPort, false, []);
    for (const path of ["/qa/answer-timeout", "/qa/answer-timeout/landed"]) {
      const status = (await fetch(`http://127.0.0.1:${offPort}${path}`)).status;
      check(status === 404, `gate: ${path} is a 404 without the env var`, String(status));
    }
  } finally {
    stopAll();
    rmSync(profile, { recursive: true, force: true });
  }
}

main()
  .catch((error: unknown) => {
    failures += 1;
    console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => {
    stopAll();
    console.log(failures === 0 ? "All browser checks passed." : `${failures} browser check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
