import "server-only";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { FetchArticleError } from "./fetch-errors";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch";
import { trimToLimit } from "./trim-article";
import { BODY_TEXT_MIN_LENGTH, normalizeBodyText, normalizeTitle } from "./validate-reading";

// Server-only: turns a web page into a reading's title and plain text.
// linkedom parses the HTML without running scripts or loading anything, and
// Readability picks out the article.

// trimmed: the article was over BODY_TEXT_MAX_LENGTH, and text is its
// first part (see trim-article.ts).
export type Article = { title: string; text: string; trimmed: boolean };

// Parsing and Readability are synchronous CPU work that the fetch deadline
// doesn't cover, so pages over these limits are refused as extract_failed.
// Article pages are usually a few thousand elements, nested a few dozen
// deep; a 2 MB page of empty tags can be hundreds of thousands.
//
// Two checks, because deep nesting is slow in both steps:
// - Before parsing, at most MAX_START_TAGS "<" + letter sequences. linkedom's
//   parser (htmlparser2) takes time that grows with the square of the
//   nesting depth (100,000 nested divs took over 8 s just to parse). Every
//   element it opens comes from one of these sequences, so the count bounds
//   both the element count and the depth. It's looser than MAX_ELEMENTS
//   because it also counts "<a" inside scripts and comments.
// - After parsing, at most MAX_ELEMENTS elements and MAX_DEPTH levels.
//   Readability walks each node's ancestors, so its time grows with
//   elements times depth, and some of its code recurses: 15,000 nested
//   divs took over 6 s and then overflowed the stack.
export const MAX_START_TAGS = 30_000;
export const MAX_ELEMENTS = 20_000;
export const MAX_DEPTH = 500;

// True when html has more than MAX_START_TAGS "<" + letter sequences.
export function exceedsStartTagLimit(html: string): boolean {
  const startTag = /<[a-z]/gi;
  let count = 0;
  while (startTag.exec(html)) {
    if (++count > MAX_START_TAGS) return true;
  }
  return false;
}

type ElementLike = {
  firstElementChild: ElementLike | null;
  nextElementSibling: ElementLike | null;
  parentElement: ElementLike | null;
};

// True when the tree under root has more than MAX_ELEMENTS elements or goes
// deeper than MAX_DEPTH. Iterative, and stops as soon as a limit is passed.
// (linkedom's getElementsByTagName("*") returns nothing, so neither it nor
// Readability's own maxElemsToParse check can count elements.)
export function exceedsElementLimits(root: ElementLike | null): boolean {
  let count = 0;
  let depth = 0;
  let node = root;
  while (node) {
    if (++count > MAX_ELEMENTS || depth > MAX_DEPTH) return true;
    if (node.firstElementChild) {
      node = node.firstElementChild;
      depth++;
      continue;
    }
    while (node && node !== root && !node.nextElementSibling) {
      node = node.parentElement;
      depth--;
    }
    node = node && node !== root ? node.nextElementSibling : null;
  }
  return false;
}

// Elements that start a new paragraph in the plain text.
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl",
  "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tr", "ul",
]);
const SKIP = new Set(["script", "style", "noscript", "template", "iframe", "svg"]);

// Blocks that aren't the article's prose, removed before Readability:
// Readability keeps data tables and boxes it scores as content, so an
// infobox's cells or a reference list would otherwise land in the reading.
// Generic patterns (ARIA roles, semantic tags, and the class names wikis
// and blogs commonly use), with Wikipedia as the test case
// (fetch-article.test.ts).
const NON_PROSE = [
  // Data widgets: rows of cells, never sentences.
  "[role=table]", "[role=grid]", "[role=treegrid]",
  // Navigation and page chrome.
  "nav", "aside", "[role=navigation]", "[role=complementary]", "[role=banner]",
  "[role=contentinfo]", "[role=search]",
  // Fact boxes, navigation boxes, sidebars, and notices.
  ".infobox", ".navbox", ".vertical-navbox", ".navbox-styles", ".sidebar",
  ".metadata", ".ambox", ".mbox-small", ".sistersitebox", ".side-box",
  ".shortdescription",
  // Reference lists, footnotes, and the markers that point at them.
  ".reflist", ".references", ".mw-references-wrap", ".refbegin", ".footnotes",
  "[role=doc-endnotes]", "[role=doc-footnote]", "[role=doc-bibliography]",
  "sup.reference", ".mw-ref", "[role=doc-noteref]", ".footnote-ref",
  ".mw-cite-backlink",
  // "[edit]" links, hatnotes ("For other uses, see ..."), tables of contents.
  ".mw-editsection", ".editsection", ".hatnote", "[role=note]",
  "#toc", ".toc", ".mw-table-of-contents-container", ".vector-toc", "[role=doc-toc]",
  // Figures: we show no images, so a caption describes something the
  // reader can't see.
  "figure", "figcaption", ".thumb", ".thumbcaption", ".gallery",
  // Print and wiki chrome ("From Wikipedia, the free encyclopedia",
  // categories, jump links).
  ".noprint", ".mw-empty-elt", ".printfooter", ".catlinks", "#catlinks",
  "#siteSub", "#contentSub", ".mw-jump-link", ".navigation-not-searchable",
  ".mw-indicators",
].join(", ");

