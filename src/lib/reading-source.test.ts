import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FetchArticleError } from "./fetch-errors";
import { LINK_FETCH_LIMITED_MESSAGE } from "./link-rate-limit";
import {
  LINK_ERRORS,
  NO_PAGE_TITLE_MESSAGE,
  resolveReadingSource,
  SAVE_READING_FAILED_MESSAGE,
  type ReadingSourceDeps,
} from "./reading-source";
import type { ReadingFormData } from "./validate-reading";

const SETTINGS = { gradeLevel: "4" as const, questionCount: 3, questionMode: "shared" as const };
const LINK: ReadingFormData = { ...SETTINGS, source: "link", url: "https://example.com/story", title: "" };
const TEXT: ReadingFormData = { ...SETTINGS, source: "text", title: "A story", bodyText: "Body ".repeat(60) };

function deps(overrides: Partial<ReadingSourceDeps> = {}) {
  const calls = { record: 0, fetch: 0, logs: [] as Record<string, unknown>[] };
  const d: ReadingSourceDeps = {
    recordLinkFetch: async () => {
      calls.record++;
      return true;
    },
    fetchArticle: async (url) => {
      calls.fetch++;
      return { title: "Page title", text: "Article ".repeat(40), url: `${url}?final` };
    },
    log: (_m, fields) => calls.logs.push(fields),
    ...overrides,
  };
  return { d, calls };
}

describe("resolveReadingSource", () => {
  it("takes pasted text as is, with no fetch and no limit", async () => {
    const { d, calls } = deps();
    const result = await resolveReadingSource(TEXT, d);
    assert.deepEqual(result, { ok: true, source: { title: "A story", bodyText: TEXT.source === "text" ? TEXT.bodyText : "", sourceUrl: null } });
    assert.deepEqual([calls.record, calls.fetch], [0, 0]);
  });

  it("fetches a link after the limit allows it, keeping the final URL and the page title", async () => {
    const { d, calls } = deps();
    const result = await resolveReadingSource(LINK, d);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.source.title, "Page title");
      assert.equal(result.source.sourceUrl, "https://example.com/story?final");
    }
    assert.deepEqual([calls.record, calls.fetch], [1, 1]);
  });

  it("prefers the typed title", async () => {
    const { d } = deps();
    const result = await resolveReadingSource({ ...LINK, title: "My title" }, d);
    assert.equal(result.ok && result.source.title, "My title");
  });

  it("at the limit: no fetch, the limit note (not an error) with a relative time, and the paste suggestion", async () => {
    const { d, calls } = deps({ recordLinkFetch: async () => false });
    assert.deepEqual(await resolveReadingSource(LINK, d), {
      ok: false,
      errors: {},
      limit: `${LINK_FETCH_LIMITED_MESSAGE} Try again in a few minutes.`,
      suggestText: "Paste the text instead.",
    });
    assert.equal(calls.fetch, 0);
  });

  it("at the limit with the action's retry time; a failure reading it falls back to relative", async () => {
    const timed = deps({ recordLinkFetch: async () => false, limitedMessage: async () => "Paused. You can try again at 2:40 PM." });
    const result = await resolveReadingSource(LINK, timed.d);
    assert.equal(!result.ok && result.limit, "Paused. You can try again at 2:40 PM.");
    const broken = deps({
      recordLinkFetch: async () => false,
      limitedMessage: async () => {
        throw new Error("db down");
      },
    });
    const fallback = await resolveReadingSource(LINK, broken.d);
    assert.equal(!fallback.ok && fallback.limit, `${LINK_FETCH_LIMITED_MESSAGE} Try again in a few minutes.`);
  });

  it("fails closed when the limit can't be checked", async () => {
    const { d, calls } = deps({
      recordLinkFetch: async () => {
        throw Object.assign(new Error("db down"), { code: "08006" });
      },
    });
    assert.deepEqual(await resolveReadingSource(LINK, d), { ok: false, errors: { form: SAVE_READING_FAILED_MESSAGE } });
    assert.equal(calls.fetch, 0);
  });

  it("maps fetch errors to the link messages, logging only safe fields", async () => {
    const { d, calls } = deps({
      fetchArticle: async () => {
        throw new FetchArticleError("not_html", "example.com");
      },
    });
    assert.deepEqual(await resolveReadingSource(LINK, d), {
      ok: false,
      errors: { url: LINK_ERRORS.not_html },
      suggestText: "Paste the text instead.",
    });
    assert.deepEqual(calls.logs.at(-1), {
      kind: "not_html",
      host: "example.com",
      name: "FetchArticleError",
      causes: [],
      timedOut: false,
      // A fixed app string (safe-error-fields.ts allows it).
      message: "fetch article failed: not_html",
    });
    const tooLong = deps({
      fetchArticle: async () => {
        throw new FetchArticleError("too_long", "example.com");
      },
    });
    const r = await resolveReadingSource(LINK, tooLong.d);
    assert.equal(!r.ok && r.suggestText, "Paste a shorter section instead.");
  });

  it("asks for a title when the page has none", async () => {
    const { d } = deps({ fetchArticle: async (url) => ({ title: "  ", text: "x".repeat(300), url }) });
    assert.deepEqual(await resolveReadingSource(LINK, d), { ok: false, errors: { title: NO_PAGE_TITLE_MESSAGE } });
  });
});
