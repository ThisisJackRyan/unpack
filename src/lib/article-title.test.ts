import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { openGraphValue, pickArticleTitle, stripSiteSuffix } from "./article-title";

describe("stripSiteSuffix", () => {
  it("strips og:site_name after each separator", () => {
    for (const separator of [" - ", " – ", " | ", " · ", " :: "]) {
      assert.equal(stripSiteSuffix(`Why Glaciers Move${separator}The Field Notes`, "The Field Notes"), "Why Glaciers Move", separator);
    }
  });

  it("strips only the last suffix, once", () => {
    assert.equal(stripSiteSuffix("Notes | Glaciers | Notes", "Notes"), "Notes | Glaciers");
  });

  it("leaves a site name in the middle", () => {
    assert.equal(stripSiteSuffix("The Field Notes - Why Glaciers Move", "The Field Notes"), "The Field Notes - Why Glaciers Move");
  });

  it("needs the whole text after the separator to be the site name", () => {
    assert.equal(stripSiteSuffix("Why Glaciers Move | More Field Notes", "Field Notes"), "Why Glaciers Move | More Field Notes");
    assert.equal(stripSiteSuffix("Why Glaciers Move | the field notes", "The Field Notes"), "Why Glaciers Move | the field notes");
  });

  it("compares the site name after whitespace cleanup", () => {
    assert.equal(stripSiteSuffix("Why Glaciers Move | The Field Notes", "  The\n Field   Notes "), "Why Glaciers Move");
  });

  it("strips Wikipedia's suffixes", () => {
    assert.equal(stripSiteSuffix("Honey bee - Wikipedia"), "Honey bee");
    assert.equal(stripSiteSuffix("Honey bee - Wikipedia, the free encyclopedia"), "Honey bee");
    assert.equal(stripSiteSuffix("Honey bee - Simple English Wikipedia, the free encyclopedia"), "Honey bee");
    assert.equal(stripSiteSuffix("Spider-Man - Film - Simple English Wikipedia, the free encyclopedia"), "Spider-Man - Film");
  });

  it("leaves other Wikipedia mentions", () => {
    assert.equal(stripSiteSuffix("Honey bee | Wikipedia"), "Honey bee | Wikipedia");
    assert.equal(stripSiteSuffix("Honey bee - Simple English Wikipedia"), "Honey bee - Simple English Wikipedia");
    assert.equal(stripSiteSuffix("Why I love Wikipedia"), "Why I love Wikipedia");
  });

  it("never splits on a dash by itself", () => {
    assert.equal(stripSiteSuffix("Spider-Man - A Hero’s Journey"), "Spider-Man - A Hero’s Journey");
    assert.equal(stripSiteSuffix("COVID-19 - what we know", "Health News"), "COVID-19 - what we know");
  });

  it("never strips down to nothing", () => {
    assert.equal(stripSiteSuffix("The Field Notes", "The Field Notes"), "The Field Notes");
    assert.equal(stripSiteSuffix("- | The Field Notes", "The Field Notes"), "- | The Field Notes");
    assert.equal(stripSiteSuffix(" - Wikipedia".trim()), "- Wikipedia");
  });
});

describe("pickArticleTitle", () => {
  it("prefers og:title", () => {
    assert.equal(
      pickArticleTitle({ ogTitle: "How Octopuses Change Color", documentTitle: "Octopus color | Ocean Notes", readabilityTitle: "Octopus color" }),
      "How Octopuses Change Color",
    );
  });

  it("uses the page's <title> as written, not Readability's split one", () => {
    assert.equal(
      pickArticleTitle({ ogTitle: "  ", documentTitle: "COVID-19 - what we know", readabilityTitle: "what we know" }),
      "COVID-19 - what we know",
    );
  });

  it("uses Readability's title only when there is no <title>", () => {
    assert.equal(pickArticleTitle({ documentTitle: "", readabilityTitle: "From the headline" }), "From the headline");
    assert.equal(pickArticleTitle({}), "");
  });

  it("strips the site name from whichever title it picked, and normalizes it", () => {
    assert.equal(pickArticleTitle({ documentTitle: " Why\tGlaciers Move –  The Field Notes ", siteName: "The Field Notes" }), "Why Glaciers Move");
    assert.equal(pickArticleTitle({ ogTitle: "Honey bee - Wikipedia" }), "Honey bee");
  });
});

describe("openGraphValue", () => {
  it("reads og: tags by property or name, first non-empty", () => {
    const { document } = parseHTML(`<html><head>
      <meta property="og:title" content=" ">
      <meta name="og:title" content="By name">
      <meta property="og:site_name" content="Site">
    </head><body></body></html>`);
    assert.equal(openGraphValue(document, "title"), "By name");
    assert.equal(openGraphValue(document, "site_name"), "Site");
  });

  it("is empty when there are none", () => {
    const { document } = parseHTML("<html><head><title>T</title></head><body></body></html>");
    assert.equal(openGraphValue(document, "title"), "");
  });
});
