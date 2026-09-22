// Shared browser-test plumbing: serves the repo's tools/ folder from a fake origin, stubs the
// React CDN with the pinned npm copies, and records every network request so tests can assert
// that nothing ever goes to a host other than the one intended.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS_DIR = path.resolve(here, "..");
export const ORIGIN = "http://pw.test";
// react's package "exports" hide the UMD files from require.resolve, so read them by path.
const NODE_MODULES = path.join(here, "node_modules");
const REACT = fs.readFileSync(path.join(NODE_MODULES, "react/umd/react.production.min.js"), "utf8");
const REACT_DOM = fs.readFileSync(path.join(NODE_MODULES, "react-dom/umd/react-dom.production.min.js"), "utf8");

export async function launch() {
  // PW_CHROMIUM lets a sandbox point at a preinstalled browser; normally Playwright's own is used.
  return chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
}

/**
 * Opens a page with request recording and routing.
 * `api(url, request)` returns { status, json } for mocked API hosts, or undefined to abort.
 */
export async function openPage(browser, { width = 1300, fastTimers = true, api } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const requests = [];
  const errors = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  if (fastTimers) {
    // Twelve Data throttling waits 8.5s between symbols — shrink long timers so tests run fast.
    await page.addInitScript(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, ms >= 8000 ? 5 : ms, ...a); });
  }
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("file://")) return route.continue(); // opening the page straight from disk
    if (url.startsWith(ORIGIN + "/")) {
      const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
      const file = path.join(TOOLS_DIR, rel);
      if (!file.startsWith(TOOLS_DIR) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
      const type = file.endsWith(".js") ? "application/javascript" : "text/html";
      return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
    }
    if (url.includes("cdnjs.cloudflare.com") && url.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: REACT_DOM });
    if (url.includes("cdnjs.cloudflare.com") && url.includes("react.production")) return route.fulfill({ contentType: "application/javascript", body: REACT });
    if (api) {
      const r = await api(url, route.request());
      if (r === "network-error") return route.abort("failed");
      if (r) return route.fulfill({ status: r.status || 200, contentType: "application/json", body: typeof r.json === "string" ? r.json : JSON.stringify(r.json) });
    }
    return route.abort(); // fonts and anything unexpected
  });
  return { page, requests, errors };
}

export const hostsOf = (urls) => [...new Set(urls.map((u) => { try { return new URL(u).host; } catch { return u; } }))];
