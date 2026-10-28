// Checks the new reading form's failure handling in a real browser: the
// real ReadingForm in solo mode (as /learn/new renders it), a production
// build, and headless Chrome. The /learn/new bug: a rejected create action
// call (a throw before the write, Clerk's 401, a 504, a dropped
// connection) landed on the error boundary with the pasted text gone.
//
//   pnpm browser:check-create-guard [--no-build]
//
// It builds the app (skip with --no-build to reuse .next), starts it with
// UNPACK_QA_ROUTES=1 so the test-only /qa/create-guard route exists
// (src/lib/qa-routes.ts), and drives Chrome over the DevTools Protocol
// (scripts/lib/browser-check.ts). The route's action is the real
// createSelfReadingWith inside the real guardCreate, over fakes.
//
// Every case types a title and a pasted text, picks a level and a count,
// then clicks Start reading. Each failure must leave the title, the text,
// the level, the count and the "Paste text" choice in the fields, show an
// in-form error with role=alert (the page, not an error screen), and give
// the button back:
//   deadline  the account lookup outlasts the pre-write deadline (1s):
//             SAVE_READING_FAILED_MESSAGE at the deadline.
//   throw     the account lookup throws: SAVE_READING_FAILED_MESSAGE.
//   network   the POST fails in the browser (Fetch.failRequest: TimedOut,
//             InternetDisconnected, ConnectionReset), and answers 504 or
//             401 (as Clerk's middleware answers a lapsed session):
//             CREATE_NO_REPLY_MESSAGE, and the server never saw it. Then,
//             with the network back, the same click creates (the kept
//             values are valid as they are) and the redirect lands.
//   ok        a create that works redirects through the form's fallback.
//   gate      without UNPACK_QA_ROUTES the routes are a 404.
// Prints PASS/FAIL lines and exits non-zero on any failure.
import { existsSync } from "node:fs";
import { CREATE_NO_REPLY_MESSAGE } from "@/lib/pending-copy";
import { SAVE_READING_FAILED_MESSAGE } from "@/lib/reading-source";
import {
  buildUnlessSkipped,
  check,
  CHROME,
  evaluate,
  freePort,
  launchChrome,
  runChecks,
  startServer,
  waitFor,
  type Cdp,
} from "./lib/browser-check";

const TITLE = "How bees talk";
const BODY =
  "Honey bees tell each other where the flowers are by dancing. A bee that found food walks a figure eight on the comb, " +
  "waggling in the middle. The angle of the waggle points toward the flowers, and its length says how far away they are.\n\n" +
  "Other bees follow the dancer, then fly out and find the same flowers.";
const LEVEL = "7";
const COUNT = "5";

type Snapshot = {
  path: string;
  page: boolean;
  landed: boolean;
  source: string;
  title: string | null;
  bodyText: string | null;
  gradeLevel: string | null;
  questionCount: string | null;
  alert: string;
  button: string;
  disabled: boolean;
};

const SNAPSHOT = `(() => {
  const form = document.querySelector("form");
  const button = form?.querySelector('button[type="submit"]');
  const value = (sel) => form?.querySelector(sel)?.value ?? null;
  return {
    path: location.pathname,
    page: !!document.querySelector('[data-qa="create-guard"]'),
    landed: !!document.querySelector('[data-qa="landed"]'),
    source: form?.querySelector('input[name="source"]:checked')?.value ?? "",
    title: value("#title"),
    bodyText: value("#bodyText"),
    gradeLevel: value("#gradeLevel"),
    questionCount: value("#questionCount"),
    alert: form ? [...form.querySelectorAll('[role="alert"]')].map((e) => e.textContent ?? "").join("") : "",
    button: button?.textContent ?? "",
    disabled: !!button?.disabled,
  };
})()`;

const snapshot = (cdp: Cdp) => evaluate<Snapshot>(cdp, SNAPSHOT);

async function open(cdp: Cdp, url: string) {
  await cdp.send("Page.navigate", { url });
  await waitFor("the hydrated form", 30_000, () =>
    evaluate<boolean>(cdp, `(() => { const f = document.querySelector("form"); return !!f && Object.keys(f).some((k) => k.startsWith("__reactProps")); })()`),
  );
}

