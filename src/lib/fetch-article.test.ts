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

  it("is not trimmed when it fits", () => {
    assert.equal(article.trimmed, false);
  });

  it("keeps the first part of a long article, cut at a paragraph break, instead of refusing it", () => {
    const paras = Array.from(
      { length: Math.ceil(BODY_TEXT_MAX_LENGTH / 1000) + 5 },
      (_, i) => `Paragraph ${i + 1}. ${"A long sentence about the sea, with commas, and more words. ".repeat(16)}`.trim(),
    );
    const html = `<html><head><title>Long</title></head><body><article>${paras
      .map((p) => `<p>${p}</p>`)
      .join("")}</article></body></html>`;
    const long = extractArticle(html, PAGE);
    assert.equal(long.trimmed, true);
    assert.equal(long.title, "Long");
    assert.ok(long.text.length <= BODY_TEXT_MAX_LENGTH);
    assert.ok(long.text.length >= BODY_TEXT_MAX_LENGTH - 1000);
    // Whole paragraphs, from the first, in order.
    const kept = long.text.split("\n\n");
    assert.deepEqual(kept, paras.slice(0, kept.length));
  });
});

// Text that must never reach a reading, and prose that must, in order.
function assertJunkGone(text: string, junk: (string | RegExp)[]) {
  for (const item of junk) {
    if (typeof item === "string") assert.equal(text.includes(item), false, item);
    else assert.doesNotMatch(text, item);
  }
}
function assertInOrder(text: string, sentences: string[]) {
  let last = -1;
  for (const sentence of sentences) {
    const at = text.indexOf(sentence);
    assert.ok(at > last, `${sentence} (at ${at}, after ${last})`);
    last = at;
  }
}

// A saved copy of https://simple.wikipedia.org/wiki/Honey_bee (see
// __fixtures__/README.md: fetched October 28, 2026, CC BY-SA 4.0
// Wikipedia content, used only as a test fixture). Its infobox, edit links,
// citation markers, reference list, table of contents, and wiki chrome
// used to land in the reading.
describe("extractArticle: a Wikipedia article", () => {
  const wiki = extractArticle(
    readFileSync(new URL("./__fixtures__/wikipedia-honey-bee-simple.html", import.meta.url), "utf8"),
    new URL("https://simple.wikipedia.org/wiki/Honey_bee"),
  );

  it("titles it without Wikipedia's suffix", () => {
    // Its og:title is "Honey bee - Simple English Wikipedia, the free
    // encyclopedia", with no og:site_name.
    assert.equal(wiki.title, "Honey bee");
  });

  it("starts with the article's first paragraph", () => {
    assert.ok(
      wiki.text.startsWith(
        "A honey bee (or honeybee) is any bee that is a member of the genus Apis. They are all eusocial flying insects which live in colonies of various sizes. All honey bees are native to Afro-Eurasia.\n\n",
      ),
      wiki.text.slice(0, 200),
    );
    assert.equal(wiki.trimmed, false);
  });

  it("keeps the prose and its section headings, in order", () => {
    assertInOrder(wiki.text, [
      "A honey bee (or honeybee) is any bee",
      "\n\nName\n\n",
      'The scientific name "Apis" is Latin for "bee"',
      "\n\nDescription\n\n",
      "They are only a small fraction of the 20,000 known species of bee.",
      "Honey bees appear to have originated from South and Southeast Asia",
      "There are only seven species of honey bee, with a total of 44 subspecies.",
      "The first Apis bees appear in the European fossil record",
      "Only one fossil species is known, a single 14-million-year-old specimen from Nevada.",
      "Nasonov's gland produces a pheromone used to get worker bees together.",
      "\n\nMating information\n\n",
      "- Queens are produced by mating between females and drones",
      "Workers live for a few weeks to several months.",
    ]);
    assert.match(wiki.text, /Workers live for a few weeks to several months\.$/);
  });

  it("leaves out the infobox, its timeline, and the classification table", () => {
    assertJunkGone(wiki.text, [
      "Temporal range",
      "Oligocene–Recent",
      "PreꞒ",
      /\bO\s+S\s+D\s+C\s+P\s+T\b/,
      /^(Ꞓ|O|S|D|C|P|T|J|K|Pg|N)$/m,
      "Scientific classification",
      "Kingdom:",
      "Animalia",
      "Arthropoda",
      "Latreille, 1802",
      "Apis koschevnikovi",
      "Western honey bee carrying pollen back to the hive",
    ]);
  });

  it("leaves out edit links, citation markers, references, the table of contents, and wiki chrome", () => {
    assertJunkGone(wiki.text, [
      "[edit]",
      "[change",
      "change source",
      /\[\d+\]/,
      "↑",
      "Retrieved",
      "doi:",
      "Ask A Biologist",
      "\nReferences",
      "Related pages",
      "Beekeeping",
      "Contents",
      "From Simple English Wikipedia",
      "Buzzing bees on the flowering plum",
      "Categories",
      "Jump to content",
    ]);
  });

  it("has no headings left with nothing under them, and no stray spaces", () => {
    const blocks = wiki.text.split("\n\n");
    for (const [i, block] of blocks.entries()) {
      if (["Name", "Description", "Distribution", "Species", "Fossil records", "Mating information"].includes(block)) {
        assert.ok(i + 1 < blocks.length && blocks[i + 1].length > 40, block);
      }
    }
    assert.doesNotMatch(wiki.text, /^ /m);
    assert.doesNotMatch(wiki.text, /\n{3,}/);
  });

  it("is the stripped text, not the fallback", () => {
    assert.equal(wiki.stripFallback, undefined);
  });
});

