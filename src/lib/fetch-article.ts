import "server-only";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { FetchArticleError } from "./fetch-errors";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch";
import {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_MIN_LENGTH,
  normalizeBodyText,
  normalizeTitle,
} from "./validate-reading";

// Server-only: turns a web page into a reading's title and plain text.
// linkedom parses the HTML without running scripts or loading anything, and
// Readability picks out the article.

export type Article = { title: string; text: string };

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

// Pulls the article out of a page. Throws FetchArticleError: "extract_failed"
// when there is no usable article (or too little text), "too_long" when the
// text is over BODY_TEXT_MAX_LENGTH (we never cut it silently).
//
// Everything that walks the page (parsing, Readability, htmlToText) is
// inside the try, so a parser error, a page over the size limits above, or
// a RangeError from deep nesting is "extract_failed", not a crash.
export function extractArticle(html: string, pageUrl: URL): Article {
  const host = pageUrl.hostname;
  let text: string;
  let title: string;
  try {
    if (exceedsStartTagLimit(html)) {
      throw new FetchArticleError("extract_failed", host);
    }
    const { document } = parseHTML(html);
    if (exceedsElementLimits(document.documentElement)) {
      throw new FetchArticleError("extract_failed", host);
    }
    for (const el of document.querySelectorAll(
      "script, style, noscript, template, base",
    )) {
      el.remove();
    }
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
    if (!parsed?.content) throw new FetchArticleError("extract_failed", host);
    text = htmlToText(parsed.content);
    title = normalizeTitle(parsed.title || pageTitle);
  } catch (error) {
    if (error instanceof FetchArticleError) throw error;
    throw new FetchArticleError("extract_failed", host, { cause: error });
  }
  if (text.length < BODY_TEXT_MIN_LENGTH) {
    throw new FetchArticleError("extract_failed", host);
  }
  if (text.length > BODY_TEXT_MAX_LENGTH) {
    throw new FetchArticleError("too_long", host);
  }
  return { title, text };
}

export async function fetchArticle(
  url: string,
  options?: Omit<SafeFetchOptions, "unsafeTestAddressPolicy">,
): Promise<Article & { url: string }> {
  const page = await safeFetch(url, options);
  return { ...extractArticle(page.html, page.url), url: page.url.href };
}
