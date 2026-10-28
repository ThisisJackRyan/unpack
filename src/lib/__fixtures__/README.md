# Test fixtures

Saved pages for the article extractor tests (src/lib/fetch-article.test.ts),
so the tests never fetch anything over the network.

- `article.html`: hand-written news-style page.
- `blog-with-chrome.html`: hand-written blog post with the usual non-prose
  blocks around it (site header and footer, nav, aside, a navigation box, a
  data table, a figure, footnote markers and a footnote list).
- `wikipedia-honey-bee-simple.html`: https://simple.wikipedia.org/wiki/Honey_bee
  as fetched with curl on October 28, 2026, unchanged (revision 10938569:
  https://simple.wikipedia.org/w/index.php?title=Honey_bee&oldid=10938569).
  "Honey bee" by Simple English Wikipedia contributors, licensed CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/), used here only as a test
  fixture.
- `long-article.ts`: a generated article over the reading length limit.
- `strip-fallback.ts`: a generated page whose prose is mostly an image
  caption, so the extractor falls back to the unstripped page.