// A hand-written blog post with the usual blocks around and inside it.
describe("extractArticle: a page with chrome around the article", () => {
  const blog = extractArticle(
    readFileSync(new URL("./__fixtures__/blog-with-chrome.html", import.meta.url), "utf8"),
    new URL("https://blog.example.com/glaciers"),
  );

  it("keeps its <title> as written when it has no og: tags", () => {
    assert.equal(blog.title, "Why Glaciers Move | The Field Notes");
  });

  it("keeps the article's paragraphs and heading, in order, starting with the first", () => {
    assert.ok(blog.text.startsWith("A glacier looks like it is standing still, but it is always moving downhill, just very slowly. Some glaciers"));
    assertInOrder(blog.text, [
      "A glacier looks like it is standing still",
      "Some glaciers creep only a few centimeters a day",
      "The ice moves for two main reasons.",
      "a bit like very thick honey. Second,",
      "\n\nMeasuring the speed\n\n",
      "Scientists measure a glacier's speed",
      "When a glacier moves faster than usual",
    ]);
    assert.match(blog.text, /as the climate warms\.$/);
  });

  it("leaves out the header, nav, asides, figure, table, navigation box, footnotes, and footer", () => {
    assertJunkGone(blog.text, [
      "SITE_HEADER_LOGO",
      "SEARCH_PLACEHOLDER",
      "NAV_EARTH_LINK",
      "NAV_OCEANS_LINK",
      "ASIDE_PULL_QUOTE",
      "SIDEBAR_HEADING",
      "SIDEBAR_POPULAR",
      "FIGURE_CAPTION",
      "TABLE_CAPTION",
      "TABLE_HEADER_NAME",
      "TABLE_CELL_JAKOBSHAVN",
      "40 m a day",
      "NAVBOX_TEXT",
      "SEE_ALSO_ICEBERGS",
      "See also",
      "Notes",
      "FOOTNOTE_ONE",
      "FOOTNOTE_TWO",
      "FOOTER_TEXT",
      "[1]",
      "[citation needed]",
      /slowly\.\d/,
      /honey\.\d/,
    ]);
  });

  it("is the stripped text, not the fallback", () => {
    assert.equal(blog.stripFallback, undefined);
  });
});

