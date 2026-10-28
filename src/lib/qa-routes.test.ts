import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isQaPath, QA_ROUTES_ENV, qaRoutesEnabled } from "./qa-routes";

const QA_FILES = [
  "src/app/qa/answer-timeout/page.tsx",
  "src/app/qa/answer-timeout/landed/page.tsx",
  "src/app/qa/answer-timeout/actions.ts",
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
    for (const path of ["/qa", "/qa/answer-timeout", "/qa/answer-timeout/landed"]) assert.equal(isQaPath(path), true, path);
    for (const path of ["/", "/qa-x", "/quiz", "/c/qa/x", "/learn/qa", "/welcome"]) assert.equal(isQaPath(path), false, path);
    assert.match(readFileSync("src/proxy.ts", "utf8"), /if \(qaRoutesEnabled\(\) && isQaPath\(req\.nextUrl\.pathname\)\) return NextResponse\.next\(\);/);
  });

  it("only the QA page passes a client timeout to the answer form", () => {
    for (const page of ["src/app/c/r/[readingId]/page.tsx", "src/app/learn/r/[readingId]/page.tsx"]) {
      assert.doesNotMatch(readFileSync(page, "utf8"), /checkTimeoutMs/, page);
    }
  });
});
