import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  exceedsElementLimits,
  extractArticle,
  htmlToText,
  MAX_DEPTH,
  MAX_ELEMENTS,
  MAX_START_TAGS,
} from "./fetch-article";
import { FetchArticleError } from "./fetch-errors";
import { BODY_TEXT_MAX_LENGTH } from "./validate-reading";

const fixture = readFileSync(
  new URL("./__fixtures__/article.html", import.meta.url),
  "utf8",
);
const PAGE = new URL("https://news.example.com/animals/octopus");

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof FetchArticleError ? error.kind : "other";
  }
  return undefined;
}

describe("extractArticle", () => {
  const article = extractArticle(fixture, PAGE);

  it("finds the title", () => {
    assert.equal(article.title, "How Octopuses Change Color");
  });

  it("keeps the main paragraphs, separated by blank lines", () => {
    assert.ok(
      article.text.startsWith(
        "An octopus can change the color of its skin in less than a second.",
      ),
    );
    assert.match(
      article.text,
      /how it works\.\n\nThe secret is in tiny sacs of color called chromatophores\./,
    );
    assert.match(article.text, /\n\nWhy do they do it\?\n\n/);
    assert.match(article.text, /without seeing color the way we do\.$/);
  });

  it("turns <br> into a line break and list items into dashes", () => {
    assert.match(article.text, /texture of their skin\.\nThey raise small bumps/);
    assert.match(
      article.text,
      /\n\n- Chromatophores hold the pigment\.\n- Iridophores reflect light\.\n- Leucophores scatter white light\.\n\n/,
    );
  });

  it("leaves out nav, ads, sidebar, comments, footer, and scripts", () => {
    for (const junk of [
      "NAV_NEWS_LINK",
      "NAV_ANIMALS_LINK",
      "Subscribe today",
      "ADVERTISEMENT_BANNER",
      "SIDEBAR_POPULAR",
      "SIDEBAR_AD",
      "COMMENT_TEXT",
      "FOOTER_TEXT",
      "TRACKING_SCRIPT_TEXT",
      "SCRIPT_REPLACED_BODY",
      "dataLayer",
      "font-family",
    ]) {
      assert.equal(article.text.includes(junk), false, junk);
    }
  });

  it("has no runs of 3 or more newlines or stray spaces at line ends", () => {
    assert.doesNotMatch(article.text, /\n{3,}/);
    assert.doesNotMatch(article.text, /[ \t]\n/);
  });

  it("fails when the page has too little text", () => {
    const html = "<html><head><title>Hi</title></head><body><p>Too short.</p></body></html>";
    assert.equal(kindOf(() => extractArticle(html, PAGE)), "extract_failed");
    assert.equal(kindOf(() => extractArticle("", PAGE)), "extract_failed");
    assert.equal(kindOf(() => extractArticle("not html at all", PAGE)), "extract_failed");
  });

  it("fails with too_long instead of cutting a long article", () => {
    const para = `<p>${"A long sentence about the sea, with commas, and more words. ".repeat(20)}</p>`;
    const html = `<html><head><title>Long</title></head><body><article>${para.repeat(
      Math.ceil(BODY_TEXT_MAX_LENGTH / 1000) + 5,
    )}</article></body></html>`;
    assert.equal(kindOf(() => extractArticle(html, PAGE)), "too_long");
  });
});

describe("extractArticle: size limits", () => {
  const story = `<p>${"An octopus has three hearts and blue blood, and it can taste with its arms. ".repeat(5)}</p>`;
  const page = (body: string) =>
    `<html><head><title>Deep</title></head><body>${body}</body></html>`;
  const nested = (depth: number) =>
    page(`${"<div>".repeat(depth)}${story}${"</div>".repeat(depth)}`);

  // Fails with the kind, never a RangeError or other raw error.
  function failsWith(html: string, kind: string) {
    let caught: unknown;
    try {
      extractArticle(html, PAGE);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof FetchArticleError, String(caught));
    assert.equal(caught.kind, kind);
  }

  it("reads an article nested a normal depth", () => {
    assert.match(extractArticle(nested(50), PAGE).text, /^An octopus has three hearts/);
  });

  it("fails with extract_failed on 20,000 nested divs", () => {
    failsWith(nested(20_000), "extract_failed");
  });

  it("fails with extract_failed past MAX_DEPTH", () => {
    failsWith(nested(MAX_DEPTH + 1), "extract_failed");
  });

  it("fails with extract_failed past MAX_ELEMENTS", () => {
    failsWith(page(`<article>${story}${"<i></i>".repeat(MAX_ELEMENTS)}</article>`), "extract_failed");
  });

  it("refuses a page past MAX_START_TAGS before parsing it", () => {
    const started = Date.now();
    failsWith(nested(200_000), "extract_failed");
    failsWith(page("<br>".repeat(MAX_START_TAGS + 1)), "extract_failed");
    // Parsing 200,000 nested divs takes tens of seconds.
    assert.ok(Date.now() - started < 2000);
  });

  it("counts elements and depth without recursion", () => {
    const { document } = parseHTML(page(`<div><p>a</p><p>b<i>c</i></p></div><p>d</p>`));
    assert.equal(exceedsElementLimits(document.documentElement), false);
    assert.equal(exceedsElementLimits(null), false);
    const deep = parseHTML(nested(MAX_DEPTH + 10)).document;
    assert.equal(exceedsElementLimits(deep.documentElement), true);
  });
});

describe("htmlToText", () => {
  it("handles a tree far deeper than the call stack allows", () => {
    type Node = { nodeType: number; nodeValue: string | null; localName?: string; childNodes: Node[] };
    const leaf: Node = { nodeType: 3, nodeValue: "deep text", childNodes: [] };
    let root: Node = leaf;
    for (let i = 0; i < 200_000; i++) {
      root = { nodeType: 1, nodeValue: null, localName: "span", childNodes: [root] };
    }
    assert.equal(htmlToText(root), "deep text");
  });


  it("collapses whitespace but keeps <pre> as written", () => {
    const { document } = parseHTML(
      "<html><body><div id='r'><p>a   b\n c</p><pre>x\n  y</pre><p>d<br>e</p></div></body></html>",
    );
    const root = document.getElementById("r");
    assert.equal(htmlToText(root as never), "a b c\n\nx\n  y\n\nd\ne");
  });
});