describe("stripNonProse and dropEmptySections", () => {
  const story = "An octopus has three hearts and blue blood, and it can taste with its arms. ".repeat(4);
  const extract = (body: string) =>
    extractArticle(`<html><head><title>T</title></head><body>${body}</body></html>`, PAGE).text;

  it("never removes the article itself, whatever its wrapper's class", () => {
    assert.match(extract(`<div class="sidebar noprint"><article><p>${story}</p></article></div>`), /^An octopus/);
    assert.match(extract(`<aside><main><p>${story}</p></main></aside>`), /^An octopus/);
  });

  it("keeps a table used for layout, with paragraphs of prose in it", () => {
    assert.match(extract(`<table><tr><td><p>${story}</p></td></tr></table>`), /^An octopus/);
  });

  it("keeps a header inside the article but drops the site header", () => {
    const text = extract(
      `<header>SITE_NAME</header><article><header><p>A dek about octopuses and what they can do.</p></header><p>${story}</p></article>`,
    );
    assert.equal(text.includes("SITE_NAME"), false);
    assert.match(text, /A dek about octopuses/);
  });

  it("keeps lists with prose in them, and footnote-free superscripts", () => {
    const text = extract(
      `<article><p>${story} The tank holds 10<sup>3</sup> liters.</p><ul><li>Hearts: <a href="/h">three</a> of them.</li><li>Blood: blue.</li></ul></article>`,
    );
    assert.match(text, /holds 103 liters\./);
    assert.match(text, /- Hearts: three of them\.\n- Blood: blue\./);
  });

  it("drops a heading only when nothing is under it before the next heading at its level or higher", () => {
    const text = extract(
      `<article><h2>Body</h2><p>${story}</p><h2>Parent</h2><h3>Child</h3><p>Child prose about arms and suckers, long enough to count.</p>` +
        `<h2>Empty parent</h2><h3>Empty child</h3><h2>References</h2><ol class="references"><li>A source.</li></ol></article>`,
    );
    assert.match(text, /\n\nParent\n\nChild\n\nChild prose/);
    assert.match(text, /long enough to count\.$/);
    for (const gone of ["Empty parent", "Empty child", "References", "A source."]) {
      assert.equal(text.includes(gone), false, gone);
    }
  });
});

