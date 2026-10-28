import { normalizeTitle } from "./validate-reading";

// The title of a linked article, from what the page says about itself.
//
// 1. og:title, when the page has one.
// 2. Otherwise the page's <title>, as written. Readability's own title
//    (its _getArticleTitle) cuts any title at its last " - ", " | ", "/",
//    ">" or "»", or around a colon, which mangles titles like
//    "COVID-19 - what we know"; we never split generically, so its title
//    is used only when the page has no <title> at all.
// 3. Then one trailing site name comes off: the text after the last
//    separator when it is exactly og:site_name, or Wikipedia's suffix.
//    Never down to nothing.
export type TitleSources = {
  ogTitle?: string | null;
  siteName?: string | null;
  documentTitle?: string | null;
  readabilityTitle?: string | null;
};

const SEPARATORS = [" - ", " – ", " | ", " · ", " :: "];

// " - Wikipedia", or " - <edition> Wikipedia, the free encyclopedia"
// (" - Simple English Wikipedia, the free encyclopedia"). The edition part
// can't hold " - ", so only the last suffix matches.
const WIKIPEDIA_SUFFIX = / - (?:Wikipedia|(?:(?:(?! - ).)+ )?Wikipedia, the free encyclopedia)$/;

// Some text other than spaces and separator marks.
const HAS_WORDS = /[^\s\-–|·:]/;

// The title without its trailing site name (see above), or the title as it
// was when there is none or nothing would be left. Expects a normalized
// title. The site name match is exact (after whitespace cleanup), case
// included: a different casing is more likely part of the title.
export function stripSiteSuffix(title: string, siteName = ""): string {
  let stripped: string | undefined;
  const site = normalizeTitle(siteName);
  if (site) {
    for (const separator of SEPARATORS) {
      if (title.endsWith(separator + site)) {
        stripped = title.slice(0, -(separator + site).length);
        break;
      }
    }
  }
  if (stripped === undefined) {
    const wiki = WIKIPEDIA_SUFFIX.exec(title);
    if (wiki) stripped = title.slice(0, wiki.index);
  }
  if (stripped === undefined || !HAS_WORDS.test(stripped)) return title;
  return normalizeTitle(stripped);
}

export function pickArticleTitle(sources: TitleSources): string {
  const title =
    normalizeTitle(sources.ogTitle ?? "") ||
    normalizeTitle(sources.documentTitle ?? "") ||
    normalizeTitle(sources.readabilityTitle ?? "");
  return stripSiteSuffix(title, sources.siteName ?? "");
}

type MetaDocument = {
  querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null }>;
};

// The first non-empty content of <meta property="og:KEY"> or
// <meta name="og:KEY">.
export function openGraphValue(document: MetaDocument, key: "title" | "site_name"): string {
  for (const meta of document.querySelectorAll(`meta[property="og:${key}"], meta[name="og:${key}"]`)) {
    const content = normalizeTitle(meta.getAttribute("content") ?? "");
    if (content) return content;
  }
  return "";
}
