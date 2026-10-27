import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import { describe, it } from "node:test";
import { FetchArticleError, type FetchArticleErrorKind } from "./fetch-errors";
import {
  checkRedirect,
  checkUrl,
  createGuardedLookup,
  embeddedIPv4,
  isBlockedAddress,
  isBlockedHostname,
  type ResolvedAddress,
} from "./url-guard";

function rejectsWith(fn: () => unknown, kind: FetchArticleErrorKind, label?: string) {
  assert.throws(
    fn,
    (error) => error instanceof FetchArticleError && error.kind === kind,
    label,
  );
}

describe("isBlockedAddress: IPv4", () => {
  const blocked = [
    "0.0.0.0", "0.255.255.255",
    "10.0.0.1", "10.255.255.255",
    "100.64.0.1", "100.127.255.254",
    "127.0.0.1", "127.255.255.254",
    "169.254.0.1", "169.254.169.254",
    "172.16.0.1", "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1", "192.168.255.255",
    "198.18.0.1", "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255",
  ];
  const allowed = [
    "1.1.1.1", "8.8.8.8", "93.184.215.14",
    "100.63.255.255", "100.128.0.0",
    "172.15.255.255", "172.32.0.0",
    "192.0.1.1", "192.169.0.1",
    "198.17.255.255", "198.20.0.0",
    "223.255.255.255",
  ];

  for (const address of blocked) {
    it(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
  }
  for (const address of allowed) {
    it(`allows ${address}`, () => assert.equal(isBlockedAddress(address), false));
  }
});

describe("isBlockedAddress: IPv6", () => {
  const blocked = [
    "::", "::1", "[::1]", "0:0:0:0:0:0:0:1",
    "::7f00:1", // IPv4-compatible 127.0.0.1
    "fc00::1", "fd00::1", "fd00:ec2::254",
    "fe80::1", "febf::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    "2001::1", "2001:0:4136:e378::1", // Teredo
    "64:ff9b:1::1",
    "fe80::1%eth0",
    // Outside 2000::/3, so blocked by the allowlist without being listed.
    "::ffff:0:7f00:1", // IPv4-translated 127.0.0.1
    "::ffff:0:808:808", // IPv4-translated, blocked even for a public v4
    "5f00::1", // SRv6 SIDs
    "4000::1", "1fff:ffff::1", "e000::1",
    // Inside 2000::/3 but special.
    "3fff::1", "3fff:fff:ffff::1", // documentation 3fff::/20
    "2001:2::1", // benchmarking, inside 2001::/23
  ];
  const allowed = [
    "2606:4700::1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "2001:4860:4860::8888",
    "2000::1", // first address of 2000::/3
    "3fff:1000::1", // just past 3fff::/20
    "3ffe::1", // just before 3fff::/20
  ];

  for (const address of blocked) {
    it(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
  }
  for (const address of allowed) {
    it(`allows ${address}`, () => assert.equal(isBlockedAddress(address), false));
  }

  it("blocks anything that isn't an IP", () => {
    for (const value of ["", "localhost", "example.com", "1.2.3", "::g"]) {
      assert.equal(isBlockedAddress(value), true, value);
    }
  });
});

describe("embedded IPv4", () => {
  it("reads IPv4-mapped, NAT64, and 6to4 addresses", () => {
    assert.equal(embeddedIPv4("::ffff:127.0.0.1"), "127.0.0.1");
    assert.equal(embeddedIPv4("::ffff:7f00:1"), "127.0.0.1");
    assert.equal(embeddedIPv4("0:0:0:0:0:ffff:a9fe:a9fe"), "169.254.169.254");
    assert.equal(embeddedIPv4("64:ff9b::10.0.0.1"), "10.0.0.1");
    assert.equal(embeddedIPv4("64:ff9b::a00:1"), "10.0.0.1");
    assert.equal(embeddedIPv4("2002:c0a8:101::1"), "192.168.1.1");
    assert.equal(embeddedIPv4("2606:4700::1"), undefined);
  });

  it("blocks a private IPv4 inside each form", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::ffff:10.1.2.3",
      "64:ff9b::7f00:1",
      "64:ff9b::192.168.0.1",
      "64:ff9b::a00:1", // NAT64 of 10.0.0.1
      "2002:7f00:1::",
      "2002:a9fe:a9fe::1",
    ]) {
      assert.equal(isBlockedAddress(address), true, address);
    }
  });

  it("allows a public IPv4 inside each form", () => {
    for (const address of [
      "::ffff:8.8.8.8",
      "64:ff9b::808:808", // NAT64 of 8.8.8.8, though 64:ff9b:: is outside 2000::/3
      "64:ff9b::1.1.1.1",
      "2002:808:808::1",
    ]) {
      assert.equal(isBlockedAddress(address), false, address);
    }
  });
});