// The reviewer's round 1 probes: layouts stripping used to lose (whole,
// or silently in part). Each keeps its prose, by the rules in
// stripNonProse or, failing them, by the fallback to the unstripped page.
describe("extractArticle: stripping never loses the article", () => {
  const prose = [
    "Sea otters float on their backs and use stones to crack open the shells of clams and urchins.",
    "They have the thickest fur of any animal, with up to a million hairs in a single square inch of skin.",
    "A group of otters resting together in the water is called a raft, and they often hold paws as they sleep.",
    "Without sea otters, urchins would eat the kelp forests that shelter fish, seals, and many other animals.",
  ];
  const story = prose.join(" ");
  const page = (body: string) =>
    `<html><head><title>Sea otters</title></head><body><nav><a href="/">Home</a> <a href="/animals">Animals</a></nav>${body}</body></html>`;
  const extract = (body: string) => extractArticle(page(body), PAGE);
  const assertProse = (text: string) => assertInOrder(text, prose);

  it("keeps a layout table whose cell holds the text", () => {
    const article = extract(`<table><tr><td>MENU</td><td>${story}</td></tr></table>`);
    assertProse(article.text);
    assert.equal(article.stripFallback, undefined);
  });

  it("keeps a layout table whose cell holds the text in lines broken with <br>", () => {
    const article = extract(`<table><tr><td>${prose.join("<br>")}</td></tr></table>`);
    assertProse(article.text);
    assert.match(article.text, /clams and urchins\.\nThey have/);
    assert.equal(article.stripFallback, undefined);
  });

  it("keeps a layout table whose cell holds several short paragraphs", () => {
    const article = extract(`<table><tr><td>${prose.map((p) => `<p>${p}</p>`).join("")}</td></tr></table>`);
    assertProse(article.text);
    assert.equal(article.stripFallback, undefined);
  });

  it("keeps a table with one short paragraph per row, which holds the page's paragraphs", () => {
    const article = extract(`<table>${prose.map((p) => `<tr><td><p>${p}</p></td></tr>`).join("")}</table>`);
    assertProse(article.text);
    assert.equal(article.stripFallback, undefined);
  });

  it("keeps a table with one short cell per row, and no paragraphs, through the fallback", () => {
    const article = extract(`<table>${prose.map((p) => `<tr><td>${p}</td></tr>`).join("")}</table>`);
    assertProse(article.text);
    assert.equal(article.stripFallback, "strip_failed");
  });

  it("falls back when stripping leaves less than the minimum", () => {
    const article = extract(
      `<article><p>Notes on otters, by row.</p><table>${prose.map((p) => `<tr><td>${p}</td></tr>`).join("")}</table></article>`,
    );
    assertProse(article.text);
    assert.equal(article.stripFallback, "too_short");
  });

  for (const [where, wrap] of [
    ["an <aside>", (body: string) => `<aside>${body}</aside>`],
    ["a site <header>", (body: string) => `<header>${body}</header>`],
    ["a <footer>", (body: string) => `<footer>${body}</footer>`],
    ['a <div class="sidebar">', (body: string) => `<div class="sidebar">${body}</div>`],
    ["main > div.content.sidebar", (body: string) => `<main><div class="content sidebar">${body}</div></main>`],
    ["[role=contentinfo]", (body: string) => `<div role="contentinfo">${body}</div>`],
    ["a .metadata box", (body: string) => `<div class="metadata">${body}</div>`],
  ] as const) {
    it(`keeps an article that sits inside ${where}`, () => {
      const article = extract(
        `<div class="sidebar"><p>Popular: crabs.</p></div>${wrap(prose.map((p) => `<p>${p}</p>`).join(""))}`,
      );
      assertProse(article.text);
      assert.equal(article.text.includes("Popular: crabs."), false);
      assert.equal(article.stripFallback, undefined);
    });
  }

  it("keeps a figure holding a poem or quotation, with its attribution, and drops an image figure", () => {
    const poem = "The sea is calm tonight.\nThe tide is full, the moon lies fair\nUpon the straits.";
    const article = extract(
      `<article><p>${story}</p><figure><blockquote><p>${poem.replaceAll("\n", "<br>")}</p></blockquote>` +
        `<figcaption>Matthew Arnold, Dover Beach</figcaption></figure>` +
        `<figure><img src="otter.jpg" alt=""><figcaption>IMAGE_CAPTION</figcaption></figure></article>`,
    );
    assertProse(article.text);
    assert.match(article.text, /The sea is calm tonight\.\nThe tide is full, the moon lies fair\nUpon the straits\./);
    assert.match(article.text, /Matthew Arnold, Dover Beach/);
    assert.equal(article.text.includes("IMAGE_CAPTION"), false);
    assert.equal(article.stripFallback, undefined);
  });

  // An image figure's caption is dropped with it, unless that loses most
  // of the text: then the fallback keeps it.
  const caption = prose.map((p) => p.replace("Sea otters", "Caption otters")).join(" ");
  it("keeps prose that sits in an image's caption, through the fallback", () => {
    const article = extract(
      `<article><p>${story.slice(0, 263)}</p><figure><img src="otter.jpg" alt=""><figcaption>${caption} ${caption}</figcaption></figure></article>`,
    );
    assert.match(article.text, /Caption otters float on their backs/);
    assert.equal(article.stripFallback, "much_shorter");
  });

  it("keeps an image's caption that holds most of the page's paragraphs", () => {
    const article = extract(
      `<article><p>${story.slice(0, 263)}</p><figure><img src="otter.jpg" alt=""><figcaption><p>${caption}</p><p>${caption}</p></figcaption></figure></article>`,
    );
    assert.match(article.text, /Caption otters float on their backs/);
    assert.equal(article.stripFallback, undefined);
  });

  it("keeps a role=note callout, and still drops a hatnote", () => {
    const article = extract(
      `<article><div class="hatnote">HATNOTE_TEXT</div><p>${story}</p><div role="note"><p>Callout: never feed a wild otter, since it learns to beg and may bite.</p></div></article>`,
    );
    assertProse(article.text);
    assert.match(article.text, /Callout: never feed a wild otter/);
    assert.equal(article.text.includes("HATNOTE_TEXT"), false);
  });

  it("keeps a list of linked steps, and drops a list of short links", () => {
    const steps = [
      "Step one: find a calm cove where otters rest in the kelp at low tide",
      "Step two: stay at least five boat lengths away so you never disturb them",
      "Step three: watch through binoculars and count the otters in each raft",
    ];
    const article = extract(
      `<article><p>${story}</p><ol>${steps.map((step, i) => `<li><a href="/step-${i}">${step}</a></li>`).join("")}</ol>` +
        `<h2>See also</h2><ul><li><a href="/seals">Seals</a></li><li><a href="/kelp">Kelp forests</a></li></ul></article>`,
    );
    assertProse(article.text);
    for (const step of steps) assert.match(article.text, new RegExp(`- ${step}`));
    assert.equal(article.text.includes("Kelp forests"), false);
    assert.equal(article.stripFallback, undefined);
  });

  it("drops citation markers but keeps other bracketed superscripts", () => {
    const article = extract(
      `<article><p>${story} The interval<sup>[0,1]</sup> matters.<sup>[12]</sup> Fur<sup>[a]</sup> is dense.<sup>[note 2]</sup>` +
        ` Kelp grows fast.<sup>[citation needed]</sup> Otters dive<sup><a href="#cite-3">3</a></sup> often.</p></article>`,
    );
    assert.match(article.text, /The interval\[0,1\] matters\. Fur is dense\. Kelp grows fast\. Otters dive often\./);
  });

  it("fails when neither the stripped nor the unstripped page has an article", () => {
    assert.equal(kindOf(() => extract("<aside><p>Too short.</p></aside>")), "extract_failed");
  });
});

