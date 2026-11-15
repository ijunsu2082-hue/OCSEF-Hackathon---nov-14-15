import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTerms, newsQuery, NEWS_MAX_ARTICLES, parseGdelt, parseGoogleNewsRss } from "../lib/live/news";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>Anaheim council approves $955M solar deal - Hey SoCal</title><link>https://news.google.com/rss/articles/AAA</link><pubDate>Thu, 12 Nov 2026 19:17:45 GMT</pubDate><source url="https://heysocal.com">Hey SoCal</source></item>
<item><title><![CDATA[SCE &amp; city crews restore power after outage - OC Register]]></title><link>https://news.google.com/rss/articles/BBB</link><pubDate>Sat, 14 Nov 2026 08:00:00 GMT</pubDate><source url="https://ocregister.com">OC Register</source></item>
<item><title>SCE &amp; city crews restore power after outage - Another Outlet</title><link>https://news.google.com/rss/articles/CCC</link><pubDate>Fri, 13 Nov 2026 08:00:00 GMT</pubDate><source url="https://x.com">Another Outlet</source></item>
<item><title>No link</title><link>javascript:alert(1)</link><pubDate>Fri, 13 Nov 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

test("Google News RSS: newest first, source suffix dropped, entities decoded, unsafe links removed", () => {
  const a = parseGoogleNewsRss(RSS);
  assert.deepEqual(a.map((x) => x.title), ["SCE & city crews restore power after outage", "Anaheim council approves $955M solar deal"]);
  assert.equal(a[0].source, "OC Register");
  assert.equal(a[0].publishedAt, "2026-11-14T08:00:00.000Z");
  assert.equal(a[1].url, "https://news.google.com/rss/articles/AAA");
});

test("GDELT artlist parses seendate and caps the list", () => {
  const arts = Array.from({ length: 30 }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `Story ${i}`,
    domain: "example.com",
    seendate: `202611${String(10 + (i % 5)).padStart(2, "0")}T120000Z`,
  }));
  const a = parseGdelt({ articles: arts });
  assert.equal(a.length, NEWS_MAX_ARTICLES);
  assert.equal(a[0].publishedAt, "2026-11-14T12:00:00.000Z");
  assert.deepEqual(parseGdelt({}), []);
});

test("search terms are cleaned and the query pairs places with grid topics", () => {
  assert.deepEqual(cleanTerms(["Anaheim", "anaheim", "Garden Grove", "x", "a\"; drop", "Fullerton"], 5), ["Anaheim", "Garden Grove", "Fullerton"]);
  assert.deepEqual(cleanTerms(["A1", "B2", "C3"], 2), ["A1", "B2"]);
  const q = newsQuery("Garden Grove", ["Anaheim Public Utilities"]);
  assert.match(q, /^"Garden Grove" \(/);
  assert.match(q, /"power outage"/);
  assert.match(q, /"Anaheim Public Utilities"\)$/);
});

test("relevance filter drops old, future and off-topic articles and hides snippets", async () => {
  const { relevant } = await import("../lib/live/news");
  const now = Date.parse("2026-11-15T18:00:00Z");
  const a = (title: string, iso: string | null, snippet = "") => ({ title, source: "S", url: `https://x/${title}`, publishedAt: iso, snippet });
  const out = relevant(
    [
      a("Anaheim outage hits 2,000 homes", "2026-11-14T10:00:00Z"),
      a("Crews restore power", "2026-11-13T10:00:00Z", "Southern California Edison said lines in Garden Grove..."),
      a("Cambridge substation breaks ground", "2026-11-12T10:00:00Z"),
      a("Anaheim Ducks score on the power play", "2026-11-14T10:00:00Z"),
      a("Power restored after Garden Grove Peninsula outage", "2026-11-14T10:00:00Z"),
      a("Southern California Edison crews fix Oregon substation", "2026-11-14T10:00:00Z"),
      a("Anaheim power lines to go underground", "2025-08-29T10:00:00Z"),
      a("Anaheim undated", null),
    ],
    ["Anaheim", "Garden Grove", "Southern California Edison"],
    now,
  );
  assert.deepEqual(out.map((x) => x.title), ["Anaheim outage hits 2,000 homes", "Crews restore power"]);
  assert.equal("snippet" in out[0], false);
});