// Types the way a person does: "Paste text", the title and the text through
// the keyboard, then the two selects.
async function fill(cdp: Cdp) {
  await evaluate(cdp, `document.querySelector("#source-text").click()`);
  await evaluate(cdp, `document.querySelector("#title").focus()`);
  await cdp.send("Input.insertText", { text: TITLE });
  await evaluate(cdp, `document.querySelector("#bodyText").focus()`);
  await cdp.send("Input.insertText", { text: BODY });
  await evaluate(
    cdp,
    `(() => { for (const [id, v] of [["#gradeLevel", ${JSON.stringify(LEVEL)}], ["#questionCount", ${JSON.stringify(COUNT)}]]) { const s = document.querySelector(id); s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); } })()`,
  );
  const s = await snapshot(cdp);
  if (s.title !== TITLE || s.bodyText !== BODY || s.gradeLevel !== LEVEL || s.questionCount !== COUNT || s.source !== "text") {
    throw new Error(`typing failed: ${JSON.stringify({ ...s, bodyText: s.bodyText?.length })}`);
  }
}

async function submit(cdp: Cdp): Promise<number> {
  const t0 = Date.now();
  await evaluate(cdp, `document.querySelector('form button[type="submit"]').click()`);
  return t0;
}

// The error, with everything kept and the button back.
function checkKept(label: string, s: Snapshot, message: string) {
  check(s.page && s.path === "/qa/create-guard", `${label}: still the form's page, not an error screen`, s.path);
  check(s.alert === message, `${label}: the in-form error (role=alert)`, s.alert);
  check(s.title === TITLE, `${label}: the title is still there`, String(s.title));
  check(s.bodyText === BODY, `${label}: the pasted text is still there`, `${s.bodyText?.length ?? 0} of ${BODY.length} characters`);
  check(s.gradeLevel === LEVEL && s.questionCount === COUNT, `${label}: the level and the count are still chosen`, `${s.gradeLevel}, ${s.questionCount}`);
  check(s.source === "text", `${label}: still on "Paste text"`, s.source);
  check(!s.disabled && s.button === "Start reading", `${label}: the button is usable again`, s.button);
}

const serverLog: string[] = [];
let runs = 0;
function runId(name: string): string {
  runs += 1;
  return `${name}-${runs}`;
}
const serverSaw = (run: string) => serverLog.join("").includes(`qa-create-action started run=${run}\n`);

const errorShown = (cdp: Cdp, message: string, timeoutMs: number) =>
  waitFor(`"${message}"`, timeoutMs, async () => {
    const s = await snapshot(cdp);
    return s.alert === message && !s.disabled ? s : undefined;
  }).catch(() => undefined);

async function deadlineCase(cdp: Cdp, base: string) {
  const label = "deadline";
  console.log(`-- ${label}: the account lookup takes 5s, the pre-write deadline is 1s`);
  await open(cdp, `${base}/qa/create-guard?mode=deadline&precheck=1000&run=${runId(label)}`);
  await fill(cdp);
  const t0 = await submit(cdp);
  const pending = await waitFor("the pending button", 2_000, async () => {
    const s = await snapshot(cdp);
    return s.disabled ? s : undefined;
  }).catch(() => undefined);
  check(pending?.button === "Starting…", `${label}: pending while it runs`, pending?.button ?? "never pending");
  const s = await errorShown(cdp, SAVE_READING_FAILED_MESSAGE, 6_000);
  const elapsed = Date.now() - t0;
  check(!!s && elapsed >= 800 && elapsed < 4_000, `${label}: the save-failed message at the deadline, not after the 5s lookup`, `${elapsed}ms`);
  if (s) checkKept(label, s, SAVE_READING_FAILED_MESSAGE);
}

async function throwCase(cdp: Cdp, base: string) {
  const label = "throw";
  console.log(`-- ${label}: the account lookup throws`);
  await open(cdp, `${base}/qa/create-guard?mode=throw&run=${runId(label)}`);
  await fill(cdp);
  await submit(cdp);
  const s = await errorShown(cdp, SAVE_READING_FAILED_MESSAGE, 5_000);
  check(!!s, `${label}: the save-failed message shows`);
  if (s) checkKept(label, s, SAVE_READING_FAILED_MESSAGE);
}

