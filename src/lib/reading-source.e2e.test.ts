import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { extractArticle } from "./fetch-article";
import { resolveReadingSource, type ReadingSourceDeps } from "./reading-source";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch";
import { isBlockedAddress } from "./url-guard";
import type { ReadingFormData } from "./validate-reading";

// The fetchArticle and recordLinkFetch failure logs never carry any part
// of a pasted link: not the host, the port, the path, or the query. Real
// safeFetch failures (DNS, a blocked address, a 404, a timeout, a page with
// no article) go through resolveReadingSource, and the logged fields are
// searched for the link's parts. The host and path are random per run, so
// no real domain is named. Like safe-fetch.e2e.test.ts, the local server
// cases need NODE_ENV "test" for the test-only address policy.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const label = () => `x${randomBytes(6).toString("hex")}`;
const HOST = `${label()}.${label()}`;
const PATH_PART = label();
const QUERY_PART = label();
const PATH = `/${PATH_PART}/story?q=${QUERY_PART}`;

const testOptions: SafeFetchOptions = {
  unsafeTestAddressPolicy: {
    isBlockedAddress: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
    allowAnyPort: true,
  },
};

function linkForm(url: string): ReadingFormData {
  return { gradeLevel: "4", questionCount: 3, questionMode: "shared", source: "link", url, title: "" };
}

async function logsFor(url: string, overrides: Partial<ReadingSourceDeps>): Promise<[string, Record<string, unknown>][]> {
  const logs: [string, Record<string, unknown>][] = [];
  const result = await resolveReadingSource(linkForm(url), {
    recordLinkFetch: async () => true,
    fetchArticle: async (link) => {
      const page = await safeFetch(link, { deadlineMs: 500, ...testOptions });
      return { ...extractArticle(page.html, page.url), url: page.url.href };
    },
    log: (message, fields) => logs.push([message, fields]),
    ...overrides,
  });
  assert.equal(result.ok, false);
  return logs;
}

function assertNoLinkParts(logs: unknown, parts: string[]) {
  const json = JSON.stringify(logs);
  for (const part of parts) assert.ok(!json.includes(part), `a link part is in the log: ${json}`);
}

describe("link failure logs carry no part of the link", () => {
  let server: http.Server;
  let port: number;
  const hung: http.ServerResponse[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.includes("hang")) {
        hung.push(res);
        return;
      }
      if (req.url?.includes("missing")) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<p>not here</p>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><p>too short</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(() => {
    for (const res of hung) res.destroy();
    server.close();
  });

  it("a DNS failure whose error names the host", async () => {
    const resolver = async (hostname: string) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname });
    };
    const logs = await logsFor(`https://${HOST}${PATH}`, {
      fetchArticle: async (link) => {
        const page = await safeFetch(link, { resolver });
        return { ...extractArticle(page.html, page.url), url: page.url.href };
      },
    });
    assert.deepEqual(logs, [
      [
        "fetchArticle failed",
        {
          kind: "http_error",
          name: "FetchArticleError",
          causes: [{ name: "Error", code: "ENOTFOUND" }],
          timedOut: false,
          message: "fetch article failed: http_error",
        },
      ],
    ]);
    assertNoLinkParts(logs, [HOST, PATH_PART, QUERY_PART]);
  });

  it("a host that resolves to a blocked address", async () => {
    const logs = await logsFor(`https://${HOST}${PATH}`, {
      fetchArticle: async (link) => {
        const page = await safeFetch(link, { resolver: async () => [{ address: "10.0.0.1", family: 4 }] });
        return { ...extractArticle(page.html, page.url), url: page.url.href };
      },
    });
    assert.equal(logs[0][1].kind, "blocked");
    assertNoLinkParts(logs, [HOST, PATH_PART, QUERY_PART]);
  });

  it("a 404 logs its status", async () => {
    const logs = await logsFor(`http://127.0.0.1:${port}/missing${PATH}`, {});
    assert.deepEqual(logs[0], [
      "fetchArticle failed",
      {
        kind: "http_error",
        status: 404,
        name: "FetchArticleError",
        causes: [],
        timedOut: false,
        message: "fetch article failed: http_error",
      },
    ]);
    assertNoLinkParts(logs, ["127.0.0.1", String(port), "missing", PATH_PART, QUERY_PART]);
  });

  it("a timeout", async () => {
    const logs = await logsFor(`http://127.0.0.1:${port}/hang${PATH}`, {});
    assert.equal(logs[0][1].kind, "timeout");
    assert.equal(logs[0][1].timedOut, true);
    assertNoLinkParts(logs, ["127.0.0.1", String(port), "hang", PATH_PART, QUERY_PART]);
  });

  it("a page with no article", async () => {
    const logs = await logsFor(`http://127.0.0.1:${port}${PATH}`, {});
    assert.equal(logs[0][1].kind, "extract_failed");
    assertNoLinkParts(logs, ["127.0.0.1", String(port), PATH_PART, QUERY_PART]);
  });

  it("recordLinkFetch failing with an error that quotes the link", async () => {
    const url = `https://${HOST}${PATH}`;
    const logs = await logsFor(url, {
      recordLinkFetch: async () => {
        throw Object.assign(new Error(`Failed query: insert\nparams: ${url}`), { code: "23505", detail: url });
      },
      fetchArticle: async () => assert.fail("no fetch when the limit can't be checked"),
    });
    assert.deepEqual(logs, [["recordLinkFetch failed", { name: "Error", code: "23505", causes: [], timedOut: false }]]);
    assertNoLinkParts(logs, [HOST, PATH_PART, QUERY_PART]);
  });
});