// Never removed whole, whatever their class: a page's own article.
const ARTICLE = "html, body, main, article, [role=main]";

// A table holding a paragraph this long is laid out with tables (older
// sites), not data, so it stays.
const LAYOUT_TABLE_PARAGRAPH = 200;

// A citation marker written as a superscript: "[1]", "[a]", "[note 2]",
// "[citation needed]".
const BRACKETED_MARKER = /^\s*\[[^\]]{1,24}\]\s*$/;
// A bare footnote number ("3", "3,4") linking within the page.
const NUMBER_MARKER = /^\s*\d+(\s*[,\u2013-]\s*\d+)*\s*$/;

type PageElement = {
  localName: string;
  textContent: string | null;
  parentElement: PageElement | null;
  children: ArrayLike<PageElement>;
  matches(selector: string): boolean;
  closest(selector: string): PageElement | null;
  querySelector(selector: string): PageElement | null;
  querySelectorAll(selector: string): Iterable<PageElement>;
  remove(): void;
};

function wordsOf(text: string | null): string {
  return (text ?? "").replace(/\s+/g, "");
}

// A list where every item is only a link: "Related pages", "See also",
// "Other websites", lists of more articles.
function isLinkList(list: PageElement): boolean {
  const items = Array.from(list.children).filter((el) => el.localName === "li");
  if (items.length === 0) return false;
  return items.every((li) => {
    const text = wordsOf(li.textContent);
    if (!text) return true;
    const linked = Array.from(li.querySelectorAll("a"), (a) => wordsOf(a.textContent)).join("");
    return linked === text;
  });
}

function isLayoutTable(table: PageElement): boolean {
  for (const p of table.querySelectorAll("p")) {
    if ((p.textContent ?? "").trim().length >= LAYOUT_TABLE_PARAGRAPH) return true;
  }
  return false;
}

// Removes the blocks that aren't prose (see NON_PROSE) from a parsed
// page, in place. Anything that is or holds the page's article is kept.
export function stripNonProse(root: PageElement): void {
  const remove = (el: PageElement) => {
    if (el.matches(ARTICLE) || el.querySelector(ARTICLE)) return;
    el.remove();
  };
  for (const el of Array.from(root.querySelectorAll(NON_PROSE))) remove(el);
  // Site headers and footers; one inside the article (a byline, say) is
  // left to Readability.
  for (const el of Array.from(root.querySelectorAll("header, footer"))) {
    if (!el.parentElement?.closest(ARTICLE.replace("html, body, ", ""))) remove(el);
  }
  for (const el of Array.from(root.querySelectorAll("table"))) {
    if (!isLayoutTable(el)) remove(el);
  }
  for (const el of Array.from(root.querySelectorAll("sup"))) {
    const text = el.textContent ?? "";
    if (BRACKETED_MARKER.test(text) || (NUMBER_MARKER.test(text) && el.querySelector('a[href^="#"]'))) {
      remove(el);
    }
  }
  for (const el of Array.from(root.querySelectorAll("ul, ol"))) {
    if (isLinkList(el)) remove(el);
  }
}

type ContentNode = DomNode & { remove?: () => void };

// Drops headings left with no prose under them (a "References" heading
// whose list was stripped, say): no text before the next heading of the
// same or a higher level, or the end. Text under a kept subheading counts
// for its parent. Iterative, like htmlToText.
export function dropEmptySections(root: ContentNode): void {
  const TEXT = 0;
  const events: (typeof TEXT | { heading: ContentNode; level: number })[] = [];
  const stack: ContentNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      if (/\S/.test(node.nodeValue ?? "")) events.push(TEXT);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = (node.localName ?? "").toLowerCase();
    if (SKIP.has(tag)) continue;
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      events.push({ heading: node, level: Number(heading[1]) });
      continue;
    }
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  // Walking back from the end: hasProse[level] is whether prose follows
  // before the next heading at that level or higher.
  const hasProse = [false, false, false, false, false, false, false];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === TEXT) {
      hasProse.fill(true);
      continue;
    }
    if (!hasProse[event.level]) event.heading.remove?.();
    for (let level = event.level; level <= 6; level++) hasProse[level] = false;
  }
}