describe("isBlockedHostname", () => {
  it("blocks local names", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "app.localhost",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "metadata.google.internal.",
      "intranet",
      "",
    ]) {
      assert.equal(isBlockedHostname(host), true, host);
    }
  });

  it("allows public names", () => {
    for (const host of ["example.com", "news.bbc.co.uk", "localhost.example.com", "internal.example.org"]) {
      assert.equal(isBlockedHostname(host), false, host);
    }
  });
});

describe("checkUrl", () => {
  it("allows public http and https URLs on default ports", () => {
    for (const url of [
      "https://example.com/a",
      "http://example.com/a",
      "http://example.com:80/a",
      "https://example.com:443/a",
      "http://example.com:443/a",
      "https://8.8.8.8/",
      "https://[2606:4700:4700::1111]/",
    ]) {
      assert.equal(checkUrl(url).href, new URL(url).href, url);
    }
  });

  it("rejects other schemes and bad URLs as invalid", () => {
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "gopher://example.com/", "not a url", ""]) {
      rejectsWith(() => checkUrl(url), "invalid_url", url);
    }
  });

  it("rejects credentials", () => {
    rejectsWith(() => checkUrl("https://user:pass@example.com/"), "blocked");
    rejectsWith(() => checkUrl("https://user@example.com/"), "blocked");
  });

  it("rejects other ports", () => {
    for (const url of ["http://example.com:8080/", "https://example.com:8443/", "http://example.com:22/", "http://example.com:0/"]) {
      rejectsWith(() => checkUrl(url), "blocked", url);
    }
  });

  it("blocks private IP literals", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.0.0.1./",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::]/",
      "http://[fd00:ec2::254]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[64:ff9b::127.0.0.1]/",
      "http://[2002:7f00:1::]/",
      "http://[::ffff:0:7f00:1]/",
      "http://[5f00::1]/",
      "http://[3fff::1]/",
      "http://[fc00::1]/",
      "http://[2001:db8::1]/",
      "http://0.0.0.0/",
      "http://255.255.255.255/",
    ]) {
      rejectsWith(() => checkUrl(url), "blocked", url);
    }
  });

  it("blocks decimal, octal, and hex IPv4 spellings after WHATWG normalizes them", () => {
    const cases: [string, string][] = [
      ["http://2130706433/", "127.0.0.1"],
      ["http://0x7f.1/", "127.0.0.1"],
      ["http://017700000001/", "127.0.0.1"],
      ["http://0x7f000001/", "127.0.0.1"],
      ["http://0177.0.0.1/", "127.0.0.1"],
      ["http://127.1/", "127.0.0.1"],
      ["http://0/", "0.0.0.0"],
      ["http://2852039166/", "169.254.169.254"],
      ["http://0xa9.0xfe.0xa9.0xfe/", "169.254.169.254"],
      ["http://012.0.0.1/", "10.0.0.1"],
    ];
    for (const [url, normalized] of cases) {
      assert.equal(new URL(url).hostname, normalized, url);
      rejectsWith(() => checkUrl(url), "blocked", url);
    }
  });

  it("blocks local host names", () => {
    for (const url of [
      "http://localhost/",
      "http://LocalHost./",
      "http://foo.localhost/",
      "http://nas.local/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://intranet/",
    ]) {
      rejectsWith(() => checkUrl(url), "blocked", url);
    }
  });
});

