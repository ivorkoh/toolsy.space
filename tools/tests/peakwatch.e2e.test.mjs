// Browser integration tests for tools/peakwatch.html (Playwright + node:test).
// Run: cd tools/tests && npm test   (see README in the PR notes / run steps)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { launch, openPage, ORIGIN, TOOLS_DIR, hostsOf } from "./helpers.mjs";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
const SEMI = ["AMD", "AVGO", "INTC", "QCOM", "TXN", "MU", "SNDK"];
const WL = ["ORCL", "DELL", "SKHY", "EWY", "ARM", "ASML", "KLAC", "LITE"];
const ALLOWED_HOSTS = new Set(["pw.test", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com", "api.twelvedata.com", "generativelanguage.googleapis.com"]);

const co = (t) => ({ pe: 30.1, fwdPe: 25.2, peg: "1.1", pb: "~5x", roic: "~20%", fcf: "$1B TTM", earningsGrowth: "LIVE-EG " + t, peHistory: "LIVE-PEH " + t, pullbackNote: "LIVE-PB " + t, outlookNote: "LIVE-OL " + t });
const grp = (tks) => ({ pullbackOverall: "LIVE pullback overall", outlookOverall: "LIVE outlook overall", companies: Object.fromEntries(tks.map((t) => [t, co(t)])) });
const gem = (obj, finishReason = "STOP") => ({ json: { candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }, finishReason,
  groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/a", title: "Example A" } }, { web: { uri: "javascript:alert(1)", title: "EVIL" } }] } }] } });
const quote = (url) => ({ json: { close: "90", percent_change: "-1.2", fifty_two_week: { high: "100" } } });

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

async function connectBoth(page) {
  await page.fill('input[placeholder="Paste your API key here"]', "td-test-key");
  await page.click('button:has-text("Connect")');
  await page.waitForSelector('input[placeholder="Paste your Gemini API key here"]');
  await page.fill('input[placeholder="Paste your Gemini API key here"]', "gm-test-key");
  await page.click('.keybox button:has-text("Connect")');
}
const state = (page) => page.evaluate(() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  return {
    cards: q(".mood-box").length,
    liveAsOf: q(".mood-asof").filter((e) => e.textContent.startsWith("Live research")).length,
    staleTags: q(".mood-tag").length,
    statuses: q(".mood-status").map((e) => e.textContent),
    sourceHrefs: q(".mood-sources a").map((a) => a.getAttribute("href")),
    liveNotes: q(".mood-note").filter((e) => e.textContent.startsWith("LIVE")).length,
    liveEgCells: q(".idx-table td").filter((td) => td.textContent.startsWith("LIVE-EG")).length,
    root: document.getElementById("root").textContent.length
  };
});

test("snapshot renders all 9 research cards before any key is connected, with no errors", async () => {
  const { page, errors } = await openPage(browser, { api: (u) => (u.includes("twelvedata") ? quote(u) : undefined) });
  await page.goto(ORIGIN + "/peakwatch.html");
  await page.fill('input[placeholder="Paste your API key here"]', "td");
  await page.click('button:has-text("Connect")');
  await page.waitForSelector(".research-cards");
  const s = await state(page);
  assert.equal(s.cards, 9);
  assert.equal(s.liveAsOf, 0);
  const text = await page.textContent(".research-cards");
  assert.match(text, /Dated snapshot researched September 21, 2026/);
  assert.deepEqual(errors.filter((e) => !/ERR_FAILED|net::/.test(e)), []);
  await page.close();
});

test("partial combined reply: only the missing table is retried; stale rows are tagged; unsafe links dropped", async () => {
  let calls = 0; const bodies = [];
  const { page, requests } = await openPage(browser, { api: (u, req) => {
    if (u.includes("twelvedata")) return quote(u);
    if (u.includes("generativelanguage")) {
      calls++; bodies.push({ url: u, headers: req.headers(), body: JSON.parse(req.postData()) });
      return calls === 1 ? gem({ asOf: "September 22, 2026", groups: { mag7: grp(MAG7), semi: grp(SEMI) } })
                         : gem({ asOf: "September 22, 2026", groups: { watchlist: grp(WL.slice(0, 6)) } });
    }
  } });
  await page.goto(ORIGIN + "/peakwatch.html");
  await connectBoth(page);
  await page.waitForFunction(() => document.querySelectorAll(".mood-asof").length === 9 && [...document.querySelectorAll(".mood-asof")].every((e) => e.textContent.startsWith("Live research")));
  await page.waitForFunction(() => document.querySelectorAll(".idx-status").length === 0); // all 25 quotes loaded
  const s = await state(page);
  assert.equal(calls, 2);
  assert.equal(s.staleTags, 2 * 3, "KLAC + LITE tagged on each of the 3 watchlist cards");
  assert.ok(s.sourceHrefs.length > 0 && s.sourceHrefs.every((h) => h.startsWith("https://")));
  assert.equal(s.liveEgCells, 20);
  assert.ok(s.statuses.some((t) => /follow-up call/.test(t)));
  // key travels in a header, never in the URL; thinking is capped
  assert.equal(bodies[0].headers["x-goog-api-key"], "gm-test-key");
  assert.ok(!bodies[0].url.includes("gm-test-key"));
  assert.deepEqual(bodies[0].body.generationConfig.thinkingConfig, { thinkingBudget: 2048 });
  for (const h of hostsOf(requests)) assert.ok(ALLOWED_HOSTS.has(h), "unexpected host " + h);
  await page.close();
});

test("truncated reply then 429: retries stop at the rate limit (3 calls, not 4)", async () => {
  let calls = 0;
  const { page } = await openPage(browser, { api: (u) => {
    if (u.includes("twelvedata")) return quote(u);
    if (u.includes("generativelanguage")) {
      calls++;
      if (calls === 1) return gem('{"groups":{"mag7":{"compan', "MAX_TOKENS");
      if (calls === 2) return gem({ groups: { mag7: grp(MAG7) } });
      return { status: 429, json: { error: { code: 429, message: "Resource exhausted", details: [{ retryDelay: "42s" }] } } };
    }
  } });
  await page.goto(ORIGIN + "/peakwatch.html");
  await connectBoth(page);
  await page.waitForFunction(() => [...document.querySelectorAll(".mood-status.error")].some((e) => /429/.test(e.textContent)));
  await page.waitForTimeout(300);
  const s = await state(page);
  assert.equal(calls, 3);
  assert.equal(s.liveAsOf, 3, "only the Mag 7 cards went live");
  assert.ok(s.statuses.some((t) => /retry in 42s/.test(t)));
  await page.close();
});

test("model not found: falls back to the fallback model once", async () => {
  const urls = [];
  const { page } = await openPage(browser, { api: (u) => {
    if (u.includes("twelvedata")) return quote(u);
    if (u.includes("generativelanguage")) {
      urls.push(u);
      return urls.length === 1 ? { status: 404, json: { error: { code: 404, message: "models/gemini-2.5-flash is not found" } } }
                               : gem({ groups: { mag7: grp(MAG7), semi: grp(SEMI), watchlist: grp(WL) } });
    }
  } });
  await page.goto(ORIGIN + "/peakwatch.html");
  await connectBoth(page);
  await page.waitForFunction(() => [...document.querySelectorAll(".mood-asof")].filter((e) => e.textContent.startsWith("Live research")).length === 9);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /gemini-3\.5-flash/);
  await page.close();
});

test("Twelve Data network failure: shows an error and makes NO proxy request", async () => {
  const { page, requests } = await openPage(browser, { api: (u) => (u.includes("twelvedata") ? "network-error" : undefined) });
  await page.goto(ORIGIN + "/peakwatch.html");
  await page.fill('input[placeholder="Paste your API key here"]', "td-secret");
  await page.click('button:has-text("Connect")');
  await page.waitForFunction(() => /never retries through a third-party proxy/.test(document.body.textContent));
  const withKey = requests.filter((u) => u.includes("td-secret"));
  assert.ok(withKey.length > 0);
  for (const u of withKey) assert.equal(new URL(u).host, "api.twelvedata.com", "key only sent to Twelve Data: " + u);
  assert.ok(!requests.some((u) => /allorigins|corsproxy/.test(u)));
  await page.close();
});

test("Content-Security-Policy blocks requests to any non-allowlisted host", async () => {
  const { page, requests } = await openPage(browser, {});
  await page.goto(ORIGIN + "/peakwatch.html");
  const result = await page.evaluate(async () => {
    try { await fetch("https://api.allorigins.win/raw?url=https%3A%2F%2Fapi.twelvedata.com%2Fquote%3Fapikey%3Dx"); return "allowed"; }
    catch (e) { return "blocked"; }
  });
  assert.equal(result, "blocked");
  assert.ok(!requests.some((u) => u.includes("allorigins")), "the browser never even sent it");
  await page.close();
});

test("works when opened straight from disk (file://) — CSP 'self' still allows the research module", async () => {
  const { page, errors } = await openPage(browser, {});
  await page.goto(pathToFileURL(path.join(TOOLS_DIR, "peakwatch.html")).href);
  await page.waitForSelector(".keybox");
  assert.equal(await page.evaluate(() => typeof window.PeakWatchResearch), "object");
  assert.deepEqual(errors.filter((e) => /Content Security Policy|pageerror/.test(e)), []);
  await page.close();
});

test("no horizontal scrolling at phone width", async () => {
  const { page } = await openPage(browser, { width: 390, api: (u) => (u.includes("twelvedata") ? quote(u) : undefined) });
  await page.goto(ORIGIN + "/peakwatch.html");
  await page.fill('input[placeholder="Paste your API key here"]', "td");
  await page.click('button:has-text("Connect")');
  await page.waitForSelector(".research-cards");
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await page.close();
});