type DomNode = {
  nodeType: number;
  nodeValue: string | null;
  localName?: string;
  childNodes: ArrayLike<DomNode>;
};

// Plain text from article HTML: a blank line between blocks, a newline for
// <br>, "- " before each list item, and whitespace inside text collapsed
// (except in <pre>).
export function htmlToText(root: DomNode): string {
  // Text chunks, so trimming only ever touches the end, never the whole text.
  const parts: string[] = [];
  const atLineStart = () => parts.length === 0 || parts[parts.length - 1].endsWith("\n");
  // Line breaks drop the spaces before them, except spaces inside <pre>.
  const breakLine = (text: string) => {
    while (parts.length > 0) {
      const last = parts[parts.length - 1].replace(/[ \t]+$/, "");
      if (last) {
        parts[parts.length - 1] = last;
        break;
      }
      parts.pop();
    }
    parts.push(text);
  };
  // Walks the tree with an explicit stack, not recursion, so a deeply
  // nested page can't overflow the call stack. CLOSE marks the end of a
  // block element.
  const CLOSE = null;
  const stack: ({ node: DomNode; pre: boolean } | typeof CLOSE)[] = [
    { node: root, pre: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame === CLOSE) {
      breakLine("\n\n");
      continue;
    }
    const { node, pre } = frame;
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      if (pre) {
        parts.push(text);
      } else {
        const collapsed = text.replace(/\s+/g, " ");
        const piece = atLineStart() ? collapsed.trimStart() : collapsed;
        if (piece) parts.push(piece);
      }
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = (node.localName ?? "").toLowerCase();
    if (SKIP.has(tag)) continue;
    if (tag === "br") {
      breakLine("\n");
      continue;
    }
    const block = BLOCKS.has(tag);
    if (block) breakLine("\n\n");
    if (tag === "li") breakLine("\n- ");
    if (tag === "td" || tag === "th") parts.push(" ");
    if (block) stack.push(CLOSE);
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], pre: pre || tag === "pre" });
    }
  }
  return normalizeBodyText(parts.join(""));
}

// Pulls the article out of a page, without the blocks that aren't prose
// (stripNonProse, dropEmptySections). Text over BODY_TEXT_MAX_LENGTH is
// cut to its first part, at a paragraph break when one fits, and flagged
// trimmed. Throws FetchArticleError "extract_failed" when there is no
// usable article (or too little text).
//
// Everything that walks the page (parsing, Readability, htmlToText) is
// inside the try, so a parser error, a page over the size limits above, or
// a RangeError from deep nesting is "extract_failed", not a crash.
export function extractArticle(html: string, pageUrl: URL): Article {
  let text: string;
  let title: string;
  try {
    if (exceedsStartTagLimit(html)) {
      throw new FetchArticleError("extract_failed");
    }
    const { document } = parseHTML(html);
    if (exceedsElementLimits(document.documentElement)) {
      throw new FetchArticleError("extract_failed");
    }
    for (const el of document.querySelectorAll(
      "script, style, noscript, template, base",
    )) {
      el.remove();
    }
    stripNonProse(document.documentElement as unknown as PageElement);
    // Give the document its real URL, so any relative link Readability
    // resolves points at the page, not at our server.
    const head = document.head ?? document.documentElement;
    if (head) {
      const base = document.createElement("base");
      base.setAttribute("href", pageUrl.href);
      head.prepend(base);
    }
    const pageTitle = document.title ?? "";
    const parsed = new Readability<DomNode>(document as unknown as Document, {
      // Ineffective with linkedom today (see exceedsElementLimits), but
      // harmless, and it takes over if linkedom starts counting "*".
      maxElemsToParse: MAX_ELEMENTS,
      serializer: (el) => el as unknown as DomNode,
    }).parse();
    if (!parsed?.content) throw new FetchArticleError("extract_failed");
    // Readability can empty a section on its own, so this runs on its
    // output.
    dropEmptySections(parsed.content);
    text = htmlToText(parsed.content);
    title = normalizeTitle(parsed.title || pageTitle);
  } catch (error) {
    if (error instanceof FetchArticleError) throw error;
    throw new FetchArticleError("extract_failed", { cause: error });
  }
  // An article over the limit keeps its first part (trimToLimit), with
  // trimmed set so the reading can say so.
  const kept = trimToLimit(text);
  if (kept.text.length < BODY_TEXT_MIN_LENGTH) {
    throw new FetchArticleError("extract_failed");
  }
  return { title, text: kept.text, trimmed: kept.trimmed };
}

export async function fetchArticle(
  url: string,
  options?: Omit<SafeFetchOptions, "unsafeTestAddressPolicy">,
): Promise<Article & { url: string }> {
  const page = await safeFetch(url, options);
  return { ...extractArticle(page.html, page.url), url: page.url.href };
}