describe("extractArticle: a trimmed sectioned article", () => {
  // h2 and a paragraph, 40 times (like most Wikipedia pages): the cut at
  // the last paragraph break that fits lands right after a heading.
  const sections = Array.from({ length: 40 }, (_, i) => ({
    heading: `Section ${i + 1}`,
    body: `Section ${i + 1} prose. ${"Bees collect nectar in the summer and store honey to eat in the winter. ".repeat(8)}`.trim(),
  }));
  const html = `<html><head><title>Bees</title></head><body><article>${sections
    .map((s) => `<h2>${s.heading}</h2><p>${s.body}</p>`)
    .join("")}</article></body></html>`;
  const article = extractArticle(html, PAGE);

  it("would cut right after a heading", () => {
    const full = sections.map((s) => `${s.heading}\n\n${s.body}`).join("\n\n");
    const cut = full.lastIndexOf("\n\n", BODY_TEXT_MAX_LENGTH);
    assert.match(full.slice(0, cut), /\n\nSection \d+$/);
  });

  it("ends on the prose before that heading, not the heading", () => {
    assert.equal(article.trimmed, true);
    assert.match(article.text, /eat in the winter\.$/);
    assert.ok(article.text.length <= BODY_TEXT_MAX_LENGTH);
    const blocks = article.text.split("\n\n");
    assert.equal(blocks.length % 2, 0);
    assert.deepEqual(blocks, sections.slice(0, blocks.length / 2).flatMap((s) => [s.heading, s.body]));
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

// Link titles (see article-title.ts), on small inline pages.
describe("extractArticle: titles", () => {
  const body = `<article>${"<p>Glaciers move downhill, slowly, under their own weight, and carve the valleys below them as they go.</p>".repeat(4)}</article>`;
  const titleOf = (head: string) =>
    extractArticle(`<html><head>${head}</head><body>${body}</body></html>`, PAGE).title;

  it("prefers og:title over <title>", () => {
    assert.equal(
      titleOf('<title>Glaciers | Notes</title><meta property="og:title" content="Why Glaciers Move">'),
      "Why Glaciers Move",
    );
  });

  it("keeps a dash that isn't a site suffix", () => {
    assert.equal(titleOf("<title>Spider-Man - A Hero\u2019s Journey</title>"), "Spider-Man - A Hero\u2019s Journey");
    assert.equal(
      titleOf('<title>COVID-19 - what we know</title><meta property="og:site_name" content="Health News">'),
      "COVID-19 - what we know",
    );
  });

  it("strips a suffix that is og:site_name", () => {
    assert.equal(
      titleOf('<title>Why Glaciers Move | The Field Notes</title><meta property="og:site_name" content="The Field Notes">'),
      "Why Glaciers Move",
    );
    assert.equal(
      titleOf('<meta name="og:title" content="Why Glaciers Move \u2013 The Field Notes"><meta name="og:site_name" content="The Field Notes">'),
      "Why Glaciers Move",
    );
  });

  it("keeps a title that is only the site name", () => {
    assert.equal(
      titleOf('<title>The Field Notes</title><meta property="og:site_name" content="The Field Notes">'),
      "The Field Notes",
    );
  });

  it("keeps <title> unchanged when there are no og: tags", () => {
    assert.equal(titleOf("<title>Why Glaciers Move: A Slow Story | The Field Notes</title>"), "Why Glaciers Move: A Slow Story | The Field Notes");
  });
});
