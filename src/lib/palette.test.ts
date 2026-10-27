import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AA_LARGE, AA_TEXT, contrastRatio } from "./contrast";

const srcDir = fileURLToPath(new URL("../", import.meta.url));
const css = readFileSync(join(srcDir, "app/globals.css"), "utf8");

// The theme's color tokens: "primary-600" -> "#5847e0".
const tokens = new Map<string, string>(
  [...css.matchAll(/--color-([a-z]+(?:-\d+)?):\s*(#[0-9a-f]{3,6});/gi)].map((m) => [m[1], m[2]]),
);

function hex(token: string): string {
  const value = tokens.get(token);
  assert.ok(value, `no --color-${token} token in globals.css`);
  return value;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const source = sourceFiles(srcDir)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

// Text, icon and boundary colors on the backgrounds they sit on in the
// app. Text is 4.5:1 (AA body text); `large` is 3:1, for text 24px and up
// and for UI parts: focus rings, field borders, icons next to words.
const TEXT_PAIRS: [fg: string, bg: string][] = [
  // Neutral text on white, the page tint and the grey panels.
  ...["ink-950", "ink-900", "ink-800", "ink-700", "ink-600", "ink-500"].flatMap(
    (fg): [string, string][] => ["white", "ink-50", "ink-100", "primary-50"].map((bg) => [fg, bg]),
  ),
  ["ink-950", "sunny-200"],
  ["ink-950", "lagoon-100"],
  // Primary links, labels and tinted panels.
  ["primary-700", "white"],
  ["primary-700", "ink-50"],
  ["primary-700", "primary-50"],
  ["primary-700", "primary-100"],
  ["primary-800", "primary-50"],
  ["primary-800", "primary-100"],
  ["primary-900", "primary-50"],
  ["primary-950", "primary-50"],
  ["white", "primary-600"],
  ["white", "primary-700"],
  // Success: passed, done.
  ["success-800", "success-50"],
  ["success-800", "white"],
  ["success-950", "success-50"],
  ["white", "success-600"],
  // Warning: limits, near-full, "not yet".
  ["warning-800", "warning-50"],
  ["warning-800", "white"],
  ["warning-900", "warning-50"],
  ["warning-900", "white"],
  ["warning-950", "warning-50"],
  ["warning-950", "warning-100"],
  // Danger: errors and destructive actions only.
  ["danger-700", "white"],
  ["danger-700", "danger-50"],
  ["danger-800", "danger-50"],
  ["danger-950", "danger-50"],
  ["white", "danger-600"],
  ["white", "danger-700"],
];

const LARGE_PAIRS: [fg: string, bg: string][] = [
  // Focus rings.
  ["primary-600", "white"],
  ["primary-600", "ink-50"],
  ["primary-600", "primary-50"],
  ["danger-600", "white"],
  // Field and button borders.
  ["ink-400", "white"],
  ["ink-400", "ink-50"],
  ["danger-600", "white"],
  ["warning-600", "white"],
  // Icons beside words, on their panels.
  ["warning-700", "warning-50"],
  ["primary-700", "primary-50"],
  ["success-600", "success-50"],
  // The turned-off join code (6xl) and decorative separators.
  ["ink-400", "white"],
];

describe("palette", () => {
  it("computes WCAG contrast ratios", () => {
    assert.equal(contrastRatio("#000000", "#ffffff"), 21);
    assert.equal(contrastRatio("#fff", "#ffffff"), 1);
    assert.equal(contrastRatio("#ffffff", "#000"), contrastRatio("#000", "#ffffff"));
    assert.equal(contrastRatio("#777777", "#ffffff").toFixed(2), "4.48");
    assert.throws(() => contrastRatio("blue", "#ffffff"));
  });

  it("text pairs meet AA (4.5:1)", () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrastRatio(hex(fg), hex(bg));
      assert.ok(ratio >= AA_TEXT, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  });

  it("focus rings, borders, icons and large text meet 3:1", () => {
    for (const [fg, bg] of LARGE_PAIRS) {
      const ratio = contrastRatio(hex(fg), hex(bg));
      assert.ok(ratio >= AA_LARGE, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  });

  // Any text color class in src is readable on white; only ink-400 is
  // kept for large or decorative text (3:1, above).
  it("every text color used in src is at least 4.5:1 on white", () => {
    const used = new Set([...source.matchAll(/\btext-([a-z]+-\d+)\b/g)].map((m) => m[1]));
    assert.ok(used.size > 5);
    for (const token of used) {
      const min = token === "ink-400" ? AA_LARGE : AA_TEXT;
      const ratio = contrastRatio(hex(token), hex("white"));
      assert.ok(ratio >= min, `text-${token} on white is ${ratio.toFixed(2)}:1`);
    }
  });

  it("the button lips are theme tokens", () => {
    assert.match(css, new RegExp(`--shadow-lip-primary: 0 4px 0 0 ${hex("primary-800")};`));
    assert.match(css, new RegExp(`--shadow-lip-danger: 0 4px 0 0 ${hex("danger-800")};`));
    assert.match(css, new RegExp(`--shadow-lip-ink: 0 4px 0 0 ${hex("ink-400")};`));
  });

  // Tailwind's own palette is switched off in globals.css, so a leftover
  // default color class would quietly render with no color.
  it("src uses only theme colors", () => {
    const defaults =
      /\b(?:bg|text|border|ring|outline|fill|stroke|divide|decoration|from|via|to|shadow)(?:-[xytrbl])?-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    assert.deepEqual(source.match(defaults) ?? [], []);
    const unknown = [
      ...source.matchAll(/\b(?:bg|text|border|ring|outline|fill|stroke|divide)(?:-[xytrbl])?-([a-z]+-\d{2,3})\b/g),
    ]
      .map((m) => m[1])
      .filter((token) => !tokens.has(token));
    assert.deepEqual([...new Set(unknown)], []);
  });
});
