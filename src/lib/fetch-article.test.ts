import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { extractArticle, htmlToText } from "./fetch-article";
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

describe("htmlToText", () => {
  it("collapses whitespace but keeps <pre> as written", () => {
    const { document } = parseHTML(
      "<html><body><div id='r'><p>a   b\n c</p><pre>x\n  y</pre><p>d<br>e</p></div></body></html>",
    );
    const root = document.getElementById("r");
    assert.equal(htmlToText(root as never), "a b c\n\nx\n  y\n\nd\ne");
  });
});
