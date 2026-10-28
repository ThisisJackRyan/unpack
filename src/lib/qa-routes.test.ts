import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isQaPath, QA_ROUTES_ENV, qaRoutesEnabled } from "./qa-routes";

const QA_FILES = [
  "src/app/qa/answer-timeout/page.tsx",
  "src/app/qa/answer-timeout/landed/page.tsx",
  "src/app/qa/answer-timeout/actions.ts",
  "src/app/qa/create-guard/page.tsx",
  "src/app/qa/create-guard/landed/page.tsx",
  "src/app/qa/create-guard/actions.ts",
];

// The body of the file's exported page or action: after the first brace
// that follows the parameter list's closing parenthesis.
function exportedBody(source: string): string {
  const start = source.search(/^export (default )?(async )?function/m);
  assert.ok(start >= 0);
  return source.slice(source.indexOf("{", source.indexOf(")", start)) + 1).trim();
}

describe("QA routes", () => {
  it("are off unless UNPACK_QA_ROUTES is exactly 1", () => {
    assert.equal(QA_ROUTES_ENV, "UNPACK_QA_ROUTES");
    assert.equal(qaRoutesEnabled({}), false);
    assert.equal(qaRoutesEnabled({ UNPACK_QA_ROUTES: "" }), false);
    assert.equal(qaRoutesEnabled({ UNPACK_QA_ROUTES: "true" }), false);
    assert.equal(qaRoutesEnabled({ UNPACK_QA_ROUTES: "1" }), true);
  });

  it("every QA page and action answers 404 first thing when they're off", () => {
    for (const file of QA_FILES) {
      const source = readFileSync(file, "utf8");
      assert.match(source, /import \{[^}]*\bnotFound\b[^}]*\} from "next\/navigation";/, file);
      assert.ok(exportedBody(source).startsWith("if (!qaRoutesEnabled()) notFound();"), `${file} checks the gate first`);
    }
  });

  it("only /qa and below are QA paths (the proxy skips Clerk for them only with the env var)", () => {
    for (const path of ["/qa", "/qa/answer-timeout", "/qa/answer-timeout/landed", "/qa/create-guard", "/qa/create-guard/landed"]) assert.equal(isQaPath(path), true, path);
    for (const path of ["/", "/qa-x", "/quiz", "/c/qa/x", "/learn/qa", "/welcome"]) assert.equal(isQaPath(path), false, path);
    assert.match(readFileSync("src/proxy.ts", "utf8"), /if \(qaRoutesEnabled\(\) && isQaPath\(req\.nextUrl\.pathname\)\) return NextResponse\.next\(\);/);
  });

  it("the QA page renders the answer form through the reading pages' own components", () => {
    // AnswerForm is rendered in one place, for both pages and the QA route.
    assert.match(readFileSync("src/components/reading-answer-form.tsx", "utf8"), /<AnswerForm/);
    assert.match(readFileSync("src/app/c/r/[readingId]/page.tsx", "utf8"), /<ClassAnswerForm\b/);
    assert.match(readFileSync("src/app/learn/r/[readingId]/page.tsx", "utf8"), /<SelfAnswerForm\b/);
    for (const page of ["src/app/c/r/[readingId]/page.tsx", "src/app/learn/r/[readingId]/page.tsx", "src/app/qa/answer-timeout/page.tsx"]) {
      assert.doesNotMatch(readFileSync(page, "utf8"), /<AnswerForm\b/, page);
    }
    const qa = readFileSync("src/app/qa/answer-timeout/page.tsx", "utf8");
    assert.match(qa, /\? SelfAnswerForm : ClassAnswerForm/);
  });

  it("the QA create page renders the real reading form in solo mode, through the real guard", () => {
    const page = readFileSync("src/app/qa/create-guard/page.tsx", "utf8");
    assert.match(page, /<ReadingForm\s+mode="solo"/);
    assert.match(page, /import \{ ReadingForm \} from "@\/components\/reading-form";/);
    const action = readFileSync("src/app/qa/create-guard/actions.ts", "utf8");
    assert.match(action, /guardCreate\(/);
    assert.match(action, /createSelfReadingWith\(/);
  });

  it("only the QA page passes a client timeout to the answer form", () => {
    for (const page of ["src/app/c/r/[readingId]/page.tsx", "src/app/learn/r/[readingId]/page.tsx"]) {
      assert.doesNotMatch(readFileSync(page, "utf8"), /checkTimeoutMs/, page);
    }
  });
});
