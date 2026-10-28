// Checks that a production server never prints an uncaught server error in
// full. In round 1 of PR 25 the reviewer ran `next start` with the database
// unreachable and opened /join with a student cookie: Next printed the
// DrizzleQueryError with its SQL, the session hash in params, and the Neon
// cause. src/instrumentation.ts now sends every console line, Next's own
// included, through safeErrorFields (src/lib/safe-console.ts).
//
//   pnpm check:uncaught-error-logs [--no-build]
//
// It builds the app (skip with --no-build to reuse .next) with the dummy
// env of the CI build, then starts `next start` twice on free ports:
//   stub         every Neon query gets a Neon-style 400 reply whose message,
//                detail, hint, and where hold fake markers and a fake Clerk
//                id (a preloaded module answers the driver's fetch, so no
//                database or network is needed).
//   unreachable  the CI build's DATABASE_URL (localhost), where nothing
//                answers: the driver posts to https://localhost/sql and the
//                connection is refused, as in the reviewer's repro.
// In each it opens /join, /c, and /c/r/<id> (generateMetadata) with a fake
// student session cookie, and calls sendChallengeAction (a server action
// whose session lookup is outside its try; its id is read from the build's
// server-reference-manifest.json), then reads everything the server
// printed. It
// fails if the output holds "Failed query", "params:", "detail:", "hint:",
// "where:", the cookie, its SHA-256 hash, a stub marker, or the fake Clerk
// id; and also if the safe fields are missing (DrizzleQueryError and a
// digest), which would mean the error was never logged at all. Only marker
// names are printed, never the values. The servers are always stopped.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hashSessionToken, STUDENT_SESSION_COOKIE } from "@/lib/student-session-token";

// Dummy values, as in the CI build. The Clerk key is Clerk's documented
// example instance, not a real one.
const DUMMY_ENV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
  CLERK_SECRET_KEY: "sk_test_dummy",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  DATABASE_URL: "postgresql://user:password@localhost:5432/unpack",
  AI_GATEWAY_API_KEY: "dummy",
  NEXT_TELEMETRY_DISABLED: "1",
};

const marker = (label: string) => `FAKE_${label}_${randomBytes(6).toString("hex").toUpperCase()}`;
const TOKEN = randomBytes(32).toString("base64url");
const MARKERS = {
  message: marker("MESSAGE"),
  detail: marker("DETAIL"),
  hint: marker("HINT"),
  where: marker("WHERE"),
  clerkId: `user_2${marker("CLERK")}`,
};

// What must never be printed, by name (the names are printed, not the
// values).
const FORBIDDEN: Record<string, string> = {
  "Failed query": "Failed query",
  "params:": "params:",
  "detail:": "detail:",
  "hint:": "hint:",
  "where:": "where:",
  "the session cookie": TOKEN,
  "the session cookie's SHA-256 hash": hashSessionToken(TOKEN),
  "the stub's message marker": MARKERS.message,
  "the stub's detail marker": MARKERS.detail,
  "the stub's hint marker": MARKERS.hint,
  "the stub's where marker": MARKERS.where,
  "the fake Clerk id": MARKERS.clerkId,
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
  const keep = (chunk: Buffer) => log.push(chunk.toString());
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  children.push(child);
  return child;
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    // The whole group: pnpm and next start.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function stopAll() {
  for (const child of children) stop(child);
}
process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

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

// Preloaded into the server (NODE_OPTIONS=--import): answers every Neon
// HTTP query (the driver sends a Neon-Connection-String header) with a
// Postgres error the way Neon's endpoint does, echoing values in the
// message and filling detail, hint, and where.
function writeNeonStub(dir: string): string {
  const reply = {
    message: `invalid input for "${MARKERS.clerkId}": ${MARKERS.message}`,
    code: "57P01",
    severity: "FATAL",
    detail: `Key (clerk_user_id)=(${MARKERS.clerkId}) ${MARKERS.detail}`,
    hint: MARKERS.hint,
    where: MARKERS.where,
  };
  const path = join(dir, "neon-stub.mjs");
  writeFileSync(
    path,
    `const reply = ${JSON.stringify(JSON.stringify(reply))};
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has("Neon-Connection-String")) {
    return new Response(reply, { status: 400, headers: { "content-type": "application/json" } });
  }
  return realFetch.call(this, input, init);
};
`,
  );
  return path;
}

// expect: what the logged cause chain shows when the mode worked (the
// stub's SQLSTATE, or the refused connection).
// The built id of a server action, from .next.
function actionId(file: string, exportedName: string): string {
  const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
    node: Record<string, { filename?: string; exportedName?: string }>;
  };
  const found = Object.entries(manifest.node).find(([, entry]) => entry.filename === file && entry.exportedName === exportedName);
  if (!found) throw new Error(`no server action ${exportedName} in ${file} in the build`);
  return found[0];
}