type Failure = { name: string; fail: (cdp: Cdp, requestId: string) => Promise<unknown> };

const FAILURES: Failure[] = [
  ...["TimedOut", "InternetDisconnected", "ConnectionReset"].map((reason) => ({
    name: reason,
    fail: (cdp: Cdp, requestId: string) => cdp.send("Fetch.failRequest", { requestId, errorReason: reason }),
  })),
  ...[
    { status: 504, text: "An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT" },
    { status: 401, text: "" },
  ].map(({ status, text }) => ({
    name: `HTTP ${status}`,
    fail: (cdp: Cdp, requestId: string) =>
      cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: status,
        responseHeaders: [{ name: "content-type", value: "text/plain" }],
        body: Buffer.from(text).toString("base64"),
      }),
  })),
];

async function networkCase(cdp: Cdp, base: string) {
  for (const failure of FAILURES) {
    const label = `network ${failure.name}`;
    console.log(`-- ${label}: the create's POST fails before the server sees it`);
    const run = runId(`network-${failure.name.replace(/\s+/g, "")}`);
    await open(cdp, `${base}/qa/create-guard?mode=ok&run=${run}`);
    cdp.on("Fetch.requestPaused", (params) => {
      const { requestId, request } = params as { requestId: string; request: { method: string } };
      void (request.method === "POST" ? failure.fail(cdp, requestId) : cdp.send("Fetch.continueRequest", { requestId }));
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/qa/create-guard*", requestStage: "Request" }] });
    try {
      await fill(cdp);
      await submit(cdp);
      const s = await errorShown(cdp, CREATE_NO_REPLY_MESSAGE, 5_000);
      check(!!s, `${label}: the no-reply message shows`, s ? "" : JSON.stringify({ ...(await snapshot(cdp)), bodyText: undefined }));
      if (s) checkKept(label, s, CREATE_NO_REPLY_MESSAGE);
      check(!serverSaw(run), `${label}: the request never reached the server`);
    } finally {
      await cdp.send("Fetch.disable");
      cdp.on("Fetch.requestPaused", null);
    }
    // The network is back: the same click, with what the form kept.
    await submit(cdp);
    const landed = await waitFor("the redirect", 10_000, async () => {
      const s = await snapshot(cdp);
      return s.landed ? s : undefined;
    }).catch(() => undefined);
    check(!!landed && landed.path === "/qa/create-guard/landed" && serverSaw(run), `${label}: then the same click creates with the kept values`, landed?.path ?? "no redirect");
  }
}

async function okCase(cdp: Cdp, base: string) {
  const label = "ok";
  console.log(`-- ${label}: the create works and redirects`);
  await open(cdp, `${base}/qa/create-guard?mode=ok&run=${runId(label)}`);
  await fill(cdp);
  await submit(cdp);
  const landed = await waitFor("the redirect", 10_000, async () => {
    const s = await snapshot(cdp);
    return s.landed ? s : undefined;
  }).catch(() => undefined);
  check(!!landed && landed.path === "/qa/create-guard/landed", `${label}: the redirect goes through the form's fallback`, landed?.path ?? "no redirect");
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME} (set CHROME_PATH)`);
  await buildUnlessSkipped();

  const port = await freePort();
  await startServer(port, true, serverLog);
  const base = `http://127.0.0.1:${port}`;
  const qaStatus = (await fetch(`${base}/qa/create-guard`)).status;
  if (qaStatus !== 200) throw new Error(`/qa/create-guard answered ${qaStatus}:\n${serverLog.join("").slice(-2000)}`);

  const { cdp, removeProfile } = await launchChrome();
  try {
    await deadlineCase(cdp, base);
    await throwCase(cdp, base);
    await networkCase(cdp, base);
    await okCase(cdp, base);
    cdp.close();

    console.log("-- gate: no UNPACK_QA_ROUTES");
    const offPort = await freePort();
    await startServer(offPort, false, []);
    for (const path of ["/qa/create-guard", "/qa/create-guard/landed"]) {
      const status = (await fetch(`http://127.0.0.1:${offPort}${path}`)).status;
      check(status === 404, `gate: ${path} is a 404 without the env var`, String(status));
    }
  } finally {
    removeProfile();
  }
}

runChecks(main);