describe("checkRedirect", () => {
  const from = new URL("https://news.example.com/a/b?c=1");

  it("resolves a relative Location against the current URL", () => {
    assert.equal(checkRedirect(from, "/story").href, "https://news.example.com/story");
    assert.equal(checkRedirect(from, "c").href, "https://news.example.com/a/c");
    assert.equal(checkRedirect(from, "//cdn.example.org/x").href, "https://cdn.example.org/x");
  });

  it("allows a move from http to https and back", () => {
    assert.equal(checkRedirect(from, "http://example.org/").href, "http://example.org/");
  });

  it("applies every rule to the new URL", () => {
    rejectsWith(() => checkRedirect(from, "http://127.0.0.1/"), "blocked");
    rejectsWith(() => checkRedirect(from, "http://169.254.169.254/"), "blocked");
    rejectsWith(() => checkRedirect(from, "http://[::1]:80/"), "blocked");
    rejectsWith(() => checkRedirect(from, "http://2130706433/"), "blocked");
    rejectsWith(() => checkRedirect(from, "https://localhost/"), "blocked");
    rejectsWith(() => checkRedirect(from, "https://example.com:8080/"), "blocked");
    rejectsWith(() => checkRedirect(from, "https://u:p@example.com/"), "blocked");
    rejectsWith(() => checkRedirect(from, "file:///etc/passwd"), "invalid_url");
    rejectsWith(() => checkRedirect(from, "ftp://example.com/"), "invalid_url");
  });
});

describe("createGuardedLookup", () => {
  function fakeResolver(table: Record<string, ResolvedAddress[]>) {
    const calls: string[] = [];
    const resolver = async (hostname: string) => {
      calls.push(hostname);
      const found = table[hostname];
      if (!found) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return found;
    };
    return { resolver, calls };
  }

  function run(
    resolver: (h: string) => Promise<ResolvedAddress[]>,
    hostname: string,
    options: LookupOptions,
  ): Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }> {
    const lookup = createGuardedLookup(resolver);
    return new Promise((resolve) => {
      lookup(hostname, options, (error, address, family) =>
        resolve({ error, address, family }),
      );
    });
  }

  const PUBLIC4 = { address: "93.184.215.14", family: 4 };
  const PUBLIC6 = { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 };

  it("returns public addresses", async () => {
    const { resolver } = fakeResolver({ "example.com": [PUBLIC4, PUBLIC6] });
    const all = await run(resolver, "example.com", { all: true });
    assert.equal(all.error, null);
    assert.deepEqual(all.address, [PUBLIC4, PUBLIC6]);

    const one = await run(resolver, "example.com", {});
    assert.equal(one.address, PUBLIC4.address);
    assert.equal(one.family, 4);

    const v6 = await run(resolver, "example.com", { family: 6 });
    assert.equal(v6.address, PUBLIC6.address);
  });

  it("rejects when any address is private", async () => {
    const { resolver } = fakeResolver({
      "mixed.example.com": [PUBLIC4, { address: "10.0.0.5", family: 4 }],
      "rebind.example.com": [{ address: "127.0.0.1", family: 4 }],
      "meta.example.com": [{ address: "169.254.169.254", family: 4 }],
      "v6.example.com": [PUBLIC4, { address: "::1", family: 6 }],
      "mapped.example.com": [{ address: "::ffff:10.0.0.1", family: 6 }],
      "aws6.example.com": [{ address: "fd00:ec2::254", family: 6 }],
    });
    for (const host of [
      "mixed.example.com",
      "rebind.example.com",
      "meta.example.com",
      "v6.example.com",
      "mapped.example.com",
      "aws6.example.com",
    ]) {
      for (const options of [{ all: true }, {}, { family: 4 }]) {
        const result = await run(resolver, host, options);
        assert.ok(result.error instanceof FetchArticleError, host);
        assert.equal((result.error as FetchArticleError).kind, "blocked", host);
      }
    }
  });

  it("checks addresses of the family that wasn't asked for too", async () => {
    const { resolver } = fakeResolver({
      "split.example.com": [PUBLIC4, { address: "fd12::1", family: 6 }],
    });
    const result = await run(resolver, "split.example.com", { family: 4 });
    assert.equal((result.error as FetchArticleError).kind, "blocked");
  });

  it("passes DNS failures through", async () => {
    const { resolver } = fakeResolver({});
    const result = await run(resolver, "missing.example.com", { all: true });
    assert.equal(result.error?.code, "ENOTFOUND");
  });

  it("fails when no address matches the family", async () => {
    const { resolver } = fakeResolver({ "v4only.example.com": [PUBLIC4] });
    const result = await run(resolver, "v4only.example.com", { family: 6 });
    assert.equal((result.error as FetchArticleError).kind, "http_error");
  });
});