type Mode = { name: string; env: Record<string, string>; expect: RegExp };

async function checkMode(mode: Mode) {
  console.log(`-- ${mode.name}`);
  const port = await freePort();
  const log: string[] = [];
  const child = start("pnpm", ["exec", "next", "start", "-p", String(port)], { ...DUMMY_ENV, ...mode.env }, log);
  try {
    await waitFor(`next start on ${port}`, 60_000, async () => (await fetch(`http://127.0.0.1:${port}/`)).status > 0);
    const readingId = randomUUID();
    const digests: string[] = [];
    for (const path of ["/join", "/c", `/c/r/${readingId}`]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { cookie: `${STUDENT_SESSION_COOKIE}=${TOKEN}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      // A thrown page is a 500. A failing generateMetadata on a streamed
      // page can arrive after the 200 status line, as an error in the RSC
      // payload: either way the page carries the error's digest.
      const digest = /\\?"digest\\?":\\?"([A-Za-z0-9@_-]+)\\?"/.exec(body)?.[1];
      check(
        response.status === 500 || (response.status === 200 && !!digest),
        `${mode.name}: ${path} failed with an uncaught server error`,
        `${response.status}${digest ? ", with a digest" : ""}`,
      );
      if (digest) digests.push(digest);
    }
    // The action as the browser's form would call it: React's encoded
    // reply (readingId, the previous state, the FormData).
    const body = new FormData();
    body.append("0", JSON.stringify([readingId, {}, "$K1"]));
    body.append("1_note", "a note");
    const action = await fetch(`http://127.0.0.1:${port}/c/r/${readingId}`, {
      method: "POST",
      headers: {
        "next-action": actionId("src/app/c/r/[readingId]/actions.ts", "sendChallengeAction"),
        origin: `http://127.0.0.1:${port}`,
        accept: "text/x-component",
        cookie: `${STUDENT_SESSION_COOKIE}=${TOKEN}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const actionDigest = /"digest":"([A-Za-z0-9@_-]+)"/.exec(await action.text())?.[1];
    check(action.status === 500 && !!actionDigest, `${mode.name}: sendChallengeAction failed with an uncaught server error`, String(action.status));
    if (actionDigest) digests.push(actionDigest);
    // onRequestError and the stream's last writes.
    await sleep(1_500);
    const output = log.join("");

    const leaked = Object.entries(FORBIDDEN).filter(([, value]) => output.includes(value));
    check(leaked.length === 0, `${mode.name}: nothing unsafe printed`, leaked.map(([name]) => name).join(", "));
    check(!output.includes(readingId), `${mode.name}: no request URL printed`);
    check(/DrizzleQueryError/.test(output), `${mode.name}: the error was logged by name (DrizzleQueryError)`);
    check(/NeonDbError/.test(output), `${mode.name}: its cause was logged by name (NeonDbError)`);
    check(mode.expect.test(output), `${mode.name}: the cause chain shows ${mode.expect.source}`);
    check(/digest: '[A-Za-z0-9@_-]+'/.test(output), `${mode.name}: a digest was logged`);
    check(
      digests.length > 0 && digests.every((d) => output.includes(`'${d}'`)),
      `${mode.name}: the digests the browser got are in the log`,
      `${digests.length} digest(s) in the pages`,
    );
    check(/routePath: '\/c\/r\/\[readingId\]'/.test(output), `${mode.name}: onRequestError logged the route pattern`);
    check(/routeType: 'action'/.test(output), `${mode.name}: onRequestError logged the action's error`);
    if (failures > 0) {
      // The server's output with every forbidden value replaced by its name.
      let redacted = output;
      for (const [name, value] of Object.entries(FORBIDDEN)) redacted = redacted.split(value).join(`<${name}>`);
      redacted = redacted.split(readingId).join("<reading id>");
      console.log(`--- server output (${mode.name}), forbidden values replaced by their names ---`);
      console.log(redacted.slice(-6_000));
      console.log("--- end of server output ---");
    }
  } finally {
    stop(child);
  }
}

async function main() {
  if (!process.argv.includes("--no-build")) {
    console.log("-- next build");
    const code = await run("pnpm", ["exec", "next", "build"], DUMMY_ENV);
    if (code !== 0) throw new Error(`next build exited ${code}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "unpack-error-logs-"));
  try {
    const stub = writeNeonStub(dir);
    await checkMode({
      name: "stub",
      env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(stub).href}`.trim() },
      expect: /code: '57P01'/,
    });
    await checkMode({ name: "unreachable", env: {}, expect: /ECONNREFUSED/ });
  } finally {
    stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .catch((error: unknown) => {
    failures += 1;
    console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => {
    stopAll();
    console.log(failures === 0 ? "All uncaught error log checks passed." : `${failures} uncaught error log check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
