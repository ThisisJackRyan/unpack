// Shared by the browser checks (scripts/browser-check-*.ts): a production
// build of the app on a free port, with the test-only /qa routes on
// (src/lib/qa-routes.ts), and headless Chrome driven over the Chrome
// DevTools Protocol with Node's own WebSocket and fetch: no browser
// library. The env is dummy values only, like the CI build: no database,
// no model, no real Clerk keys.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

// Dummy values, as in the CI build. The Clerk key is Clerk's documented
// example (example.clerk.accounts.dev), not a real instance.
export const DUMMY_ENV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
  CLERK_SECRET_KEY: "sk_test_dummy",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  DATABASE_URL: "postgresql://user:password@localhost:5432/unpack",
  AI_GATEWAY_API_KEY: "dummy",
  NEXT_TELEMETRY_DISABLED: "1",
};

let failures = 0;
export function failureCount(): number {
  return failures;
}
export function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort(): Promise<number> {
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
export function start(command: string, args: string[], env: Record<string, string>, log: string[]): ChildProcess {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const keep = (chunk: Buffer) => {
    log.push(chunk.toString());
    if (log.length > 2000) log.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  children.push(child);
  return child;
}

export function stopAll() {
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

export function run(command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined | false>): Promise<T> {
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

export async function startServer(port: number, qa: boolean, log: string[]) {
  start("pnpm", ["exec", "next", "start", "-p", String(port)], {
    ...DUMMY_ENV,
    ...(qa ? { UNPACK_QA_ROUTES: "1" } : {}),
  }, log);
  await waitFor(`next start on ${port}`, 60_000, async () => (await fetch(`http://127.0.0.1:${port}/`)).status > 0);
}

// A minimal CDP client for one page target.
export type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // One handler per event method (the last one set wins); null removes it.
  on: (method: string, handler: ((params: Record<string, unknown>) => void) | null) => void;
  close: () => void;
};

export function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 0;
    const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    const handlers = new Map<string, (params: Record<string, unknown>) => void>();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (msg.id === undefined) {
        if (msg.method) handlers.get(msg.method)?.(msg.params ?? {});
        return;
      }
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
        on: (method, handler) => {
          if (handler) handlers.set(method, handler);
          else handlers.delete(method);
        },
        close: () => ws.close(),
      }),
    );
  });
}

export async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const out = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(`page error: ${JSON.stringify(out.exceptionDetails)}`);
  return (out.result as { value: T }).value;
}


// Headless Chrome on a fresh profile, and a CDP client for its page.
// `close` stops nothing (stopAll does); it removes the profile.
export async function launchChrome(): Promise<{ cdp: Cdp; removeProfile: () => void }> {
  const profile = mkdtempSync(join(tmpdir(), "unpack-chrome-"));
  const removeProfile = () => rmSync(profile, { recursive: true, force: true });
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
    return { cdp, removeProfile };
  } catch (error) {
    removeProfile();
    throw error;
  }
}

// next build, unless --no-build (reuse .next).
export async function buildUnlessSkipped(): Promise<void> {
  if (process.argv.includes("--no-build")) return;
  console.log("-- next build");
  const code = await run("pnpm", ["exec", "next", "build"], DUMMY_ENV);
  if (code !== 0) throw new Error(`next build exited ${code}`);
}

// Runs a check script's main: any throw is a failure; Chrome and the
// servers are always stopped; the exit code says whether all passed.
export function runChecks(main: () => Promise<void>): void {
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
}
