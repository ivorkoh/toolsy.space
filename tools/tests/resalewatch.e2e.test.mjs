// Browser integration tests for tools/resalewatch.html: no request may ever go to a proxy.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, openPage, ORIGIN } from "./helpers.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

test("data.gov.sg failure: clear error, no allorigins.win retry", async () => {
  const { page, requests } = await openPage(browser, { fastTimers: false, api: (u) => (u.includes("data.gov.sg") ? "network-error" : undefined) });
  await page.goto(ORIGIN + "/resalewatch.html");
  await page.waitForFunction(() => /no longer retries through a third-party proxy/.test(document.body.textContent));
  assert.ok(requests.some((u) => u.includes("data.gov.sg")));
  assert.ok(!requests.some((u) => /allorigins|corsproxy/.test(u)));
  await page.close();
});

test("URA failure: AccessKey header only ever sent to URA, never to corsproxy.io", async () => {
  const sent = [];
  const { page, requests } = await openPage(browser, { fastTimers: false, api: (u, req) => {
    if (u.includes("data.gov.sg")) return { json: { success: true, result: { records: [], total: 0 } } };
    if (u.includes("ura.gov.sg")) { sent.push({ host: new URL(u).host, key: req.headers()["accesskey"] }); return "network-error"; }
  } });
  await page.goto(ORIGIN + "/resalewatch.html");
  await page.click('button:has-text("Private")');
  await page.fill('input[placeholder="Paste your AccessKey here"]', "ura-secret");
  await page.click('button:has-text("Connect")');
  await page.waitForFunction(() => /doesn't route it through a third-party proxy/.test(document.body.textContent));
  assert.ok(sent.length >= 1);
  for (const s of sent) assert.equal(s.host, "eservice.ura.gov.sg");
  assert.ok(!requests.some((u) => /allorigins|corsproxy/.test(u)));
  await page.close();
});
