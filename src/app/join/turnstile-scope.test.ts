import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { botCheckSiteKey, TURNSTILE_SCRIPT_URL } from "@/lib/join-bot-check";

// Where our own Turnstile can load: only the join form's widget, only when
// the server says the check is on. Clerk's own Turnstile (its sign-up
// challenge and its "captcha heartbeat", which clerk-js runs on every page)
// is not ours and isn't covered here; see docs/v1-spec.md.

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WIDGET = `${SRC}app/join/turnstile-widget.tsx`;
const JOIN_FORM = `${SRC}app/join/join-form.tsx`;
const JOIN_PAGE = `${SRC}app/join/page.tsx`;
const BOT_CHECK = `${SRC}lib/join-bot-check.ts`;
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
// Static, side-effect and dynamic imports, and re-exports.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`.replace(/\/+/g, "/");
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// App code only: no tests.
const APP_FILES = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const read = (path: string) => readFileSync(path, "utf8");

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = SRC + specifier.slice(2);
  else if (specifier.startsWith(".")) base = fileURLToPath(new URL(specifier, `file://${from}`));
  else return null; // a package
  for (const ext of EXTENSIONS) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

// Every app file a module reaches through its imports (packages not
// followed).
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(IMPORT)) {
      const next = resolveImport(file, m[1]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe("our Turnstile loads only on /join, only when the check is on", () => {
  it("the join page picks the site key on the server, from botCheckConfig", () => {
    const page = read(JOIN_PAGE);
    assert.doesNotMatch(page, /^["']use client["']/m);
    assert.match(page, /import \{ botCheckSiteKey \} from "@\/lib\/join-bot-check";/);
    assert.match(page, /<JoinForm [^>]*botCheckSiteKey=\{botCheckSiteKey\(\)\} \/>/);
  });

  it("botCheckSiteKey is null when the check is off or has no site key", () => {
    const keys = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key-for-tests", TURNSTILE_SECRET_KEY: "secret-key-for-tests" };
    const prod = { NODE_ENV: "production" };
    assert.equal(botCheckSiteKey({ ...prod, ...keys, TURNSTILE_DISABLED: "1" }), null);
    assert.equal(botCheckSiteKey({ ...prod, TURNSTILE_DISABLED: "1" }), null);
    assert.equal(botCheckSiteKey({ ...prod, TURNSTILE_SECRET_KEY: keys.TURNSTILE_SECRET_KEY }), null);
    assert.equal(botCheckSiteKey({ NODE_ENV: "development" }), null);
    assert.equal(botCheckSiteKey({ ...prod, ...keys }), keys.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  });

  it("the join form renders the widget only with a site key (none by default)", () => {
    const form = read(JOIN_FORM);
    assert.match(form, /botCheckSiteKey = null,/);
    assert.match(form, /\{botCheckSiteKey && <TurnstileWidget siteKey=\{botCheckSiteKey\} resetKey=\{state\} \/>\}/);
    assert.equal(form.match(/<TurnstileWidget\b/g)?.length, 1);
  });

  it("the script is loaded by the widget's own render, nowhere else", () => {
    const widget = read(WIDGET);
    assert.match(widget, /<Script src=\{TURNSTILE_SCRIPT_URL\} strategy="afterInteractive"/);
    for (const file of APP_FILES) {
      const source = read(file);
      const name = file.slice(SRC.length);
      if (file !== BOT_CHECK) {
        assert.ok(!source.includes("challenges.cloudflare.com"), `${name} names Cloudflare's challenge host`);
      }
      if (file !== BOT_CHECK && file !== WIDGET) {
        assert.ok(!source.includes("TURNSTILE_SCRIPT_URL"), `${name} uses TURNSTILE_SCRIPT_URL`);
        // No global <Script>, preload or preconnect that could fetch it.
        assert.ok(!/from "next\/script"/.test(source), `${name} imports next/script`);
        assert.ok(!/\b(preload|preconnect|prefetchDNS|preinit)\(/.test(source), `${name} preloads a resource`);
      }
    }
    assert.equal(TURNSTILE_SCRIPT_URL, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  });

  it("only the join form imports the widget, and only the join page imports the form", () => {
    const importers = (target: string) =>
      APP_FILES.filter((f) => [...read(f).matchAll(IMPORT)].some((m) => resolveImport(f, m[1]) === target));
    assert.deepEqual(importers(WIDGET), [JOIN_FORM]);
    assert.deepEqual(importers(JOIN_FORM), [JOIN_PAGE]);
  });

  it("no layout, no /welcome module and no route but /join reaches the widget", () => {
    const entries = APP_FILES.filter((f) =>
      /\/app\/.*\/?(page|layout|template|loading|error|not-found|global-error|default|route)\.tsx?$/.test(f),
    );
    const layouts = entries.filter((f) => /\/layout\.tsx$/.test(f));
    const welcome = APP_FILES.filter((f) => f.startsWith(`${SRC}app/welcome/`));
    assert.ok(layouts.includes(`${SRC}app/layout.tsx`));
    assert.ok(welcome.includes(`${SRC}app/welcome/page.tsx`));
    for (const entry of new Set([...entries, ...welcome])) {
      if (entry === JOIN_PAGE) continue;
      const graph = reachable(entry);
      assert.ok(!graph.has(WIDGET), `${entry.slice(SRC.length)} reaches the Turnstile widget`);
      assert.ok(!graph.has(JOIN_FORM), `${entry.slice(SRC.length)} reaches the join form`);
    }
    assert.ok(reachable(JOIN_PAGE).has(WIDGET));
  });

  it("the app sets no Content-Security-Policy (docs/v1-spec.md says so)", () => {
    // If one is ever added, follow docs/v1-spec.md and update this test.
    assert.doesNotMatch(read(`${ROOT}next.config.ts`), /\bheaders\s*[(:]/);
    assert.doesNotMatch(read(`${SRC}proxy.ts`), /contentSecurityPolicy/);
    assert.ok(!existsSync(`${ROOT}vercel.json`));
    for (const file of APP_FILES) {
      assert.ok(!/content-security-policy|\bhttpEquiv\b/i.test(read(file)), file.slice(SRC.length));
    }
  });
});
