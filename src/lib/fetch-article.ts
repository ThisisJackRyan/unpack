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
  const walk = (node: DomNode, pre: boolean) => {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      if (pre) {
        parts.push(text);
      } else {
        const collapsed = text.replace(/\s+/g, " ");
        const piece = atLineStart() ? collapsed.trimStart() : collapsed;
        if (piece) parts.push(piece);
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node.localName ?? "").toLowerCase();
    if (SKIP.has(tag)) return;
    if (tag === "br") {
      breakLine("\n");
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) breakLine("\n\n");
    if (tag === "li") breakLine("\n- ");
    if (tag === "td" || tag === "th") parts.push(" ");
    for (const child of Array.from(node.childNodes)) {
      walk(child, pre || tag === "pre");
    }
    if (block) breakLine("\n\n");
  };
  walk(root, false);
  return normalizeBodyText(parts.join(""));
}

// Pulls the article out of a page. Throws FetchArticleError: "extract_failed"
// when there is no usable article (or too little text), "too_long" when the
// text is over BODY_TEXT_MAX_LENGTH (we never cut it silently).
export function extractArticle(html: string, pageUrl: URL): Article {
  const host = pageUrl.hostname;
  let parsed: ReturnType<Readability<DomNode>["parse"]>;
  let pageTitle = "";
  try {
    const { document } = parseHTML(html);
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
    pageTitle = document.title ?? "";
    parsed = new Readability<DomNode>(document as unknown as Document, {
      serializer: (el) => el as unknown as DomNode,
    }).parse();
  } catch (error) {
    throw new FetchArticleError("extract_failed", host, { cause: error });
  }
  if (!parsed?.content) throw new FetchArticleError("extract_failed", host);

  const text = htmlToText(parsed.content);
  if (text.length < BODY_TEXT_MIN_LENGTH) {
    throw new FetchArticleError("extract_failed", host);
  }
  if (text.length > BODY_TEXT_MAX_LENGTH) {
    throw new FetchArticleError("too_long", host);
  }
  const title = normalizeTitle(parsed.title || pageTitle);
  return { title, text };
}

export async function fetchArticle(
  url: string,
  options?: SafeFetchOptions,
): Promise<Article & { url: string }> {
  const page = await safeFetch(url, options);
  return { ...extractArticle(page.html, page.url), url: page.url.href };
}
