// Browser integration tests for the cache refresh (index.html + tools/cachebust.js + PeakWatch loader).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { launch, openPage, ORIGIN, SITE_ORIGIN, TOOLS_DIR } from "./helpers.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const TOOL_LINKS = ["free-parking-finder.html", "name-combiner.html", "peakwatch.html", "resalewatch.html?mode=hdb", "resalewatch.html?mode=private", "taleboard.html"];
const stampedHrefs = (page) => page.$$eval("a.space", (as) => as.map((a) => a.getAttribute("href")));

test("index: every tool link gets a ?v= stamp, and the helper itself is fetched fresh", async () => {
  const { page, requests, errors } = await openPage(browser, { fastTimers: false });
  await page.goto(SITE_ORIGIN + "/index.html");
  await page.waitForFunction(() => [...document.querySelectorAll("a.space")].every((a) => /[?&]v=[0-9a-z]+$/.test(a.getAttribute("href"))));
  const hrefs = await stampedHrefs(page);
  assert.equal(hrefs.length, TOOL_LINKS.length);
  hrefs.forEach((h, i) => {
    const base = "tools/" + TOOL_LINKS[i];
    assert.ok(h.startsWith(base + (base.includes("?") ? "&v=" : "?v=")), h);
  });
  assert.ok(requests.some((u) => /\/tools\/cachebust\.js\?v=[0-9a-z]+$/.test(u)));
  assert.deepEqual(errors.filter((e) => !/ERR_FAILED|net::/.test(e)), []);
  await page.close();
});

test("index: two visits produce different stamps", async () => {
  const { page } = await openPage(browser, { fastTimers: false });
  await page.goto(SITE_ORIGIN + "/index.html");
  await page.waitForFunction(() => /v=/.test(document.querySelector("a.space").getAttribute("href")));
  const first = (await stampedHrefs(page))[0];
  await page.waitForTimeout(5);
  await page.reload();
  await page.waitForFunction(() => /v=/.test(document.querySelector("a.space").getAttribute("href")));
  const second = (await stampedHrefs(page))[0];
  assert.notEqual(first, second);
  await page.close();
});

test("index → ResaleWatch keeps the mode parameter and opens the right tab", async () => {
  const { page, requests } = await openPage(browser, { fastTimers: false, api: (u) => (u.includes("data.gov.sg") ? { json: { success: true, result: { records: [], total: 0 } } } : undefined) });
  await page.goto(SITE_ORIGIN + "/index.html");
  await page.waitForFunction(() => /v=/.test(document.querySelector('a.space[href*="mode=private"]').getAttribute("href")));
  await page.click('a.space[href*="mode=private"]');
  await page.waitForSelector('input[placeholder="Paste your AccessKey here"]');
  assert.ok(requests.some((u) => /\/tools\/resalewatch\.html\?mode=private&v=[0-9a-z]+$/.test(u)));
  await page.close();
});

test("index → PeakWatch: page and research module are both requested with fresh stamps, app still renders", async () => {
  const { page, requests } = await openPage(browser, { api: (u) => (u.includes("twelvedata") ? { json: { close: "90", percent_change: "0", fifty_two_week: { high: "100" } } } : undefined) });
  await page.goto(SITE_ORIGIN + "/index.html");
  await page.waitForFunction(() => /v=/.test(document.querySelector('a.space[href*="peakwatch"]').getAttribute("href")));
  await page.click('a.space[href*="peakwatch"]');
  await page.fill('input[placeholder="Paste your API key here"]', "td");
  await page.click('button:has-text("Connect")');
  await page.waitForSelector(".research-cards");
  assert.equal(await page.$$eval(".mood-box", (e) => e.length), 9);
  assert.ok(requests.some((u) => /\/tools\/peakwatch\.html\?v=[0-9a-z]+$/.test(u)));
  assert.ok(requests.some((u) => /\/tools\/peakwatch\.research\.js\?v=[0-9a-z]+$/.test(u)));
  await page.close();
});

test("PeakWatch opened directly also loads a freshly stamped module", async () => {
  const { page, requests } = await openPage(browser, {});
  await page.goto(ORIGIN + "/peakwatch.html");
  await page.waitForSelector(".keybox");
  assert.ok(requests.some((u) => /\/peakwatch\.research\.js\?v=[0-9a-z]+$/.test(u)));
  assert.ok(!requests.some((u) => /\/peakwatch\.research\.js$/.test(u)), "never the un-stamped (cacheable) URL");
  await page.close();
});

test("PeakWatch shows a clear message if the research module can't load", async () => {
  const { page } = await openPage(browser, { api: (u) => (u.includes("peakwatch.research.js") ? "network-error" : undefined), block: ["peakwatch.research.js"] });
  await page.goto(ORIGIN + "/peakwatch.html");
  await page.waitForFunction(() => /couldn't load its research module/.test(document.getElementById("root").textContent));
  await page.close();
});

test("PeakWatch still works from disk (file://) with the stamped module", async () => {
  const { page, errors } = await openPage(browser, {});
  await page.goto(pathToFileURL(path.join(TOOLS_DIR, "peakwatch.html")).href);
  await page.waitForSelector(".keybox");
  assert.equal(await page.evaluate(() => typeof window.PeakWatchResearch), "object");
  assert.deepEqual(errors.filter((e) => /Content Security Policy|pageerror/.test(e)), []);
  await page.close();
});

test("a link clicked before the helper loads still works (just unstamped)", async () => {
  const { page } = await openPage(browser, { fastTimers: false, block: ["cachebust.js"] });
  await page.goto(SITE_ORIGIN + "/index.html");
  await page.click('a.space[href="tools/taleboard.html"]');
  await page.waitForURL(/\/tools\/taleboard\.html$/);
  await page.close();
});
